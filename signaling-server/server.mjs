import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

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
const LATEST_APP_VERSION = (process.env.LATEST_APP_VERSION || "1.2.0").trim();
const APP_DOWNLOAD_URL = (
  process.env.APP_DOWNLOAD_URL || "https://github.com/Jonsen22/screen-share/releases/latest"
).trim();
const APP_RELEASE_NOTES = (process.env.APP_RELEASE_NOTES || "").trim();

/**
 * @typedef {{
 *   host: WebSocket | null,
 *   hostToken: string,
 *   hostNickname: string,
 *   hostGraceTimer: NodeJS.Timeout | null,
 *   viewers: Map<string, { ws: WebSocket, nickname: string }>,
 *   viewerGraceTimers: Map<string, NodeJS.Timeout>,
 *   createdAt: number
 * }} Room
 */

/** @type {Map<string, Room>} */
const rooms = new Map();

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
  const contextScript = `<script>window.__JOIN_CONTEXT__ = ${safeJson};</script>`;

  return WEB_INDEX_HTML.replace("<!--OG_META-->", ogMeta).replace(
    "<!--JOIN_CONTEXT-->",
    contextScript
  );
}

const server = http.createServer((req, res) => {
  const reqPath = (req.url || "/").split("?")[0];
  if (reqPath === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        status: "ok",
        version: LATEST_APP_VERSION,
        rooms: rooms.size,
        maxViewers: MAX_VIEWERS,
      })
    );
    return;
  }
  if (reqPath === "/version") {
    res.writeHead(200, {
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
  if (reqPath === "/style.css") {
    res.writeHead(200, {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    });
    res.end(WEB_STYLE_CSS);
    return;
  }
  if (reqPath === "/viewer.js") {
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    });
    res.end(WEB_VIEWER_JS);
    return;
  }
  if (reqPath === "/" || reqPath === "/watch") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(renderWebViewerPage(null, null));
    return;
  }
  if (reqPath.startsWith("/join/")) {
    const rawCode = decodeURIComponent(reqPath.slice("/join/".length));
    const code = normalizeCode(rawCode);
    if (!isValidNormalizedCode(code)) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Invalid room code.\n");
      return;
    }
    const room = rooms.get(code) || null;
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(renderWebViewerPage(code, room));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found\n");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws._isAlive = true;
  ws._meta = null;

  ws.on("pong", () => {
    ws._isAlive = true;
  });

  ws.on("message", (raw) => {
    ws._isAlive = true;
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
        cleanupClient(ws, true);
        const code = generateRoomCode();
        const hostToken = crypto.randomBytes(16).toString("hex");
        const hostNickname = sanitizeNickname(msg.nickname, "Host");
        rooms.set(code, {
          host: ws,
          hostToken,
          hostNickname,
          hostGraceTimer: null,
          viewers: new Map(),
          viewerGraceTimers: new Map(),
          createdAt: Date.now(),
        });
        ws._meta = { role: "host", code, nickname: hostNickname };
        sendJson(ws, {
          type: "room_created",
          code,
          hostToken,
          maxViewers: MAX_VIEWERS,
        });
        console.log(`[room ${code}] created by ${hostNickname}`);
        break;
      }

      case "reclaim_room": {
        const code = normalizeCode(msg.code);
        const hostToken = typeof msg.hostToken === "string" ? msg.hostToken : "";
        const hostNickname = sanitizeNickname(msg.nickname, "Host");
        if (!isValidNormalizedCode(code) || hostToken.length < 16) {
          sendJson(ws, {
            type: "error",
            code: "INVALID_RECLAIM",
            message: "Invalid room reclaim credentials.",
          });
          return;
        }

        const existing = rooms.get(code);
        if (existing) {
          if (existing.hostToken !== hostToken) {
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
          ws._meta = { role: "host", code, nickname: existing.hostNickname };
          sendJson(ws, {
            type: "room_reclaimed",
            code,
            maxViewers: MAX_VIEWERS,
            viewerCount: existing.viewers.size,
          });
          console.log(`[room ${code}] reclaimed by ${existing.hostNickname}`);
        } else {
          // Server restarted while host was still streaming P2P; recreate room with same code.
          rooms.set(code, {
            host: ws,
            hostToken,
            hostNickname,
            hostGraceTimer: null,
            viewers: new Map(),
            viewerGraceTimers: new Map(),
            createdAt: Date.now(),
          });
          ws._meta = { role: "host", code, nickname: hostNickname };
          sendJson(ws, {
            type: "room_reclaimed",
            code,
            maxViewers: MAX_VIEWERS,
            viewerCount: 0,
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

        room.viewers.delete(targetId);
        target.ws._meta = null;
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

      case "join_room": {
        cleanupClient(ws, true);
        const code = normalizeCode(msg.code);
        const room = rooms.get(code);
        if (!room || !room.host) {
          sendJson(ws, {
            type: "error",
            code: "ROOM_NOT_FOUND",
            message: "Room code not found. Check the code and try again.",
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
        const nickname = sanitizeNickname(msg.nickname, "Viewer");
        room.viewers.set(viewerId, { ws, nickname });
        ws._meta = { role: "viewer", code, viewerId, nickname };

        sendJson(ws, {
          type: "joined_room",
          code,
          viewerId,
          hostNickname: room.hostNickname,
          viewerCount: room.viewers.size,
          maxViewers: MAX_VIEWERS,
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
        const code = normalizeCode(msg.code);
        const viewerId = typeof msg.viewerId === "string" ? msg.viewerId : "";
        const room = rooms.get(code);
        if (!room || !viewerId) return;
        const pending = room.viewerGraceTimers.get(viewerId);
        if (pending) {
          clearTimeout(pending);
          room.viewerGraceTimers.delete(viewerId);
        }
        const existing = room.viewers.get(viewerId);
        if (!existing && room.viewers.size >= MAX_VIEWERS) return;
        const nickname = existing?.nickname || sanitizeNickname(msg.nickname, "Viewer");
        room.viewers.set(viewerId, { ws, nickname });
        ws._meta = { role: "viewer", code, viewerId, nickname };
        sendJson(ws, { type: "reattached", code, viewerId });
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

        if (meta.role === "host") {
          const target = room.viewers.get(msg.targetId);
          if (target) {
            sendJson(target.ws, {
              type: "signal",
              fromId: "host",
              payload: msg.payload,
            });
          }
        } else if (meta.role === "viewer") {
          sendJson(room.host, {
            type: "signal",
            fromId: meta.viewerId,
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

  ws.on("close", () => cleanupClient(ws));
  ws.on("error", () => cleanupClient(ws));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws._isAlive) {
      cleanupClient(ws);
      ws.terminate();
      continue;
    }
    ws._isAlive = false;
    ws.ping();
  }
}, 25000);

wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log(`screen-share signaling server listening on ws://${HOST}:${PORT}`);
});
