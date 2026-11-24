/**
 * Comprehensive Node.js security & privacy test suite for screen-share signaling server.
 * Validates all Branch 1 acceptance criteria:
 *   1. Unit tests for extractClientIp (spoof resistance & priority)
 *   2. Unit tests for maskIp (LGPD-compliant IPv4 and IPv6 masking)
 *   3. Unit tests for RateLimiter (reclaim & admin auth brute-force protections)
 *   4. Integration tests against live server:
 *      - Unconfigured /admin/status (HTTP 503)
 *      - Minimal /health (exact {"status":"ok"})
 *      - HTTP security headers on all routes & strict CSP without 'unsafe-inline'
 *      - CSP-safe <script id="join-context" type="application/json"> parsing
 *      - WebSocket Origin validation & 403 Forbidden without burning WS rate-limit slots
 *      - Kick vs. Ban enforcement (rejoin allowed vs banned from join & reattach)
 *      - Secret viewerToken verification on reattach_viewer
 *      - reclaim_room rate limiting (room creation caps & RECLAIM_DENIED -> RATE_LIMITED)
 *      - /admin/status Basic Auth, brute-force rate limit (429), and zero-raw-IP / zero-token leak
 */

import { strict as assert } from "node:assert";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { extractClientIp, maskIp, RateLimiter } from "./rate-limiter.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passedTests = 0;
let totalTests = 0;

async function test(name, fn) {
  totalTests++;
  process.stdout.write(`  ▶ ${name} ... `);
  try {
    await fn();
    passedTests++;
    process.stdout.write(`\x1b[32mPASS\x1b[0m\n`);
  } catch (err) {
    process.stdout.write(`\x1b[31mFAIL\x1b[0m\n`);
    console.error(`    Error: ${err.message}`);
    if (err.stack) {
      console.error(
        err.stack
          .split("\n")
          .slice(1, 4)
          .map((line) => `    ${line}`)
          .join("\n")
      );
    }
    throw err;
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function spawnSignalingServer(env = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      const port = await getFreePort();
      const serverPath = path.join(__dirname, "server.mjs");
      const proc = spawn(process.execPath, [serverPath], {
        env: {
          ...process.env,
          PORT: String(port),
          HOST: "127.0.0.1",
          ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let started = false;
      let stdoutBuf = "";
      let stderrBuf = "";

      proc.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString();
        if (!started && stdoutBuf.includes("signaling server listening on ws://")) {
          started = true;
          resolve({
            proc,
            port,
            httpUrl: `http://127.0.0.1:${port}`,
            wsUrl: `ws://127.0.0.1:${port}`,
            async stop() {
              return new Promise((res) => {
                if (proc.killed || proc.exitCode !== null) return res();
                proc.once("exit", () => res());
                try {
                  proc.kill();
                } catch {
                  res();
                }
              });
            },
          });
        }
      });

      proc.stderr.on("data", (chunk) => {
        stderrBuf += chunk.toString();
      });

      proc.on("error", (err) => {
        if (!started) reject(err);
      });

      proc.on("exit", (code) => {
        if (!started) {
          reject(new Error(`Server exited early with code ${code}. Stderr: ${stderrBuf}`));
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk.toString()));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            // Not JSON
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body,
            json,
          });
        });
      }
    );
    req.on("error", reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function testWsUpgrade(wsUrl, headers = {}) {
  return new Promise((resolve) => {
    const parsed = new URL(wsUrl);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: "/",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });

    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk.toString()));
      res.on("end", () => {
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });

    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: 101, headers: res.headers });
    });

    req.on("error", (err) => {
      resolve({ error: err.message });
    });

    req.end();
  });
}

class TestWsClient {
  constructor(wsUrl, options = {}) {
    this.wsUrl = wsUrl;
    this.options = options;
    this.ws = null;
    this.messages = [];
    this.waiters = [];
    this.closed = false;
    this.closeCode = null;
    this.closeReason = "";
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl, this.options);
      this.ws.on("open", () => resolve());
      this.ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString("utf8"));
          this.messages.push(msg);
          for (let i = 0; i < this.waiters.length; i++) {
            const { predicate, resolveWaiter } = this.waiters[i];
            if (predicate(msg)) {
              this.waiters.splice(i, 1);
              resolveWaiter(msg);
              break;
            }
          }
        } catch (e) {
          console.error("TestWsClient json parse error", e);
        }
      });
      this.ws.on("close", (code, reason) => {
        this.closed = true;
        this.closeCode = code;
        this.closeReason = reason ? reason.toString("utf8") : "";
      });
      this.ws.on("error", (err) => {
        if (!this.ws || this.ws.readyState === WebSocket.CONNECTING) {
          reject(err);
        }
      });
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  async waitForMessage(predicate, timeoutMs = 4000) {
    const idx = this.messages.findIndex(predicate);
    if (idx !== -1) {
      return this.messages.splice(idx, 1)[0];
    }
    return new Promise((resolveWaiter, rejectWaiter) => {
      const timer = setTimeout(() => {
        const waitingIdx = this.waiters.findIndex((w) => w.resolveWaiter === resolveWaiter);
        if (waitingIdx !== -1) this.waiters.splice(waitingIdx, 1);
        rejectWaiter(new Error(`Timeout (${timeoutMs}ms) waiting for WS message`));
      }, timeoutMs);

      this.waiters.push({
        predicate,
        resolveWaiter: (msg) => {
          clearTimeout(timer);
          resolveWaiter(msg);
        },
      });
    });
  }

  async waitForClose(timeoutMs = 4000) {
    if (this.closed) {
      return { code: this.closeCode, reason: this.closeReason };
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for WS close`));
      }, timeoutMs);
      this.ws.once("close", (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason ? reason.toString("utf8") : "" });
      });
    });
  }

  close() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      try {
        this.ws.close();
      } catch {
        // Ignore
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main test runner
// ---------------------------------------------------------------------------
async function run() {
  console.log("\n=======================================================");
  console.log("  Screen-Share Security & Privacy Hardening Test Suite  ");
  console.log("=======================================================\n");

  console.log("\x1b[1m[Suite 1: Unit Tests — extractClientIp]\x1b[0m");

  await test("extractClientIp respects priority cf-connecting-ip > true-client-ip > x-forwarded-for > socket", () => {
    // 1. cf-connecting-ip wins over all
    const req1 = {
      headers: {
        "cf-connecting-ip": "198.51.100.1",
        "true-client-ip": "198.51.100.2",
        "x-forwarded-for": "198.51.100.3",
      },
      socket: { remoteAddress: "198.51.100.4" },
    };
    assert.equal(extractClientIp(req1), "198.51.100.1");

    // 2. true-client-ip wins over x-forwarded-for and socket
    const req2 = {
      headers: {
        "true-client-ip": "198.51.100.2",
        "x-forwarded-for": "198.51.100.3, 10.0.0.1",
      },
      socket: { remoteAddress: "198.51.100.4" },
    };
    assert.equal(extractClientIp(req2), "198.51.100.2");

    // 3. x-forwarded-for leftmost entry wins over socket
    const req3 = {
      headers: {
        "x-forwarded-for": "  203.0.113.19 , 10.0.0.1",
      },
      socket: { remoteAddress: "127.0.0.1" },
    };
    assert.equal(extractClientIp(req3), "203.0.113.19");

    // 4. socket.remoteAddress fallback
    const req4 = {
      headers: {},
      socket: { remoteAddress: "192.168.1.50" },
    };
    assert.equal(extractClientIp(req4), "192.168.1.50");

    // 5. Strips ::ffff: prefix from all sources
    const req5 = {
      headers: { "x-forwarded-for": "::ffff:192.168.1.50" },
    };
    assert.equal(extractClientIp(req5), "192.168.1.50");

    const req6 = {
      socket: { remoteAddress: "::ffff:10.0.0.2" },
    };
    assert.equal(extractClientIp(req6), "10.0.0.2");

    // 6. Header array support
    const req7 = {
      headers: { "x-forwarded-for": [" 198.51.100.99, 10.0.0.1 ", "127.0.0.1"] },
    };
    assert.equal(extractClientIp(req7), "198.51.100.99");

    // 7. Port and bracket stripping on IPv4 and IPv6
    assert.equal(
      extractClientIp({ headers: { "x-forwarded-for": "192.168.1.100:54321" } }),
      "192.168.1.100"
    );
    assert.equal(
      extractClientIp({ headers: { "x-forwarded-for": "[2001:db8:1234::5]:443" } }),
      "2001:db8:1234::5"
    );
    assert.equal(
      extractClientIp({ headers: { "x-forwarded-for": "[2001:db8:1234::5]" } }),
      "2001:db8:1234::5"
    );
    assert.equal(
      extractClientIp({ headers: { "x-forwarded-for": "::ffff:c0a8:0101" } }),
      "::ffff:c0a8:0101"
    );
    assert.equal(
      extractClientIp({ headers: { "x-forwarded-for": "::ffff:192.168.1.100:8080" } }),
      "192.168.1.100"
    );

    // 8. Fallback to unknown when empty
    assert.equal(extractClientIp({}), "unknown");
    assert.equal(extractClientIp(null), "unknown");
  });

  console.log("\n\x1b[1m[Suite 2: Unit Tests — maskIp]\x1b[0m");

  await test("maskIp correctly anonymizes IPv4, IPv6 compressed/full, and handles edge cases", () => {
    // IPv4 standard
    assert.equal(maskIp("192.168.1.100"), "192.168.xxx.xxx");
    assert.equal(maskIp("10.0.0.1"), "10.0.xxx.xxx");
    assert.equal(maskIp("::ffff:172.16.0.5"), "172.16.xxx.xxx");

    // IPv6 compressed
    assert.equal(maskIp("2001:db8:1234::5"), "2001:db8::xxxx");
    assert.equal(maskIp("::1"), "0:0::xxxx");
    assert.equal(maskIp("fe80::1"), "fe80:0::xxxx");

    // IPv6 full (8 hextets)
    assert.equal(maskIp("2001:0db8:85a3:0000:0000:8a2e:0370:7334"), "2001:0db8::xxxx");

    // IPv6 with zone index
    assert.equal(maskIp("fe80::1%eth0"), "fe80:0::xxxx");

    // Regression: IPv4 with port and IPv6 with brackets/port
    assert.equal(maskIp("192.168.1.100:54321"), "192.168.xxx.xxx");
    assert.equal(maskIp("[2001:db8:1234::5]:443"), "2001:db8::xxxx");
    assert.equal(maskIp("[2001:db8:1234::5]"), "2001:db8::xxxx");

    // Regression: RFC 4291 hex-form IPv4-mapped IPv6 address (must not leak hex octets)
    assert.equal(maskIp("::ffff:c0a8:0101"), "0:0::xxxx");

    // Regression: Non-IP strings containing colons (must return unknown, not leak colon parts)
    assert.equal(maskIp("not:an:ip"), "unknown");
    assert.equal(maskIp("foo:bar"), "unknown");
    assert.equal(maskIp("foo:bar:baz"), "unknown");

    // Unknown or invalid inputs
    assert.equal(maskIp("unknown"), "unknown");
    assert.equal(maskIp(""), "unknown");
    assert.equal(maskIp(null), "unknown");
    assert.equal(maskIp(12345), "unknown");
  });

  console.log("\n\x1b[1m[Suite 3: Unit Tests — RateLimiter]\x1b[0m");

  await test("RateLimiter checkReclaimAllowed and recordFailedReclaim enforce limit and sweep properly", () => {
    const limiter = new RateLimiter({
      maxFailedReclaims: 3,
      failedReclaimWindowMs: 1000,
      failedReclaimBlockMs: 2000,
    });

    const ip = "192.0.2.1";
    let now = 10000;

    // Initially allowed
    assert.equal(limiter.checkReclaimAllowed(ip, now).allowed, true);

    // Record failures up to threshold
    limiter.recordFailedReclaim(ip, now);
    limiter.recordFailedReclaim(ip, now + 100);
    assert.equal(limiter.checkReclaimAllowed(ip, now + 200).allowed, true);

    // 3rd failure triggers block
    limiter.recordFailedReclaim(ip, now + 300);
    const blockedCheck = limiter.checkReclaimAllowed(ip, now + 400);
    assert.equal(blockedCheck.allowed, false);
    assert.equal(blockedCheck.code, "RATE_LIMITED");

    // Still blocked before block expiry
    assert.equal(limiter.checkReclaimAllowed(ip, now + 1500).allowed, false);

    // After block period expires
    assert.equal(limiter.checkReclaimAllowed(ip, now + 2500).allowed, true);

    // Sweep cleanup
    limiter.recordFailedReclaim(ip, now + 3000);
    limiter.recordFailedReclaim(ip, now + 3100);
    limiter.recordFailedReclaim(ip, now + 3200); // blocked until now + 3200 + 2000 = 15200
    limiter.sweep(now + 6000);
    assert.equal(limiter.reclaimBlockedUntil.has(ip), false);

    limiter.dispose();
  });

  await test("RateLimiter checkAdminAuthAllowed and recordFailedAdminAuth enforce brute-force block", () => {
    const limiter = new RateLimiter({
      maxAdminAuthFails: 2,
      adminAuthWindowMs: 1000,
      adminAuthBlockMs: 3000,
    });

    const ip = "198.51.100.5";
    let now = 20000;

    assert.equal(limiter.checkAdminAuthAllowed(ip, now).allowed, true);

    limiter.recordFailedAdminAuth(ip, now);
    assert.equal(limiter.checkAdminAuthAllowed(ip, now + 100).allowed, true);

    // 2nd failure triggers block
    limiter.recordFailedAdminAuth(ip, now + 200);
    const blocked = limiter.checkAdminAuthAllowed(ip, now + 300);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSec >= 1);

    // After block expires
    assert.equal(limiter.checkAdminAuthAllowed(ip, now + 3500).allowed, true);

    limiter.dispose();
  });

  console.log("\n\x1b[1m[Suite 4: Integration — Unconfigured /admin/status (HTTP 503)]\x1b[0m");

  const unconfiguredServer = await spawnSignalingServer({ ADMIN_PASSWORD: "" });
  try {
    await test("GET /admin/status returns 503 and security headers when ADMIN_PASSWORD is unset", async () => {
      const res = await httpRequest(`${unconfiguredServer.httpUrl}/admin/status`);
      assert.equal(res.status, 503);
      assert.equal(res.headers["cache-control"], "no-store");
      assert.equal(res.headers["x-frame-options"], "DENY");
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(res.headers["referrer-policy"], "no-referrer");
      assert.equal(res.json?.error, "Admin endpoint is not configured.");
    });
  } finally {
    await unconfiguredServer.stop();
  }

  console.log("\n\x1b[1m[Suite 5: Integration — Live Server Security Hardening]\x1b[0m");

  const ADMIN_PASS = "Super:Secret:Password:With:Colons:123!";
  const ADMIN_USER = "admin";
  const ALLOWED_ORIGIN = "https://app.screen-share.local";

  const liveServer = await spawnSignalingServer({
    ADMIN_PASSWORD: ADMIN_PASS,
    ADMIN_USERNAME: ADMIN_USER,
    ALLOWED_ORIGINS: `${ALLOWED_ORIGIN},https://other.example.com`,
    MAX_FAILED_RECLAIMS: "3",
    MAX_ADMIN_AUTH_FAILS: "3",
    MAX_ROOM_CREATES: "3",
    MAX_ACTIVE_ROOMS_PER_IP: "1",
    MAX_WS_PER_IP: "6",
  });

  try {
    await test("GET /health returns exact status:ok and base security headers without leaking details", async () => {
      const res = await httpRequest(`${liveServer.httpUrl}/health`);
      assert.equal(res.status, 200);
      assert.equal(res.body.trim(), '{"status":"ok"}');
      assert.equal(res.headers["cache-control"], "no-store");
      assert.equal(res.headers["x-frame-options"], "DENY");
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(res.headers["referrer-policy"], "no-referrer");
      assert.equal(res.json.rooms, undefined);
      assert.equal(res.json.version, undefined);
      assert.equal(res.json.maxViewers, undefined);
    });

    await test("All HTTP routes return base security headers and HTML routes enforce strict CSP", async () => {
      const testRoutes = ["/", "/watch", "/join/ABCD-1234", "/version", "/style.css", "/viewer.js", "/nonexistent"];

      for (const route of testRoutes) {
        const res = await httpRequest(`${liveServer.httpUrl}${route}`);
        assert.equal(res.headers["x-frame-options"], "DENY", `Route ${route} missing X-Frame-Options`);
        assert.equal(
          res.headers["x-content-type-options"],
          "nosniff",
          `Route ${route} missing X-Content-Type-Options`
        );
        assert.equal(
          res.headers["referrer-policy"],
          "no-referrer",
          `Route ${route} missing Referrer-Policy`
        );
      }

      // Check strict CSP on HTML routes
      for (const htmlRoute of ["/", "/watch", "/join/WXYZ-9876"]) {
        const res = await httpRequest(`${liveServer.httpUrl}${htmlRoute}`);
        const csp = res.headers["content-security-policy"] || "";
        assert.ok(csp.includes("default-src 'none'"), `${htmlRoute} missing default-src 'none'`);
        assert.ok(csp.includes("script-src 'self'"), `${htmlRoute} missing script-src 'self'`);
        assert.ok(!csp.includes("'unsafe-inline'"), `${htmlRoute} must NOT contain 'unsafe-inline'`);

        // Check <script id="join-context" type="application/json">
        assert.ok(
          res.body.includes('<script id="join-context" type="application/json">'),
          `${htmlRoute} missing non-executable join-context script tag`
        );
        assert.ok(
          !res.body.includes("window.__JOIN_CONTEXT__"),
          `${htmlRoute} must not use inline executable window.__JOIN_CONTEXT__`
        );

        // Extract and parse JSON
        const match = /<script id="join-context" type="application\/json">([\s\S]*?)<\/script>/.exec(
          res.body
        );
        assert.ok(match, "Found join-context tag");
        const parsed = JSON.parse(match[1]);
        if (htmlRoute.startsWith("/join/")) {
          assert.equal(parsed.code, "WXYZ-9876");
        }
      }
    });

    await test("WebSocket Origin validation allows authorized origins and returns 403 on disallowed", async () => {
      // 1. Allowed origins:
      const allowedOrigins = [
        undefined, // No Origin header
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "http://localhost:1420",
        `http://127.0.0.1:${liveServer.port}`,
        ALLOWED_ORIGIN,
      ];

      for (const origin of allowedOrigins) {
        const headers = origin ? { Origin: origin } : {};
        const res = await testWsUpgrade(liveServer.wsUrl, headers);
        assert.equal(res.status, 101, `Origin "${origin}" should be allowed (got ${res.status})`);
      }

      // 2. Disallowed origin returns 403 Forbidden
      const evilRes = await testWsUpgrade(liveServer.wsUrl, { Origin: "https://evil.example.org" });
      assert.equal(evilRes.status, 403, `Disallowed origin must return 403 (got ${evilRes.status})`);
      assert.ok(evilRes.body.includes("Forbidden origin."));

      // 3. Disallowed origin does NOT consume WS rate-limit slot
      const ip = "192.0.2.77";
      for (let i = 0; i < 8; i++) {
        const res = await testWsUpgrade(liveServer.wsUrl, {
          Origin: "https://attacker.com",
          "cf-connecting-ip": ip,
        });
        assert.equal(res.status, 403);
      }

      // Legitimate WS connection from that same IP succeeds immediately
      const legitClient = new TestWsClient(liveServer.wsUrl, {
        headers: { "cf-connecting-ip": ip },
      });
      await legitClient.connect();
      legitClient.send({ type: "ping" });
      const pong = await legitClient.waitForMessage((m) => m.type === "pong");
      assert.equal(pong.type, "pong");
      legitClient.close();
    });

    await test("Kick vs. Ban: kicked viewer CAN rejoin; banned viewer is rejected from join & reattach", async () => {
      const hostIp = "10.0.1.1";
      const viewer1Ip = "10.0.2.2";
      const viewer2Ip = "10.0.3.3";

      // 1. Host creates room
      const hostClient = new TestWsClient(liveServer.wsUrl, {
        headers: { "cf-connecting-ip": hostIp },
      });
      await hostClient.connect();
      hostClient.send({ type: "create_room", nickname: "StreamerHost" });
      const roomCreated = await hostClient.waitForMessage((m) => m.type === "room_created");
      const roomCode = roomCreated.code;
      const hostToken = roomCreated.hostToken;
      assert.ok(roomCode);
      assert.ok(hostToken);

      // 2. Viewer 1 joins
      const v1Client = new TestWsClient(liveServer.wsUrl, {
        headers: { "cf-connecting-ip": viewer1Ip },
      });
      await v1Client.connect();
      v1Client.send({ type: "join_room", code: roomCode, nickname: "KickMeUser" });
      const v1Joined = await v1Client.waitForMessage((m) => m.type === "joined_room");
      assert.ok(v1Joined.viewerId);
      assert.equal(v1Joined.viewerToken.length, 32);

      await hostClient.waitForMessage((m) => m.type === "viewer_joined" && m.viewerId === v1Joined.viewerId);

      // 3. Host kicks Viewer 1
      hostClient.send({ type: "kick_viewer", targetId: v1Joined.viewerId });
      const v1Kicked = await v1Client.waitForMessage((m) => m.type === "kicked");
      assert.equal(v1Kicked.type, "kicked");
      const v1Close = await v1Client.waitForClose();
      assert.equal(v1Close.code, 4001);

      const hostViewerLeftKick = await hostClient.waitForMessage(
        (m) => m.type === "viewer_left" && m.viewerId === v1Joined.viewerId
      );
      assert.equal(hostViewerLeftKick.kicked, true);
      assert.equal(hostViewerLeftKick.banned, undefined);

      // 4. Kicked viewer CAN rejoin from the same IP
      const v1Rejoin = new TestWsClient(liveServer.wsUrl, {
        headers: { "cf-connecting-ip": viewer1Ip },
      });
      await v1Rejoin.connect();
      v1Rejoin.send({ type: "join_room", code: roomCode, nickname: "KickedRejoined" });
      const v1Rejoined = await v1Rejoin.waitForMessage((m) => m.type === "joined_room");
      assert.equal(v1Rejoined.code, roomCode);
      v1Rejoin.close();

      // 5. Viewer 2 joins
      const v2Client = new TestWsClient(liveServer.wsUrl, {
        headers: { "cf-connecting-ip": viewer2Ip },
      });
      await v2Client.connect();
      v2Client.send({ type: "join_room", code: roomCode, nickname: "BanMeUser" });
      const v2Joined = await v2Client.waitForMessage((m) => m.type === "joined_room");
      const v2Id = v2Joined.viewerId;
      const v2Token = v2Joined.viewerToken;
      assert.ok(v2Id);
      assert.equal(v2Token.length, 32);

      await hostClient.waitForMessage((m) => m.type === "viewer_joined" && m.viewerId === v2Id);

      // 6. Host bans Viewer 2
      hostClient.send({ type: "ban_viewer", targetId: v2Id });
      const v2Banned = await v2Client.waitForMessage((m) => m.type === "banned");
      assert.equal(v2Banned.type, "banned");
      const v2Close = await v2Client.waitForClose();
      assert.equal(v2Close.code, 4002);

      const hostViewerLeftBan = await hostClient.waitForMessage(
        (m) => m.type === "viewer_left" && m.viewerId === v2Id
      );
      assert.equal(hostViewerLeftBan.kicked, true);
      assert.equal(hostViewerLeftBan.banned, true);

      // 7. Banned viewer cannot join_room
      const v2Rejoin = new TestWsClient(liveServer.wsUrl, {
        headers: { "cf-connecting-ip": viewer2Ip },
      });
      await v2Rejoin.connect();
      v2Rejoin.send({ type: "join_room", code: roomCode, nickname: "BanAttempt" });
      const banJoinErr = await v2Rejoin.waitForMessage((m) => m.type === "error");
      assert.equal(banJoinErr.code, "BANNED_FROM_ROOM");
      v2Rejoin.close();

      // 8. Banned viewer cannot reattach_viewer
      const v2Reattach = new TestWsClient(liveServer.wsUrl, {
        headers: { "cf-connecting-ip": viewer2Ip },
      });
      await v2Reattach.connect();
      v2Reattach.send({
        type: "reattach_viewer",
        code: roomCode,
        viewerId: v2Id,
        viewerToken: v2Token,
      });
      const banReattachErr = await v2Reattach.waitForMessage((m) => m.type === "error");
      assert.equal(banReattachErr.code, "BANNED_FROM_ROOM");
      const reattachClose = await v2Reattach.waitForClose();
      assert.equal(reattachClose.code, 4003);

      hostClient.close();
    });

    await test("Secret viewerToken on reattach_viewer: valid token succeeds, invalid/missing returns REATTACH_DENIED", async () => {
      const hostClient = new TestWsClient(liveServer.wsUrl, {
        headers: { "cf-connecting-ip": "10.1.1.1" },
      });
      await hostClient.connect();
      hostClient.send({ type: "create_room", nickname: "ReattachHost" });
      const { code } = await hostClient.waitForMessage((m) => m.type === "room_created");

      // Viewer connects
      const vClient = new TestWsClient(liveServer.wsUrl, {
        headers: { "cf-connecting-ip": "10.1.1.2" },
      });
      await vClient.connect();
      vClient.send({ type: "join_room", code, nickname: "TokenUser" });
      const joined = await vClient.waitForMessage((m) => m.type === "joined_room");
      const viewerId = joined.viewerId;
      const viewerToken = joined.viewerToken;
      assert.match(viewerToken, /^[0-9a-f]{32}$/i);

      // Close viewer socket abruptly without leaving (simulate drop)
      vClient.close();

      // 1. Reattach with valid viewerToken succeeds
      const goodReattach = new TestWsClient(liveServer.wsUrl, {
        headers: { "cf-connecting-ip": "10.1.1.2" },
      });
      await goodReattach.connect();
      goodReattach.send({
        type: "reattach_viewer",
        code,
        viewerId,
        viewerToken,
      });
      const reattached = await goodReattach.waitForMessage((m) => m.type === "reattached");
      assert.equal(reattached.viewerId, viewerId);

      // 2. Reattach with wrong token fails
      const badTokenClient = new TestWsClient(liveServer.wsUrl, {
        headers: { "cf-connecting-ip": "10.1.1.2" },
      });
      await badTokenClient.connect();
      badTokenClient.send({
        type: "reattach_viewer",
        code,
        viewerId,
        viewerToken: "00000000000000000000000000000000",
      });
      const badTokenErr = await badTokenClient.waitForMessage((m) => m.type === "error");
      assert.equal(badTokenErr.code, "REATTACH_DENIED");
      badTokenClient.close();

      // 3. Reattach with missing token fails
      const missingTokenClient = new TestWsClient(liveServer.wsUrl, {
        headers: { "cf-connecting-ip": "10.1.1.2" },
      });
      await missingTokenClient.connect();
      missingTokenClient.send({
        type: "reattach_viewer",
        code,
        viewerId,
      });
      const missingTokenErr = await missingTokenClient.waitForMessage((m) => m.type === "error");
      assert.equal(missingTokenErr.code, "REATTACH_DENIED");
      missingTokenClient.close();

      // 4. Reattach with nonexistent viewerId fails
      const unknownIdClient = new TestWsClient(liveServer.wsUrl, {
        headers: { "cf-connecting-ip": "10.1.1.2" },
      });
      await unknownIdClient.connect();
      unknownIdClient.send({
        type: "reattach_viewer",
        code,
        viewerId: "bad-id",
        viewerToken,
      });
      const unknownIdErr = await unknownIdClient.waitForMessage((m) => m.type === "error");
      assert.equal(unknownIdErr.code, "REATTACH_DENIED");
      unknownIdClient.close();

      goodReattach.close();
      hostClient.close();
    });

    await test("reclaim_room rate limiting: missing room enforces create limits, repeated bad hostToken triggers RATE_LIMITED", async () => {
      // 1. Missing room reclaim enforces maxActiveRoomsPerIp
      const hostIp1 = "10.2.1.1";
      const host1 = new TestWsClient(liveServer.wsUrl, {
        headers: { "cf-connecting-ip": hostIp1 },
      });
      await host1.connect();
      host1.send({ type: "create_room", nickname: "ActiveHost" });
      await host1.waitForMessage((m) => m.type === "room_created");

      // Attempt to reclaim a missing room from same IP when maxActiveRoomsPerIp = 1
      const reclaimMissing = new TestWsClient(liveServer.wsUrl, {
        headers: { "cf-connecting-ip": hostIp1 },
      });
      await reclaimMissing.connect();
      reclaimMissing.send({
        type: "reclaim_room",
        code: "NONE-1234",
        hostToken: "1234567890abcdef1234567890abcdef",
      });
      const missingErr = await reclaimMissing.waitForMessage((m) => m.type === "error");
      assert.equal(missingErr.code, "ROOM_LIMIT_REACHED");
      reclaimMissing.close();
      host1.close();

      // 2. Sliding window room creates enforcement (MAX_ROOM_CREATES = 3)
      const hostIp2 = "10.2.2.2";
      for (let i = 0; i < 3; i++) {
        const h = new TestWsClient(liveServer.wsUrl, {
          headers: { "cf-connecting-ip": hostIp2 },
        });
        await h.connect();
        h.send({ type: "create_room", nickname: `Room${i}` });
        await h.waitForMessage((m) => m.type === "room_created");
        h.send({ type: "close_room" });
        h.close();
      }

      // Recreating a missing room from hostIp2 should now hit RATE_LIMITED
      const reclaimExhausted = new TestWsClient(liveServer.wsUrl, {
        headers: { "cf-connecting-ip": hostIp2 },
      });
      await reclaimExhausted.connect();
      reclaimExhausted.send({
        type: "reclaim_room",
        code: "NONE-5678",
        hostToken: "1234567890abcdef1234567890abcdef",
      });
      const exhaustedErr = await reclaimExhausted.waitForMessage((m) => m.type === "error");
      assert.equal(exhaustedErr.code, "RATE_LIMITED");
      reclaimExhausted.close();

      // 3. Repeated bad hostToken on existing room (MAX_FAILED_RECLAIMS = 3)
      const targetHost = new TestWsClient(liveServer.wsUrl, {
        headers: { "cf-connecting-ip": "10.3.3.1" },
      });
      await targetHost.connect();
      targetHost.send({ type: "create_room", nickname: "TargetRoom" });
      const targetCreated = await targetHost.waitForMessage((m) => m.type === "room_created");
      const targetCode = targetCreated.code;

      const attackerIp = "10.3.3.99";
      for (let i = 0; i < 3; i++) {
        const att = new TestWsClient(liveServer.wsUrl, {
          headers: { "cf-connecting-ip": attackerIp },
        });
        await att.connect();
        att.send({
          type: "reclaim_room",
          code: targetCode,
          hostToken: "badtoken12345678901234567890",
        });
        const err = await att.waitForMessage((m) => m.type === "error");
        assert.equal(err.code, "RECLAIM_DENIED");
        att.close();
      }

      // 4th attempt from attackerIp hits RATE_LIMITED
      const blockedAtt = new TestWsClient(liveServer.wsUrl, {
        headers: { "cf-connecting-ip": attackerIp },
      });
      await blockedAtt.connect();
      blockedAtt.send({
        type: "reclaim_room",
        code: targetCode,
        hostToken: "badtoken12345678901234567890",
      });
      const rateLimitedErr = await blockedAtt.waitForMessage((m) => m.type === "error");
      assert.equal(rateLimitedErr.code, "RATE_LIMITED");
      blockedAtt.close();

      targetHost.close();
    });

    await test("/admin/status enforces Basic Auth, brute force limit (429), and returns masked IPs with zero token leak", async () => {
      // 1. Missing Authorization header returns 401 with WWW-Authenticate
      const resNoAuth = await httpRequest(`${liveServer.httpUrl}/admin/status`);
      assert.equal(resNoAuth.status, 401);
      assert.equal(resNoAuth.headers["www-authenticate"], 'Basic realm="screen-share admin"');
      assert.equal(resNoAuth.headers["cache-control"], "no-store");
      assert.equal(resNoAuth.headers["x-frame-options"], "DENY");

      // 2. Bad credentials trigger 401 and increment brute-force counter
      const bruteIp = "10.4.4.10";
      for (let i = 0; i < 3; i++) {
        const badAuth = Buffer.from(`${ADMIN_USER}:wrongpass${i}`).toString("base64");
        const resBad = await httpRequest(`${liveServer.httpUrl}/admin/status`, {
          headers: {
            Authorization: `Basic ${badAuth}`,
            "cf-connecting-ip": bruteIp,
          },
        });
        assert.equal(resBad.status, 401);
        assert.equal(resBad.json?.error, "Invalid credentials.");
      }

      // 4th bad attempt from bruteIp is blocked with 429 Too Many Requests
      const resBlocked = await httpRequest(`${liveServer.httpUrl}/admin/status`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${ADMIN_USER}:wrongpass4`).toString("base64")}`,
          "cf-connecting-ip": bruteIp,
        },
      });
      assert.equal(resBlocked.status, 429);
      assert.ok(resBlocked.headers["retry-after"]);
      assert.equal(resBlocked.json?.error, "Too many failed admin authentication attempts.");

      // 3. Valid Basic Auth from clean IP returns 200 with masked data
      // First, create a room with a viewer so /admin/status has live room data to audit
      const rawHostIp = "10.50.100.200";
      const rawViewerIp = "10.60.200.250";

      const hostWs = new TestWsClient(liveServer.wsUrl, {
        headers: { "cf-connecting-ip": rawHostIp },
      });
      await hostWs.connect();
      hostWs.send({ type: "create_room", nickname: "AdminAuditedHost" });
      const { code, hostToken } = await hostWs.waitForMessage((m) => m.type === "room_created");

      const viewerWs = new TestWsClient(liveServer.wsUrl, {
        headers: { "cf-connecting-ip": rawViewerIp },
      });
      await viewerWs.connect();
      viewerWs.send({ type: "join_room", code, nickname: "AdminAuditedViewer" });
      const { viewerToken } = await viewerWs.waitForMessage((m) => m.type === "joined_room");

      // Regression: Truncated password at first colon must fail
      const truncatedAuth = Buffer.from(`${ADMIN_USER}:Super`).toString("base64");
      const resTruncated = await httpRequest(`${liveServer.httpUrl}/admin/status`, {
        headers: {
          Authorization: `Basic ${truncatedAuth}`,
          "cf-connecting-ip": "10.99.99.98",
        },
      });
      assert.equal(resTruncated.status, 401);
      assert.equal(resTruncated.json?.error, "Invalid credentials.");

      // Query /admin/status with valid credentials containing multiple colons
      const goodAuth = Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString("base64");
      const resGood = await httpRequest(`${liveServer.httpUrl}/admin/status`, {
        headers: {
          Authorization: `Basic ${goodAuth}`,
          "cf-connecting-ip": "10.99.99.99",
        },
      });

      assert.equal(resGood.status, 200);
      assert.equal(resGood.json?.status, "ok");
      assert.ok(typeof resGood.json?.uptimeSec === "number");
      assert.ok(resGood.json?.activeRoomCount >= 1);
      assert.ok(Array.isArray(resGood.json?.rooms));

      const auditedRoom = resGood.json.rooms.find((r) => r.code === code);
      assert.ok(auditedRoom, "Audited room should be present in /admin/status");
      assert.equal(auditedRoom.host.nickname, "AdminAuditedHost");
      assert.equal(auditedRoom.host.maskedIp, "10.50.xxx.xxx"); // Masked!
      assert.equal(auditedRoom.viewerCount, 1);
      assert.equal(auditedRoom.viewers[0].nickname, "AdminAuditedViewer");
      assert.equal(auditedRoom.viewers[0].maskedIp, "10.60.xxx.xxx"); // Masked!

      // CRITICAL SECURITY AUDIT: Verify raw IPs and secret tokens are NOT anywhere in the response body!
      const rawBody = resGood.body;
      assert.ok(
        !rawBody.includes(rawHostIp),
        `Raw host IP (${rawHostIp}) must NOT be present in /admin/status output`
      );
      assert.ok(
        !rawBody.includes(rawViewerIp),
        `Raw viewer IP (${rawViewerIp}) must NOT be present in /admin/status output`
      );
      assert.ok(
        !rawBody.includes(hostToken),
        `Host secret token must NOT be present in /admin/status output`
      );
      assert.ok(
        !rawBody.includes(viewerToken),
        `Viewer secret token must NOT be present in /admin/status output`
      );

      viewerWs.close();
      hostWs.close();
    });
  } finally {
    await liveServer.stop();
  }

  console.log("\n=======================================================");
  console.log(`  All tests finished: \x1b[32m${passedTests}/${totalTests} PASSED\x1b[0m`);
  console.log("=======================================================\n");
}

run().catch((err) => {
  console.error("\n\x1b[31mTest suite failed!\x1b[0m", err);
  process.exit(1);
});
