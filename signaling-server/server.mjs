import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_VIEWERS = 5;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const MAX_NICKNAME_LEN = 24;

/** @type {Map<string, { host: WebSocket, hostNickname: string, viewers: Map<string, { ws: WebSocket, nickname: string }>, createdAt: number }>} */
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

function sendJson(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function cleanupClient(ws) {
  const meta = ws._meta;
  if (!meta) return;
  ws._meta = null;

  const room = rooms.get(meta.code);
  if (!room) return;

  if (meta.role === "host") {
    for (const viewer of room.viewers.values()) {
      viewer.ws._meta = null;
      sendJson(viewer.ws, {
        type: "room_closed",
        reason: "Host ended the stream.",
      });
    }
    room.viewers.clear();
    rooms.delete(meta.code);
    console.log(`[room ${meta.code}] closed (host left)`);
  } else if (meta.role === "viewer") {
    const existing = room.viewers.get(meta.viewerId);
    if (existing && room.viewers.delete(meta.viewerId)) {
      sendJson(room.host, {
        type: "viewer_left",
        viewerId: meta.viewerId,
        nickname: existing.nickname,
        viewerCount: room.viewers.size,
      });
      console.log(
        `[room ${meta.code}] viewer ${meta.viewerId} (${existing.nickname}) left (${room.viewers.size}/${MAX_VIEWERS})`
      );
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        rooms: rooms.size,
        maxViewers: MAX_VIEWERS,
      })
    );
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("screen-share signaling server\n");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws._isAlive = true;
  ws._meta = null;

  ws.on("pong", () => {
    ws._isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      sendJson(ws, { type: "error", code: "BAD_JSON", message: "Invalid JSON payload." });
      return;
    }

    switch (msg.type) {
      case "create_room": {
        cleanupClient(ws);
        const code = generateRoomCode();
        const hostNickname = sanitizeNickname(msg.nickname, "Host");
        rooms.set(code, {
          host: ws,
          hostNickname,
          viewers: new Map(),
          createdAt: Date.now(),
        });
        ws._meta = { role: "host", code, nickname: hostNickname };
        sendJson(ws, {
          type: "room_created",
          code,
          maxViewers: MAX_VIEWERS,
        });
        console.log(`[room ${code}] created by ${hostNickname}`);
        break;
      }

      case "close_room": {
        if (ws._meta?.role === "host") {
          cleanupClient(ws);
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
        cleanupClient(ws);
        const code = normalizeCode(msg.code);
        const room = rooms.get(code);
        if (!room) {
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

      case "leave_room": {
        if (ws._meta?.role === "viewer") {
          cleanupClient(ws);
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
