import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { RateLimiter, extractClientIp, maskIp } from "./rate-limiter.mjs";

const SERVER_STARTED_AT = Date.now();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const WEB_INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
const WEB_STYLE_CSS = fs.readFileSync(path.join(PUBLIC_DIR, "style.css"), "utf8");
const WEB_VIEWER_JS = fs.readFileSync(path.join(PUBLIC_DIR, "viewer.js"), "utf8");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_VIEWERS = 5;
const HOST_GRACE_MS = 60_000;
const VIEWER_GRACE_MS = 30_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const MAX_NICKNAME_LEN = 24;
const MAX_WS_PAYLOAD_BYTES = 64 * 1024; // 64 KB
const LATEST_APP_VERSION = (process.env.LATEST_APP_VERSION || "2.2.0").trim();
const APP_DOWNLOAD_URL = (
  process.env.APP_DOWNLOAD_URL || "https://github.com/Jonsen22/screen-share/releases/latest"
).trim();
const APP_RELEASE_NOTES = (process.env.APP_RELEASE_NOTES || "").trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || "").trim();
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "").trim();
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, "").toLowerCase())
    .filter(Boolean)
);

const BASE_SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const HTML_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; media-src 'self' blob: mediastream:; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const limiter = new RateLimiter({
  maxActiveRoomsPerIp: process.env.MAX_ACTIVE_ROOMS_PER_IP,
  maxGlobalRooms: process.env.MAX_GLOBAL_ROOMS,
  maxRoomCreates: process.env.MAX_ROOM_CREATES,
  roomCreateWindowMs: process.env.ROOM_CREATE_WINDOW_MS,
  roomCreateBlockMs: process.env.ROOM_CREATE_BLOCK_MS,
  maxFailedJoins: process.env.MAX_FAILED_JOINS,
  failedJoinWindowMs: process.env.FAILED_JOIN_WINDOW_MS,
  failedJoinBlockMs: process.env.FAILED_JOIN_BLOCK_MS,
  maxFailedReclaims: process.env.MAX_FAILED_RECLAIMS,
  failedReclaimWindowMs: process.env.FAILED_RECLAIM_WINDOW_MS,
  failedReclaimBlockMs: process.env.FAILED_RECLAIM_BLOCK_MS,
  maxAdminAuthFails: process.env.MAX_ADMIN_AUTH_FAILS,
  adminAuthWindowMs: process.env.ADMIN_AUTH_WINDOW_MS,
  adminAuthBlockMs: process.env.ADMIN_AUTH_BLOCK_MS,
  maxWsPerIp: process.env.MAX_WS_PER_IP,
  maxWsMessages: process.env.MAX_WS_MESSAGES,
  wsMessageWindowMs: process.env.WS_MESSAGE_WINDOW_MS,
  maxHttpRequests: process.env.MAX_HTTP_REQUESTS,
  httpWindowMs: process.env.HTTP_WINDOW_MS,
});

/**
 * @typedef {{
 *   host: WebSocket | null,
 *   hostIp: string,
 *   hostToken: string,
 *   hostNickname: string,
 *   hostGraceTimer: NodeJS.Timeout | null,
 *   viewers: Map<string, { ws: WebSocket, nickname: string, ip: string, viewerToken: string }>,
 *   viewerGraceTimers: Map<string, NodeJS.Timeout>,
 *   bannedIps: Set<string>,
 *   activeStreams: Map<string, { streamerId: string, nickname: string }>,
 *   watchersByStreamer: Map<string, Set<string>>,
 *   createdAt: number
 * }} Room
 */

/** @type {Map<string, Room>} */
const rooms = new Map();

function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const hashA = crypto.createHash("sha256").update(a, "utf8").digest();
  const hashB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function isAllowedWsOrigin(req) {
  const rawOrigin = req?.headers?.origin;
  if (!rawOrigin || typeof rawOrigin !== "string" || !rawOrigin.trim()) {
    return true;
  }

  const normalized = rawOrigin.trim().replace(/\/+$/, "").toLowerCase();
  let url;
  try {
    url = new URL(normalized);
  } catch {
    return false;
  }

  if (ALLOWED_ORIGINS.has(normalized)) {
    return true;
  }
  if (
    normalized === "tauri://localhost" ||
    normalized === "http://tauri.localhost" ||
    normalized === "https://tauri.localhost"
  ) {
    return true;
  }
  if (
    (url.protocol === "http:" || url.protocol === "https:") &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  ) {
    return true;
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    const reqHost = String(req?.headers?.host || "").trim().toLowerCase();
    if (reqHost && url.host.toLowerCase() === reqHost) {
      return true;
    }
  }
  return false;
}

function sanitizeNickname(input, fallback) {
  if (typeof input !== "string") return fallback;
  const cleaned = input
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NICKNAME_LEN);
  return cleaned || fallback;
}

function generateRoomCode() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const bytes = crypto.randomBytes(8);
    let raw = "";
    for (let i = 0; i < 8; i++) {
      raw += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    if (!rooms.has(code)) return code;
  }
  throw new Error("Failed to allocate unique room code");
}

function normalizeCode(input) {
  if (typeof input !== "string") return "";
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== 8) return input.trim().toUpperCase();
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}

function isValidNormalizedCode(code) {
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);
}

function sendJson(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function getParticipantId(ws) {
  const meta = ws?._meta;
  if (!meta) return null;
  if (meta.role === "host") return "host";
  if (meta.role === "viewer" && meta.viewerId) return meta.viewerId;
  return null;
}

function getParticipantWs(room, participantId) {
  if (!room || !participantId) return null;
  if (participantId === "host") return room.host;
  return room.viewers.get(participantId)?.ws || null;
}

function listActiveStreams(room) {
  return Array.from(room.activeStreams.values());
}

function broadcastRoom(room, payload, excludeId = null) {
  if (room.host && excludeId !== "host") {
    sendJson(room.host, payload);
  }
  for (const [viewerId, viewer] of room.viewers.entries()) {
    if (viewerId !== excludeId) {
      sendJson(viewer.ws, payload);
    }
  }
}

function stopStreamerInRoom(room, code, streamerId) {
  if (!room.activeStreams.has(streamerId)) return;
  room.activeStreams.delete(streamerId);
  room.watchersByStreamer.delete(streamerId);
  broadcastRoom(room, { type: "stream_stopped", streamerId });
  console.log(`[room ${code}] stream stopped by ${streamerId}`);
}

function cleanupParticipantStreams(room, code, participantId) {
  stopStreamerInRoom(room, code, participantId);
  for (const [streamerId, watchers] of room.watchersByStreamer.entries()) {
    if (watchers.delete(participantId)) {
      const streamerWs = getParticipantWs(room, streamerId);
      sendJson(streamerWs, {
        type: "viewer_unwatching",
        viewerId: participantId,
        streamerId,
      });
    }
  }
}

function destroyRoom(code, notifyViewers, reason) {
  const room = rooms.get(code);
  if (!room) return;

  if (room.hostGraceTimer) {
    clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = null;
  }
  for (const timer of room.viewerGraceTimers.values()) {
    clearTimeout(timer);
  }
  room.viewerGraceTimers.clear();
  room.activeStreams.clear();
  room.watchersByStreamer.clear();

  if (room.host) {
    room.host._meta = null;
    room.host = null;
  }

  for (const viewer of room.viewers.values()) {
    viewer.ws._meta = null;
    if (notifyViewers) {
      sendJson(viewer.ws, {
        type: "room_closed",
        reason: reason || "Host ended the stream.",
      });
    }
  }
  room.viewers.clear();
  rooms.delete(code);
}

function cleanupClient(ws, explicit = false) {
  const meta = ws._meta;
  if (!meta) return;
  ws._meta = null;

  const room = rooms.get(meta.code);
  if (!room) return;

  if (meta.role === "host") {
    if (room.host !== ws) return;
    if (explicit) {
      destroyRoom(meta.code, true, "Host ended the stream.");
      console.log(`[room ${meta.code}] closed (host ended stream)`);
      return;
    }

    // Unexpected host socket drop: keep room alive during grace period so host
    // can reclaim it without disrupting live P2P viewers.
    room.host = null;
    if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = setTimeout(() => {
      const current = rooms.get(meta.code);
      if (current && current.host === null) {
        destroyRoom(meta.code, false, "");
        console.log(`[room ${meta.code}] expired after host grace timeout`);
      }
    }, HOST_GRACE_MS);
    console.log(
      `[room ${meta.code}] host socket dropped; waiting ${HOST_GRACE_MS / 1000}s for reclaim`
    );
  } else if (meta.role === "viewer") {
    const existing = room.viewers.get(meta.viewerId);
    if (!existing || existing.ws !== ws) return;

    if (explicit) {
      const pending = room.viewerGraceTimers.get(meta.viewerId);
      if (pending) {
        clearTimeout(pending);
        room.viewerGraceTimers.delete(meta.viewerId);
      }
      room.viewers.delete(meta.viewerId);
      cleanupParticipantStreams(room, meta.code, meta.viewerId);
      sendJson(room.host, {
        type: "viewer_left",
        viewerId: meta.viewerId,
        nickname: existing.nickname,
        viewerCount: room.viewers.size,
        explicit: true,
      });
      console.log(
        `[room ${meta.code}] viewer ${meta.viewerId} (${existing.nickname}) left (${room.viewers.size}/${MAX_VIEWERS})`
      );
      return;
    }

    const existingTimer = room.viewerGraceTimers.get(meta.viewerId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      const r = rooms.get(meta.code);
      if (!r) return;
      r.viewerGraceTimers.delete(meta.viewerId);
      const current = r.viewers.get(meta.viewerId);
      if (current && current.ws === ws) {
        r.viewers.delete(meta.viewerId);
        cleanupParticipantStreams(r, meta.code, meta.viewerId);
        sendJson(r.host, {
          type: "viewer_left",
          viewerId: meta.viewerId,
          nickname: current.nickname,
          viewerCount: r.viewers.size,
          explicit: false,
        });
        console.log(
          `[room ${meta.code}] viewer ${meta.viewerId} (${current.nickname}) timed out (${r.viewers.size}/${MAX_VIEWERS})`
        );
      }
    }, VIEWER_GRACE_MS);
    room.viewerGraceTimers.set(meta.viewerId, timer);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderWebViewerPage(code, room) {
  const isLive = Boolean(code && room && room.host);
  const hostNickname = isLive ? room.hostNickname || "Host" : null;
  const safeCode = code ? escapeHtml(code) : "";
  const safeHost = hostNickname ? escapeHtml(hostNickname) : "";

  const ogTitle = code
    ? safeHost
      ? `${safeHost} is live on screen-share (${safeCode})`
      : `Join screen-share room ${safeCode}`
    : "screen-share — Watch Stream";
  const ogDesc = code
    ? `Watch directly in your browser (P2P WebRTC) — Room code: ${safeCode}`
    : "Lightweight P2P WebRTC screen sharing. Watch streams directly in your browser.";

  const ogMeta = [
    `<meta property="og:title" content="${ogTitle}" />`,
    `<meta property="og:description" content="${ogDesc}" />`,
  ].join("\n    ");

  const joinContext = {
    code: code || null,
    isLive,
    hostNickname,
    downloadUrl: APP_DOWNLOAD_URL,
  };
  const safeJson = JSON.stringify(joinContext).replace(/</g, "\\u003c");
  const contextScript = `<script id="join-context" type="application/json">${safeJson}</script>`;

  return WEB_INDEX_HTML.replace("<!--OG_META-->", ogMeta).replace(
    "<!--JOIN_CONTEXT-->",
    contextScript
  );
}

const server = http.createServer((req, res) => {
  const ip = extractClientIp(req);
  const httpCheck = limiter.checkHttpRequest(ip);
  if (!httpCheck.allowed) {
    res.writeHead(429, {
      ...BASE_SECURITY_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": String(httpCheck.retryAfterSec),
    });
    res.end("Too many requests. Please slow down.\n");
    return;
  }

  const reqPath = (req.url || "/").split("?")[0];
  if (reqPath === "/health") {
    res.writeHead(200, {
      ...BASE_SECURITY_HEADERS,
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (reqPath === "/version") {
    res.writeHead(200, {
      ...BASE_SECURITY_HEADERS,
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        latestVersion: LATEST_APP_VERSION,
        downloadUrl: APP_DOWNLOAD_URL,
        releaseNotes: APP_RELEASE_NOTES,
      })
    );
    return;
  }
  if (reqPath === "/admin/status") {
    if (!ADMIN_PASSWORD) {
      res.writeHead(503, {
        ...BASE_SECURITY_HEADERS,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ error: "Admin endpoint is not configured." }));
      return;
    }

    const authRateCheck = limiter.checkAdminAuthAllowed(ip);
    if (!authRateCheck.allowed) {
      res.writeHead(429, {
        ...BASE_SECURITY_HEADERS,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Retry-After": String(authRateCheck.retryAfterSec),
      });
      res.end(JSON.stringify({ error: "Too many failed admin authentication attempts." }));
      return;
    }

    const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    if (!authHeader.trim()) {
      res.writeHead(401, {
        ...BASE_SECURITY_HEADERS,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="screen-share admin"',
      });
      res.end(JSON.stringify({ error: "Authentication required." }));
      return;
    }

    let validAuth = false;
    const match = /^Basic\s+(.+)$/i.exec(authHeader.trim());
    if (match) {
      const decoded = Buffer.from(match[1], "base64").toString("utf8");
      const sepIdx = decoded.indexOf(":");
      if (sepIdx >= 0) {
        const providedUser = decoded.slice(0, sepIdx);
        const providedPass = decoded.slice(sepIdx + 1);
        const passOk = timingSafeEqualStr(providedPass, ADMIN_PASSWORD);
        const userOk = ADMIN_USERNAME ? timingSafeEqualStr(providedUser, ADMIN_USERNAME) : true;
        validAuth = passOk && userOk;
      }
    }

    if (!validAuth) {
      limiter.recordFailedAdminAuth(ip);
      res.writeHead(401, {
        ...BASE_SECURITY_HEADERS,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="screen-share admin"',
      });
      res.end(JSON.stringify({ error: "Invalid credentials." }));
      return;
    }

    const now = Date.now();
    const roomSummaries = [];
    for (const [code, room] of rooms.entries()) {
      const viewerSummaries = [];
      for (const [viewerId, v] of room.viewers.entries()) {
        viewerSummaries.push({
          viewerId,
          nickname: v.nickname,
          maskedIp: maskIp(v.ip),
        });
      }
      roomSummaries.push({
        code,
        uptimeSec: Math.max(0, Math.floor((now - room.createdAt) / 1000)),
        host: {
          nickname: room.hostNickname,
          connected: Boolean(room.host),
          maskedIp: maskIp(room.hostIp),
        },
        viewerCount: room.viewers.size,
        viewers: viewerSummaries,
        activeStreams: room.activeStreams.size,
        streamers: listActiveStreams(room),
        bannedIpCount: room.bannedIps.size,
      });
    }

    res.writeHead(200, {
      ...BASE_SECURITY_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        status: "ok",
        uptimeSec: Math.max(0, Math.floor((now - SERVER_STARTED_AT) / 1000)),
        startedAt: new Date(SERVER_STARTED_AT).toISOString(),
        activeRoomCount: rooms.size,
        maxGlobalRooms: limiter.maxGlobalRooms,
        rooms: roomSummaries,
      })
    );
    return;
  }
  if (reqPath === "/style.css") {
    res.writeHead(200, {
      ...BASE_SECURITY_HEADERS,
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    });
    res.end(WEB_STYLE_CSS);
    return;
  }
  if (reqPath === "/viewer.js") {
    res.writeHead(200, {
      ...BASE_SECURITY_HEADERS,
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    });
    res.end(WEB_VIEWER_JS);
    return;
  }
  if (reqPath === "/" || reqPath === "/watch") {
    res.writeHead(200, {
      ...BASE_SECURITY_HEADERS,
      "Content-Security-Policy": HTML_CSP,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(renderWebViewerPage(null, null));
    return;
  }
  if (reqPath.startsWith("/join/")) {
    let rawCode = "";
    try {
      rawCode = decodeURIComponent(reqPath.slice("/join/".length));
    } catch {
      res.writeHead(400, {
        ...BASE_SECURITY_HEADERS,
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("Invalid room code.\n");
      return;
    }
    const code = normalizeCode(rawCode);
    if (!isValidNormalizedCode(code)) {
      res.writeHead(400, {
        ...BASE_SECURITY_HEADERS,
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("Invalid room code.\n");
      return;
    }
    const room = rooms.get(code) || null;
    res.writeHead(200, {
      ...BASE_SECURITY_HEADERS,
      "Content-Security-Policy": HTML_CSP,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(renderWebViewerPage(code, room));
    return;
  }
  res.writeHead(404, {
    ...BASE_SECURITY_HEADERS,
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end("Not found\n");
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_WS_PAYLOAD_BYTES,
});

server.on("upgrade", (req, socket, head) => {
  if (!isAllowedWsOrigin(req)) {
    socket.write(
      "HTTP/1.1 403 Forbidden\r\n" +
        "Content-Type: text/plain\r\n" +
        "Connection: close\r\n\r\n" +
        "Forbidden origin.\r\n"
    );
    socket.destroy();
    return;
  }

  const ip = extractClientIp(req);
  if (!limiter.tryAcquireWs(ip)) {
    socket.write(
      "HTTP/1.1 429 Too Many Requests\r\n" +
        "Content-Type: text/plain\r\n" +
        "Connection: close\r\n\r\n" +
        "Too many concurrent connections from your network.\r\n"
    );
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws._clientIp = ip;
    ws._ipReleased = false;
    wss.emit("connection", ws, req);
  });
});

function releaseClientIp(ws) {
  if (!ws._ipReleased && ws._clientIp) {
    ws._ipReleased = true;
    limiter.releaseWs(ws._clientIp);
  }
}

wss.on("connection", (ws) => {
  ws._isAlive = true;
  ws._meta = null;

  ws.on("pong", () => {
    ws._isAlive = true;
  });

  ws.on("message", (raw) => {
    ws._isAlive = true;
    if (!limiter.checkWsMessage(ws)) {
      sendJson(ws, {
        type: "error",
        code: "RATE_LIMITED",
        message: "Message rate limit exceeded. Disconnecting.",
      });
      try {
        ws.close(1008, "Rate limit exceeded");
      } catch {
        ws.terminate();
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      sendJson(ws, { type: "error", code: "BAD_JSON", message: "Invalid JSON payload." });
      return;
    }

    switch (msg.type) {
      case "ping": {
        sendJson(ws, { type: "pong" });
        break;
      }

      case "create_room": {
        const ip = ws._clientIp || "unknown";
        const check = limiter.checkCreateRoom(ip, rooms);
        if (!check.allowed) {
          sendJson(ws, {
            type: "error",
            code: check.code,
            message: check.message,
          });
          return;
        }

        cleanupClient(ws, true);
        const code = generateRoomCode();
        const hostToken = crypto.randomBytes(16).toString("hex");
        const hostNickname = sanitizeNickname(msg.nickname, "Host");
        const activeStreams = new Map();
        activeStreams.set("host", { streamerId: "host", nickname: hostNickname });
        const room = {
          host: ws,
          hostIp: ip,
          hostToken,
          hostNickname,
          hostGraceTimer: null,
          viewers: new Map(),
          viewerGraceTimers: new Map(),
          bannedIps: new Set(),
          activeStreams,
          watchersByStreamer: new Map(),
          createdAt: Date.now(),
        };
        rooms.set(code, room);
        ws._meta = { role: "host", code, nickname: hostNickname };
        sendJson(ws, {
          type: "room_created",
          code,
          hostToken,
          maxViewers: MAX_VIEWERS,
          activeStreams: listActiveStreams(room),
        });
        console.log(`[room ${code}] created by ${hostNickname}`);
        break;
      }

      case "reclaim_room": {
        const ip = ws._clientIp || "unknown";
        const reclaimCheck = limiter.checkReclaimAllowed(ip);
        if (!reclaimCheck.allowed) {
          sendJson(ws, {
            type: "error",
            code: reclaimCheck.code,
            message: reclaimCheck.message,
          });
          return;
        }

        const code = normalizeCode(msg.code);
        const hostToken = typeof msg.hostToken === "string" ? msg.hostToken : "";
        const hostNickname = sanitizeNickname(msg.nickname, "Host");
        if (!isValidNormalizedCode(code) || hostToken.length < 16) {
          limiter.recordFailedReclaim(ip);
          sendJson(ws, {
            type: "error",
            code: "INVALID_RECLAIM",
            message: "Invalid room reclaim credentials.",
          });
          return;
        }

        const existing = rooms.get(code);
        if (existing) {
          if (!timingSafeEqualStr(existing.hostToken, hostToken)) {
            limiter.recordFailedReclaim(ip);
            sendJson(ws, {
              type: "error",
              code: "RECLAIM_DENIED",
              message: "Room token mismatch.",
            });
            return;
          }
          if (existing.hostGraceTimer) {
            clearTimeout(existing.hostGraceTimer);
            existing.hostGraceTimer = null;
          }
          if (existing.host && existing.host !== ws) {
            existing.host._meta = null;
            try {
              existing.host.close();
            } catch {
              // Ignore
            }
          }
          existing.host = ws;
          existing.hostIp = ip;
          ws._meta = { role: "host", code, nickname: existing.hostNickname };
          sendJson(ws, {
            type: "room_reclaimed",
            code,
            maxViewers: MAX_VIEWERS,
            viewerCount: existing.viewers.size,
            activeStreams: listActiveStreams(existing),
          });
          console.log(`[room ${code}] reclaimed by ${existing.hostNickname}`);
        } else {
          // Server restarted while host was still streaming P2P; recreate room with same code.
          const createCheck = limiter.checkCreateRoom(ip, rooms);
          if (!createCheck.allowed) {
            sendJson(ws, {
              type: "error",
              code: createCheck.code,
              message: createCheck.message,
            });
            return;
          }
          const activeStreams = new Map();
          if (msg.isStreaming !== false) {
            activeStreams.set("host", { streamerId: "host", nickname: hostNickname });
          }
          const recreated = {
            host: ws,
            hostIp: ip,
            hostToken,
            hostNickname,
            hostGraceTimer: null,
            viewers: new Map(),
            viewerGraceTimers: new Map(),
            bannedIps: new Set(),
            activeStreams,
            watchersByStreamer: new Map(),
            createdAt: Date.now(),
          };
          rooms.set(code, recreated);
          ws._meta = { role: "host", code, nickname: hostNickname };
          sendJson(ws, {
            type: "room_reclaimed",
            code,
            maxViewers: MAX_VIEWERS,
            viewerCount: 0,
            activeStreams: listActiveStreams(recreated),
          });
          console.log(`[room ${code}] recreated by ${hostNickname} after restart`);
        }
        break;
      }

      case "close_room": {
        if (ws._meta?.role === "host") {
          cleanupClient(ws, true);
        }
        break;
      }

      case "kick_viewer": {
        const meta = ws._meta;
        if (!meta || meta.role !== "host") return;
        const room = rooms.get(meta.code);
        if (!room) return;
        const targetId = typeof msg.targetId === "string" ? msg.targetId : "";
        const target = room.viewers.get(targetId);
        if (!target) return;

        const pendingTimer = room.viewerGraceTimers.get(targetId);
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          room.viewerGraceTimers.delete(targetId);
        }

        room.viewers.delete(targetId);
        target.ws._meta = null;
        cleanupParticipantStreams(room, meta.code, targetId);
        sendJson(target.ws, {
          type: "kicked",
          reason: "You were removed from the room by the host.",
        });
        try {
          target.ws.close(4001, "Kicked by host");
        } catch {
          // Ignore close errors
        }
        sendJson(room.host, {
          type: "viewer_left",
          viewerId: targetId,
          nickname: target.nickname,
          viewerCount: room.viewers.size,
          kicked: true,
        });
        console.log(
          `[room ${meta.code}] viewer ${targetId} (${target.nickname}) kicked (${room.viewers.size}/${MAX_VIEWERS})`
        );
        break;
      }

      case "ban_viewer": {
        const meta = ws._meta;
        if (!meta || meta.role !== "host") return;
        const room = rooms.get(meta.code);
        if (!room) return;
        const targetId = typeof msg.targetId === "string" ? msg.targetId : "";
        const target = room.viewers.get(targetId);
        if (!target) return;

        const pendingTimer = room.viewerGraceTimers.get(targetId);
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          room.viewerGraceTimers.delete(targetId);
        }

        if (target.ip && target.ip !== "unknown") {
          room.bannedIps.add(target.ip);
        }
        room.viewers.delete(targetId);
        target.ws._meta = null;
        cleanupParticipantStreams(room, meta.code, targetId);
        sendJson(target.ws, {
          type: "banned",
          reason: "You were banned from this room by the host.",
        });
        try {
          target.ws.close(4002, "Banned by host");
        } catch {
          // Ignore close errors
        }
        sendJson(room.host, {
          type: "viewer_left",
          viewerId: targetId,
          nickname: target.nickname,
          viewerCount: room.viewers.size,
          kicked: true,
          banned: true,
        });
        console.log(
          `[room ${meta.code}] viewer ${targetId} (${target.nickname}) banned (${room.viewers.size}/${MAX_VIEWERS})`
        );
        break;
      }

      case "join_room": {
        const ip = ws._clientIp || "unknown";
        const joinCheck = limiter.checkJoinAllowed(ip);
        if (!joinCheck.allowed) {
          sendJson(ws, {
            type: "error",
            code: joinCheck.code,
            message: joinCheck.message,
          });
          return;
        }

        cleanupClient(ws, true);
        const code = normalizeCode(msg.code);
        const room = rooms.get(code);
        if (!room || !room.host) {
          limiter.recordFailedJoin(ip);
          sendJson(ws, {
            type: "error",
            code: "ROOM_NOT_FOUND",
            message: "Room code not found. Check the code and try again.",
          });
          return;
        }
        if (room.bannedIps.has(ip)) {
          sendJson(ws, {
            type: "error",
            code: "BANNED_FROM_ROOM",
            message: "You are banned from this room.",
          });
          return;
        }
        if (room.viewers.size >= MAX_VIEWERS) {
          sendJson(ws, {
            type: "error",
            code: "ROOM_FULL",
            message: `Room is full (${MAX_VIEWERS}/${MAX_VIEWERS} viewers).`,
          });
          return;
        }

        const viewerId = crypto.randomUUID().slice(0, 8);
        const viewerToken = crypto.randomBytes(16).toString("hex");
        const nickname = sanitizeNickname(msg.nickname, "Viewer");
        room.viewers.set(viewerId, { ws, nickname, ip, viewerToken });
        ws._meta = { role: "viewer", code, viewerId, nickname };

        sendJson(ws, {
          type: "joined_room",
          code,
          viewerId,
          viewerToken,
          hostNickname: room.hostNickname,
          viewerCount: room.viewers.size,
          maxViewers: MAX_VIEWERS,
          activeStreams: listActiveStreams(room),
        });
        sendJson(room.host, {
          type: "viewer_joined",
          viewerId,
          nickname,
          viewerCount: room.viewers.size,
        });
        console.log(
          `[room ${code}] viewer ${viewerId} (${nickname}) joined (${room.viewers.size}/${MAX_VIEWERS})`
        );
        break;
      }

      case "reattach_viewer": {
        const ip = ws._clientIp || "unknown";
        const code = normalizeCode(msg.code);
        const viewerId = typeof msg.viewerId === "string" ? msg.viewerId : "";
        const viewerToken = typeof msg.viewerToken === "string" ? msg.viewerToken : "";
        const room = rooms.get(code);
        if (!room || !viewerId) return;

        if (room.bannedIps.has(ip)) {
          sendJson(ws, {
            type: "error",
            code: "BANNED_FROM_ROOM",
            message: "You are banned from this room.",
          });
          try {
            ws.close(4003, "Banned from room");
          } catch {
            // Ignore close errors
          }
          return;
        }

        const existing = room.viewers.get(viewerId);
        if (!existing || !viewerToken || !timingSafeEqualStr(existing.viewerToken, viewerToken)) {
          sendJson(ws, {
            type: "error",
            code: "REATTACH_DENIED",
            message: "Invalid viewer session token.",
          });
          return;
        }

        const pending = room.viewerGraceTimers.get(viewerId);
        if (pending) {
          clearTimeout(pending);
          room.viewerGraceTimers.delete(viewerId);
        }

        if (existing.ws && existing.ws !== ws) {
          existing.ws._meta = null;
          try {
            existing.ws.close();
          } catch {
            // Ignore close errors
          }
        }

        room.viewers.set(viewerId, {
          ws,
          nickname: existing.nickname,
          ip,
          viewerToken: existing.viewerToken,
        });
        ws._meta = { role: "viewer", code, viewerId, nickname: existing.nickname };
        sendJson(ws, {
          type: "reattached",
          code,
          viewerId,
          activeStreams: listActiveStreams(room),
        });
        break;
      }

      case "start_stream": {
        const meta = ws._meta;
        if (!meta) return;
        const room = rooms.get(meta.code);
        if (!room) return;
        const streamerId = getParticipantId(ws);
        if (!streamerId) return;

        const alreadyActive = room.activeStreams.has(streamerId);
        room.activeStreams.set(streamerId, { streamerId, nickname: meta.nickname });
        if (!alreadyActive) {
          broadcastRoom(room, {
            type: "stream_started",
            streamerId,
            nickname: meta.nickname,
          });
          console.log(`[room ${meta.code}] stream started by ${streamerId} (${meta.nickname})`);
        }
        break;
      }

      case "stop_stream": {
        const meta = ws._meta;
        if (!meta) return;
        const room = rooms.get(meta.code);
        if (!room) return;
        const streamerId = getParticipantId(ws);
        if (!streamerId) return;

        stopStreamerInRoom(room, meta.code, streamerId);
        break;
      }

      case "watch_stream": {
        const meta = ws._meta;
        if (!meta) return;
        const room = rooms.get(meta.code);
        if (!room) return;
        const watcherId = getParticipantId(ws);
        if (!watcherId) return;

        const streamerId = typeof msg.streamerId === "string" ? msg.streamerId : "";
        if (!streamerId || watcherId === streamerId) return;

        if (!room.activeStreams.has(streamerId)) {
          sendJson(ws, { type: "stream_stopped", streamerId });
          return;
        }

        let watchers = room.watchersByStreamer.get(streamerId);
        if (!watchers) {
          watchers = new Set();
          room.watchersByStreamer.set(streamerId, watchers);
        }
        watchers.add(watcherId);

        const streamerWs = getParticipantWs(room, streamerId);
        sendJson(streamerWs, {
          type: "viewer_watching",
          viewerId: watcherId,
          nickname: meta.nickname,
          streamerId,
        });
        break;
      }

      case "stop_watching": {
        const meta = ws._meta;
        if (!meta) return;
        const room = rooms.get(meta.code);
        if (!room) return;
        const watcherId = getParticipantId(ws);
        if (!watcherId) return;

        const streamerId = typeof msg.streamerId === "string" ? msg.streamerId : "";
        if (!streamerId) return;

        const watchers = room.watchersByStreamer.get(streamerId);
        if (watchers && watchers.delete(watcherId)) {
          const streamerWs = getParticipantWs(room, streamerId);
          sendJson(streamerWs, {
            type: "viewer_unwatching",
            viewerId: watcherId,
            streamerId,
          });
        }
        break;
      }

      case "leave_room": {
        if (ws._meta?.role === "viewer") {
          cleanupClient(ws, true);
        }
        break;
      }

      case "signal": {
        const meta = ws._meta;
        if (!meta) return;
        const room = rooms.get(meta.code);
        if (!room) return;

        const fromId = getParticipantId(ws);
        if (!fromId) return;
        const targetId =
          typeof msg.targetId === "string" && msg.targetId ? msg.targetId : "host";
        const streamId =
          typeof msg.streamId === "string" && msg.streamId ? msg.streamId : "host";
        if (targetId === fromId) return;

        const targetWs = getParticipantWs(room, targetId);
        if (targetWs) {
          sendJson(targetWs, {
            type: "signal",
            fromId,
            streamId,
            payload: msg.payload,
          });
        }
        break;
      }

      default:
        sendJson(ws, {
          type: "error",
          code: "UNKNOWN_TYPE",
          message: `Unknown message type: ${String(msg.type)}`,
        });
    }
  });

  ws.on("close", () => {
    releaseClientIp(ws);
    cleanupClient(ws);
  });
  ws.on("error", () => {
    releaseClientIp(ws);
    cleanupClient(ws);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws._isAlive) {
      releaseClientIp(ws);
      cleanupClient(ws);
      ws.terminate();
      continue;
    }
    ws._isAlive = false;
    ws.ping();
  }
}, 25000);

wss.on("close", () => {
  clearInterval(heartbeat);
  limiter.dispose();
});

server.listen(PORT, HOST, () => {
  console.log(`screen-share signaling server listening on ws://${HOST}:${PORT}`);
});
