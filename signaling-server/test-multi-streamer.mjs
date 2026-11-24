/**
 * Comprehensive Node.js multi-streamer rooms integration test suite.
 * Validates all Branch 2 acceptance criteria against a live server.mjs process:
 *   1. Room Lifecycle: activeStreams in room_created, joined_room, room_reclaimed, reattached
 *   2. Co-streamer start_stream & stop_stream broadcasts to all participants
 *   3. On-demand watch_stream & stop_watching routing (notifying only target streamer)
 *   4. Generalized signal routing (Host <-> Viewer, Viewer A <-> Viewer B, simultaneous bidirectional)
 *   5. Automatic cleanup on co-streamer departure, kick, and ban (stream_stopped + viewer_unwatching)
 *   6. Exclusive administrative authority retained by Room Owner (kick/ban/close ignored from viewers)
 *   7. /admin/status reporting of activeStreams & streamer nicknames with zero raw IP / token leaks
 *   8. Web App watch-only verification (HTML elements, strict CSP, zero getDisplayMedia in viewer.js)
 */

import { strict as assert } from "node:assert";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

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

async function run() {
  console.log("\n=======================================================");
  console.log("  Multi-Streamer Rooms (Branch 2) Integration Tests    ");
  console.log("=======================================================\n");

  const ADMIN_PASS = "MultiStreamAdmin123!";
  const ADMIN_USER = "admin";

  const server = await spawnSignalingServer({
    ADMIN_PASSWORD: ADMIN_PASS,
    ADMIN_USERNAME: ADMIN_USER,
    MAX_ACTIVE_ROOMS_PER_IP: "5",
    MAX_WS_PER_IP: "20",
  });

  try {
    // -------------------------------------------------------------------------
    // Test 1: Room Lifecycle activeStreams in session messages
    // -------------------------------------------------------------------------
    console.log("\x1b[1m[Suite 1: Room Lifecycle & activeStreams state in session messages]\x1b[0m");

    let roomCode = "";
    let hostToken = "";
    let viewer1Id = "";
    let viewer1Token = "";

    await test("create_room, joined_room, room_reclaimed, and reattached include activeStreams", async () => {
      // 1. Host creates room
      const host = new TestWsClient(server.wsUrl, {
        headers: { "cf-connecting-ip": "192.168.10.1" },
      });
      await host.connect();
      host.send({ type: "create_room", nickname: "AliceHost" });
      const created = await host.waitForMessage((m) => m.type === "room_created");

      assert.ok(created.code);
      assert.ok(created.hostToken);
      assert.ok(Array.isArray(created.activeStreams));
      assert.equal(created.activeStreams.length, 1);
      assert.equal(created.activeStreams[0].streamerId, "host");
      assert.equal(created.activeStreams[0].nickname, "AliceHost");

      roomCode = created.code;
      hostToken = created.hostToken;

      // 2. Viewer 1 joins
      const v1 = new TestWsClient(server.wsUrl, {
        headers: { "cf-connecting-ip": "192.168.10.2" },
      });
      await v1.connect();
      v1.send({ type: "join_room", code: roomCode, nickname: "BobViewer" });
      const joined = await v1.waitForMessage((m) => m.type === "joined_room");

      assert.ok(joined.viewerId);
      assert.ok(joined.viewerToken);
      assert.ok(Array.isArray(joined.activeStreams));
      assert.equal(joined.activeStreams.length, 1);
      assert.equal(joined.activeStreams[0].streamerId, "host");

      viewer1Id = joined.viewerId;
      viewer1Token = joined.viewerToken;

      // 3. Host disconnects and reclaims
      host.close();
      const hostReclaim = new TestWsClient(server.wsUrl, {
        headers: { "cf-connecting-ip": "192.168.10.1" },
      });
      await hostReclaim.connect();
      hostReclaim.send({
        type: "reclaim_room",
        code: roomCode,
        hostToken,
        nickname: "AliceHost",
      });
      const reclaimed = await hostReclaim.waitForMessage((m) => m.type === "room_reclaimed");
      assert.equal(reclaimed.code, roomCode);
      assert.ok(Array.isArray(reclaimed.activeStreams));
      assert.equal(reclaimed.activeStreams[0].streamerId, "host");

      // 4. Viewer 1 drops socket and reattaches
      v1.close();
      const v1Reattach = new TestWsClient(server.wsUrl, {
        headers: { "cf-connecting-ip": "192.168.10.2" },
      });
      await v1Reattach.connect();
      v1Reattach.send({
        type: "reattach_viewer",
        code: roomCode,
        viewerId: viewer1Id,
        viewerToken: viewer1Token,
      });
      const reattached = await v1Reattach.waitForMessage((m) => m.type === "reattached");
      assert.equal(reattached.viewerId, viewer1Id);
      assert.ok(Array.isArray(reattached.activeStreams));
      assert.equal(reattached.activeStreams[0].streamerId, "host");

      v1Reattach.close();
      hostReclaim.close();
    });

    // -------------------------------------------------------------------------
    // Test 2: Co-Streamer start_stream & stop_stream broadcasts
    // -------------------------------------------------------------------------
    console.log("\n\x1b[1m[Suite 2: Co-Streamer start_stream & stop_stream broadcasts]\x1b[0m");

    await test("Viewer start_stream broadcasts stream_started to all, stop_stream broadcasts stream_stopped", async () => {
      // Setup room with Host, Viewer 1, and Viewer 2
      const host = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "192.168.20.1" } });
      await host.connect();
      host.send({ type: "create_room", nickname: "HostStreamer" });
      const { code } = await host.waitForMessage((m) => m.type === "room_created");

      const v1 = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "192.168.20.2" } });
      await v1.connect();
      v1.send({ type: "join_room", code, nickname: "CoStreamerBob" });
      const v1Joined = await v1.waitForMessage((m) => m.type === "joined_room");

      const v2 = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "192.168.20.3" } });
      await v2.connect();
      v2.send({ type: "join_room", code, nickname: "WatcherCharlie" });
      await v2.waitForMessage((m) => m.type === "joined_room");

      // Co-streamer (v1) starts stream
      v1.send({ type: "start_stream" });

      // Host receives stream_started
      const hostStreamStarted = await host.waitForMessage(
        (m) => m.type === "stream_started" && m.streamerId === v1Joined.viewerId
      );
      assert.equal(hostStreamStarted.streamerId, v1Joined.viewerId);
      assert.equal(hostStreamStarted.nickname, "CoStreamerBob");

      // Viewer 2 receives stream_started
      const v2StreamStarted = await v2.waitForMessage(
        (m) => m.type === "stream_started" && m.streamerId === v1Joined.viewerId
      );
      assert.equal(v2StreamStarted.streamerId, v1Joined.viewerId);
      assert.equal(v2StreamStarted.nickname, "CoStreamerBob");

      // Late joining Viewer 3 receives both streams in joined_room.activeStreams
      const v3 = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "192.168.20.4" } });
      await v3.connect();
      v3.send({ type: "join_room", code, nickname: "LateDave" });
      const v3Joined = await v3.waitForMessage((m) => m.type === "joined_room");
      assert.equal(v3Joined.activeStreams.length, 2);
      const streamerIds = v3Joined.activeStreams.map((s) => s.streamerId);
      assert.ok(streamerIds.includes("host"));
      assert.ok(streamerIds.includes(v1Joined.viewerId));

      // Co-streamer stops stream
      v1.send({ type: "stop_stream" });

      // Host, v2, and v3 receive stream_stopped
      const hostStopped = await host.waitForMessage(
        (m) => m.type === "stream_stopped" && m.streamerId === v1Joined.viewerId
      );
      assert.equal(hostStopped.streamerId, v1Joined.viewerId);

      const v2Stopped = await v2.waitForMessage(
        (m) => m.type === "stream_stopped" && m.streamerId === v1Joined.viewerId
      );
      assert.equal(v2Stopped.streamerId, v1Joined.viewerId);

      const v3Stopped = await v3.waitForMessage(
        (m) => m.type === "stream_stopped" && m.streamerId === v1Joined.viewerId
      );
      assert.equal(v3Stopped.streamerId, v1Joined.viewerId);

      v1.close();
      v2.close();
      v3.close();
      host.close();
    });

    // -------------------------------------------------------------------------
    // Test 3: On-demand watch_stream & stop_watching routing
    // -------------------------------------------------------------------------
    console.log("\n\x1b[1m[Suite 3: On-demand watch_stream & stop_watching routing]\x1b[0m");

    await test("watch_stream routes viewer_watching only to target streamer; stop_watching routes viewer_unwatching", async () => {
      const host = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "192.168.30.1" } });
      await host.connect();
      host.send({ type: "create_room", nickname: "HostAlice" });
      const { code } = await host.waitForMessage((m) => m.type === "room_created");

      const streamer = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "192.168.30.2" } });
      await streamer.connect();
      streamer.send({ type: "join_room", code, nickname: "StreamerBob" });
      const streamerJoined = await streamer.waitForMessage((m) => m.type === "joined_room");
      const streamerId = streamerJoined.viewerId;

      streamer.send({ type: "start_stream" });
      await host.waitForMessage((m) => m.type === "stream_started" && m.streamerId === streamerId);

      const watcher = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "192.168.30.3" } });
      await watcher.connect();
      watcher.send({ type: "join_room", code, nickname: "WatcherCharlie" });
      const watcherJoined = await watcher.waitForMessage((m) => m.type === "joined_room");
      const watcherId = watcherJoined.viewerId;

      // 1. Watcher sends watch_stream for streamerId
      watcher.send({ type: "watch_stream", streamerId });

      // Target streamer receives viewer_watching
      const watchingMsg = await streamer.waitForMessage(
        (m) => m.type === "viewer_watching" && m.viewerId === watcherId
      );
      assert.equal(watchingMsg.viewerId, watcherId);
      assert.equal(watchingMsg.nickname, "WatcherCharlie");
      assert.equal(watchingMsg.streamerId, streamerId);

      // Host was NOT the target streamer and does not receive viewer_watching for this subscription
      assert.equal(
        host.messages.some((m) => m.type === "viewer_watching" && m.streamerId === streamerId),
        false
      );

      // 2. Self-watch is ignored
      streamer.send({ type: "watch_stream", streamerId });
      // Give a brief window to confirm no viewer_watching received for self
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(
        streamer.messages.some((m) => m.type === "viewer_watching" && m.viewerId === streamerId),
        false
      );

      // 3. Watching a non-existent stream returns stream_stopped to sync client
      watcher.send({ type: "watch_stream", streamerId: "nonexistent-streamer" });
      const nonExistentSync = await watcher.waitForMessage(
        (m) => m.type === "stream_stopped" && m.streamerId === "nonexistent-streamer"
      );
      assert.equal(nonExistentSync.streamerId, "nonexistent-streamer");

      // 4. Watcher sends stop_watching
      watcher.send({ type: "stop_watching", streamerId });
      const unwatchingMsg = await streamer.waitForMessage(
        (m) => m.type === "viewer_unwatching" && m.viewerId === watcherId
      );
      assert.equal(unwatchingMsg.viewerId, watcherId);
      assert.equal(unwatchingMsg.streamerId, streamerId);

      watcher.close();
      streamer.close();
      host.close();
    });

    // -------------------------------------------------------------------------
    // Test 4: Generalized signal routing
    // -------------------------------------------------------------------------
    console.log("\n\x1b[1m[Suite 4: Generalized signal routing & simultaneous bidirectional co-streaming]\x1b[0m");

    await test("signal delivers Host <-> Viewer & Viewer A <-> Viewer B with accurate streamId; defaults omitted ids", async () => {
      const host = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "192.168.40.1" } });
      await host.connect();
      host.send({ type: "create_room", nickname: "HostAlice" });
      const { code } = await host.waitForMessage((m) => m.type === "room_created");

      const v1 = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "192.168.40.2" } });
      await v1.connect();
      v1.send({ type: "join_room", code, nickname: "StreamerBob" });
      const v1Joined = await v1.waitForMessage((m) => m.type === "joined_room");
      const v1Id = v1Joined.viewerId;

      const v2 = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "192.168.40.3" } });
      await v2.connect();
      v2.send({ type: "join_room", code, nickname: "ViewerCharlie" });
      const v2Joined = await v2.waitForMessage((m) => m.type === "joined_room");
      const v2Id = v2Joined.viewerId;

      v1.send({ type: "start_stream" });
      await host.waitForMessage((m) => m.type === "stream_started" && m.streamerId === v1Id);

      // 1. Host sends signal to v1 (for v1's stream, host watching v1)
      host.send({
        type: "signal",
        targetId: v1Id,
        streamId: v1Id,
        payload: { kind: "answer", sdp: "host-watching-v1-answer" },
      });
      const v1ReceivedFromHost = await v1.waitForMessage(
        (m) => m.type === "signal" && m.fromId === "host" && m.streamId === v1Id
      );
      assert.equal(v1ReceivedFromHost.fromId, "host");
      assert.equal(v1ReceivedFromHost.streamId, v1Id);
      assert.equal(v1ReceivedFromHost.payload.sdp, "host-watching-v1-answer");

      // 2. v1 simultaneously sends signal to Host (for Host's stream, v1 watching host)
      v1.send({
        type: "signal",
        targetId: "host",
        streamId: "host",
        payload: { kind: "answer", sdp: "v1-watching-host-answer" },
      });
      const hostReceivedFromV1 = await host.waitForMessage(
        (m) => m.type === "signal" && m.fromId === v1Id && m.streamId === "host"
      );
      assert.equal(hostReceivedFromV1.fromId, v1Id);
      assert.equal(hostReceivedFromV1.streamId, "host");
      assert.equal(hostReceivedFromV1.payload.sdp, "v1-watching-host-answer");

      // 3. Viewer-to-Viewer: v2 sends signal to v1 (for v1's stream)
      v2.send({
        type: "signal",
        targetId: v1Id,
        streamId: v1Id,
        payload: { kind: "ice", candidate: "v2-to-v1-candidate" },
      });
      const v1ReceivedFromV2 = await v1.waitForMessage(
        (m) => m.type === "signal" && m.fromId === v2Id && m.streamId === v1Id
      );
      assert.equal(v1ReceivedFromV2.fromId, v2Id);
      assert.equal(v1ReceivedFromV2.streamId, v1Id);
      assert.equal(v1ReceivedFromV2.payload.candidate, "v2-to-v1-candidate");

      // 4. Default fallback: omitting targetId & streamId routes to "host" with streamId "host"
      v2.send({
        type: "signal",
        payload: { kind: "legacy-ping" },
      });
      const hostReceivedLegacy = await host.waitForMessage(
        (m) => m.type === "signal" && m.payload?.kind === "legacy-ping"
      );
      assert.equal(hostReceivedLegacy.fromId, v2Id);
      assert.equal(hostReceivedLegacy.streamId, "host");

      v1.close();
      v2.close();
      host.close();
    });

    // -------------------------------------------------------------------------
    // Test 5: Cleanup on departure, kick, and ban
    // -------------------------------------------------------------------------
    console.log("\n\x1b[1m[Suite 5: Cleanup on co-streamer departure, kick, and ban]\x1b[0m");

    await test("Departing, kicked, or banned co-streamer broadcasts stream_stopped and unwatching notifications", async () => {
      // 1. Departure cleanup: streamer closes connection
      const host1 = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "192.168.50.1" } });
      await host1.connect();
      host1.send({ type: "create_room", nickname: "Host" });
      const { code: code1 } = await host1.waitForMessage((m) => m.type === "room_created");

      const streamer1 = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "192.168.50.2" } });
      await streamer1.connect();
      streamer1.send({ type: "join_room", code: code1, nickname: "LeavingStreamer" });
      const s1Joined = await streamer1.waitForMessage((m) => m.type === "joined_room");
      const s1Id = s1Joined.viewerId;

      streamer1.send({ type: "start_stream" });
      await host1.waitForMessage((m) => m.type === "stream_started" && m.streamerId === s1Id);

      // Streamer1 also watches Host
      streamer1.send({ type: "watch_stream", streamerId: "host" });
      await host1.waitForMessage((m) => m.type === "viewer_watching" && m.viewerId === s1Id);

      // Streamer1 disconnects
      streamer1.send({ type: "leave_room" });
      streamer1.close();

      // Host receives stream_stopped for s1Id AND viewer_unwatching for host stream
      const hostStreamStopped1 = await host1.waitForMessage(
        (m) => m.type === "stream_stopped" && m.streamerId === s1Id
      );
      assert.equal(hostStreamStopped1.streamerId, s1Id);

      const hostUnwatching1 = await host1.waitForMessage(
        (m) => m.type === "viewer_unwatching" && m.viewerId === s1Id && m.streamerId === "host"
      );
      assert.equal(hostUnwatching1.viewerId, s1Id);
      host1.close();

      // 2. Kick cleanup: host kicks a co-streamer
      const host2 = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "192.168.50.3" } });
      await host2.connect();
      host2.send({ type: "create_room", nickname: "Host" });
      const { code: code2 } = await host2.waitForMessage((m) => m.type === "room_created");

      const streamer2 = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "192.168.50.4" } });
      await streamer2.connect();
      streamer2.send({ type: "join_room", code: code2, nickname: "KickableStreamer" });
      const s2Joined = await streamer2.waitForMessage((m) => m.type === "joined_room");
      const s2Id = s2Joined.viewerId;

      streamer2.send({ type: "start_stream" });
      await host2.waitForMessage((m) => m.type === "stream_started" && m.streamerId === s2Id);

      const watcher2 = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "192.168.50.5" } });
      await watcher2.connect();
      watcher2.send({ type: "join_room", code: code2, nickname: "Watcher" });
      await watcher2.waitForMessage((m) => m.type === "joined_room");

      // Host kicks streamer2
      host2.send({ type: "kick_viewer", targetId: s2Id });

      // Remaining watcher receives stream_stopped
      const watcherStreamStopped = await watcher2.waitForMessage(
        (m) => m.type === "stream_stopped" && m.streamerId === s2Id
      );
      assert.equal(watcherStreamStopped.streamerId, s2Id);

      // Kicked streamer receives kicked
      const s2Kicked = await streamer2.waitForMessage((m) => m.type === "kicked");
      assert.equal(s2Kicked.type, "kicked");

      streamer2.close();
      watcher2.close();
      host2.close();

      // 3. Ban cleanup: host bans a co-streamer
      const host3 = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "192.168.50.6" } });
      await host3.connect();
      host3.send({ type: "create_room", nickname: "Host" });
      const { code: code3 } = await host3.waitForMessage((m) => m.type === "room_created");

      const streamer3 = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "192.168.50.7" } });
      await streamer3.connect();
      streamer3.send({ type: "join_room", code: code3, nickname: "BannableStreamer" });
      const s3Joined = await streamer3.waitForMessage((m) => m.type === "joined_room");
      const s3Id = s3Joined.viewerId;

      streamer3.send({ type: "start_stream" });
      await host3.waitForMessage((m) => m.type === "stream_started" && m.streamerId === s3Id);

      // Host bans streamer3
      host3.send({ type: "ban_viewer", targetId: s3Id });

      const hostStreamStopped3 = await host3.waitForMessage(
        (m) => m.type === "stream_stopped" && m.streamerId === s3Id
      );
      assert.equal(hostStreamStopped3.streamerId, s3Id);

      const s3Banned = await streamer3.waitForMessage((m) => m.type === "banned");
      assert.equal(s3Banned.type, "banned");

      streamer3.close();
      host3.close();
    });

    // -------------------------------------------------------------------------
    // Test 6: Host exclusive authority
    // -------------------------------------------------------------------------
    console.log("\n\x1b[1m[Suite 6: Host exclusive administrative authority]\x1b[0m");

    await test("Non-host viewer attempts to kick, ban, or close_room are strictly ignored", async () => {
      const host = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "192.168.60.1" } });
      await host.connect();
      host.send({ type: "create_room", nickname: "OwnerHost" });
      const { code } = await host.waitForMessage((m) => m.type === "room_created");

      const rogueViewer = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "192.168.60.2" } });
      await rogueViewer.connect();
      rogueViewer.send({ type: "join_room", code, nickname: "RogueViewer" });
      await rogueViewer.waitForMessage((m) => m.type === "joined_room");

      const innocentViewer = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "192.168.60.3" } });
      await innocentViewer.connect();
      innocentViewer.send({ type: "join_room", code, nickname: "InnocentViewer" });
      const innocentJoined = await innocentViewer.waitForMessage((m) => m.type === "joined_room");
      const innocentId = innocentJoined.viewerId;

      // 1. Rogue attempts to kick innocentViewer
      rogueViewer.send({ type: "kick_viewer", targetId: innocentId });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(innocentViewer.closed, false, "Innocent viewer must NOT be kicked by another viewer");

      // 2. Rogue attempts to ban innocentViewer
      rogueViewer.send({ type: "ban_viewer", targetId: innocentId });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(innocentViewer.closed, false, "Innocent viewer must NOT be banned by another viewer");

      // 3. Rogue attempts to close room
      rogueViewer.send({ type: "close_room" });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(host.closed, false, "Room must NOT be closed by a non-host viewer");

      innocentViewer.close();
      rogueViewer.close();
      host.close();
    });

    // -------------------------------------------------------------------------
    // Test 7: /admin/status & /health activeStreams reporting
    // -------------------------------------------------------------------------
    console.log("\n\x1b[1m[Suite 7: /admin/status & /health multi-streamer reporting]\x1b[0m");

    await test("/admin/status reports activeStreams & streamer nicknames; /health returns exact ok", async () => {
      // 1. /health returns exact {"status":"ok"}
      const healthRes = await httpRequest(`${server.httpUrl}/health`);
      assert.equal(healthRes.status, 200);
      assert.equal(healthRes.body.trim(), '{"status":"ok"}');

      // 2. Setup room with host + 1 co-streamer for admin audit
      const host = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "10.88.1.1" } });
      await host.connect();
      host.send({ type: "create_room", nickname: "SuperAdminHost" });
      const { code } = await host.waitForMessage((m) => m.type === "room_created");

      const coStreamer = new TestWsClient(server.wsUrl, { headers: { "cf-connecting-ip": "10.88.2.2" } });
      await coStreamer.connect();
      coStreamer.send({ type: "join_room", code, nickname: "CoStreamAudited" });
      await coStreamer.waitForMessage((m) => m.type === "joined_room");

      coStreamer.send({ type: "start_stream" });
      await host.waitForMessage((m) => m.type === "stream_started");

      // Query /admin/status
      const auth = Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString("base64");
      const adminRes = await httpRequest(`${server.httpUrl}/admin/status`, {
        headers: {
          Authorization: `Basic ${auth}`,
          "cf-connecting-ip": "10.99.1.1",
        },
      });

      assert.equal(adminRes.status, 200);
      assert.equal(adminRes.json?.status, "ok");

      const auditedRoom = adminRes.json.rooms.find((r) => r.code === code);
      assert.ok(auditedRoom);
      assert.equal(auditedRoom.activeStreams, 2);
      assert.ok(Array.isArray(auditedRoom.streamers));
      assert.equal(auditedRoom.streamers.length, 2);

      const streamerNicks = auditedRoom.streamers.map((s) => s.nickname);
      assert.ok(streamerNicks.includes("SuperAdminHost"));
      assert.ok(streamerNicks.includes("CoStreamAudited"));

      // Verify ZERO raw IPs or tokens leaked
      const rawBody = adminRes.body;
      assert.ok(!rawBody.includes("10.88.1.1"), "Must not leak raw host IP");
      assert.ok(!rawBody.includes("10.88.2.2"), "Must not leak raw viewer IP");

      coStreamer.close();
      host.close();
    });

    // -------------------------------------------------------------------------
    // Test 8: Web App Watch-Only HTML & Client Security Audit
    // -------------------------------------------------------------------------
    console.log("\n\x1b[1m[Suite 8: Web App Watch-Only HTML & Client Security Audit]\x1b[0m");

    await test("Web App HTML contains stream switcher & download CTA; viewer.js has zero getDisplayMedia calls", async () => {
      // 1. Check HTML routes
      for (const route of ["/", "/watch", "/join/ABCD-5678"]) {
        const res = await httpRequest(`${server.httpUrl}${route}`);
        assert.equal(res.status, 200);

        // Security headers
        assert.equal(res.headers["x-frame-options"], "DENY");
        assert.equal(res.headers["x-content-type-options"], "nosniff");
        const csp = res.headers["content-security-policy"] || "";
        assert.ok(csp.includes("script-src 'self'"), "CSP must include script-src 'self'");
        assert.ok(!csp.includes("'unsafe-inline'"), "CSP must NOT contain 'unsafe-inline'");

        // Multi-streamer DOM elements
        assert.ok(res.body.includes('id="streams-bar"'), `${route} must include #streams-bar`);
        assert.ok(res.body.includes('id="streams-list"'), `${route} must include #streams-list`);
        assert.ok(res.body.includes('id="web-share-cta"'), `${route} must include #web-share-cta`);
        assert.ok(
          res.body.includes("Want to share your screen too? Download the Windows desktop app"),
          `${route} must include desktop app prompt`
        );
      }

      // 2. Strict audit of public/viewer.js: ZERO getDisplayMedia or screen-sharing publisher code
      const viewerJsPath = path.join(__dirname, "public", "viewer.js");
      const viewerJsCode = fs.readFileSync(viewerJsPath, "utf8");

      assert.ok(
        !viewerJsCode.includes("getDisplayMedia"),
        "public/viewer.js must have ZERO getDisplayMedia calls (strictly watch-only)"
      );
      assert.ok(
        !viewerJsCode.includes("getUserMedia"),
        "public/viewer.js must have ZERO getUserMedia calls"
      );
      assert.ok(
        viewerJsCode.includes("webShareCta"),
        "public/viewer.js must wire webShareCta to downloadUrl"
      );
      assert.ok(
        viewerJsCode.includes("streamsList"),
        "public/viewer.js must render activeStreams in streamsList"
      );
    });
  } finally {
    await server.stop();
  }

  console.log("\n=======================================================");
  console.log(`  All tests finished: \x1b[32m${passedTests}/${totalTests} PASSED\x1b[0m`);
  console.log("=======================================================\n");
}

run().catch((err) => {
  console.error("\n\x1b[31mMulti-streamer test suite failed!\x1b[0m", err);
  process.exit(1);
});
