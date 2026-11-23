/**
 * In-memory anti-DoS & abuse rate limiter for the screen-share signaling server.
 * Zero external dependencies; auto-sweeps expired entries to prevent memory leaks.
 */

export function extractClientIp(req) {
  const xff = req?.headers?.["x-forwarded-for"];
  let raw = "";
  if (typeof xff === "string" && xff.trim()) {
    raw = xff.split(",")[0].trim();
  } else if (Array.isArray(xff) && xff.length > 0) {
    raw = String(xff[0]).split(",")[0].trim();
  } else {
    raw = String(req?.socket?.remoteAddress || "unknown");
  }
  return raw.replace(/^::ffff:/i, "") || "unknown";
}

export function formatRemaining(ms) {
  const totalSec = Math.max(1, Math.ceil(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins > 0 && secs > 0) return `${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m`;
  return `${secs}s`;
}

export class RateLimiter {
  constructor(options = {}) {
    this.maxActiveRoomsPerIp = Number(options.maxActiveRoomsPerIp ?? 1);
    this.maxGlobalRooms = Number(options.maxGlobalRooms ?? 50);

    this.maxRoomCreates = Number(options.maxRoomCreates ?? 3);
    this.roomCreateWindowMs = Number(options.roomCreateWindowMs ?? 10 * 60_000);
    this.roomCreateBlockMs = Number(options.roomCreateBlockMs ?? 5 * 60_000);

    this.maxFailedJoins = Number(options.maxFailedJoins ?? 10);
    this.failedJoinWindowMs = Number(options.failedJoinWindowMs ?? 5 * 60_000);
    this.failedJoinBlockMs = Number(options.failedJoinBlockMs ?? 5 * 60_000);

    this.maxWsPerIp = Number(options.maxWsPerIp ?? 8);
    this.maxWsMessages = Number(options.maxWsMessages ?? 45);
    this.wsMessageWindowMs = Number(options.wsMessageWindowMs ?? 10_000);

    this.maxHttpRequests = Number(options.maxHttpRequests ?? 60);
    this.httpWindowMs = Number(options.httpWindowMs ?? 60_000);

    /** @type {Map<string, number>} */
    this.wsCountByIp = new Map();
    /** @type {Map<string, number[]>} */
    this.httpHitsByIp = new Map();
    /** @type {Map<string, number[]>} */
    this.roomCreatesByIp = new Map();
    /** @type {Map<string, number>} */
    this.roomCreateBlockedUntil = new Map();
    /** @type {Map<string, number[]>} */
    this.failedJoinsByIp = new Map();
    /** @type {Map<string, number>} */
    this.joinBlockedUntil = new Map();

    this.sweepTimer = setInterval(() => this.sweep(), 5 * 60_000);
    this.sweepTimer.unref?.();
  }

  pruneWindow(map, key, windowMs, now) {
    const arr = map.get(key);
    if (!arr) return [];
    const cutoff = now - windowMs;
    const kept = arr.filter((ts) => ts > cutoff);
    if (kept.length === 0) {
      map.delete(key);
    } else {
      map.set(key, kept);
    }
    return kept;
  }

  checkHttpRequest(ip, now = Date.now()) {
    const hits = this.pruneWindow(this.httpHitsByIp, ip, this.httpWindowMs, now);
    if (hits.length >= this.maxHttpRequests) {
      const retryAfterMs = Math.max(1000, hits[0] + this.httpWindowMs - now);
      return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
    }
    hits.push(now);
    this.httpHitsByIp.set(ip, hits);
    return { allowed: true };
  }

  tryAcquireWs(ip) {
    const current = this.wsCountByIp.get(ip) || 0;
    if (current >= this.maxWsPerIp) {
      return false;
    }
    this.wsCountByIp.set(ip, current + 1);
    return true;
  }

  releaseWs(ip) {
    const current = this.wsCountByIp.get(ip) || 0;
    if (current <= 1) {
      this.wsCountByIp.delete(ip);
    } else {
      this.wsCountByIp.set(ip, current - 1);
    }
  }

  checkWsMessage(ws, now = Date.now()) {
    if (!ws._msgTimestamps) {
      ws._msgTimestamps = [];
    }
    const cutoff = now - this.wsMessageWindowMs;
    const kept = ws._msgTimestamps.filter((ts) => ts > cutoff);
    if (kept.length >= this.maxWsMessages) {
      ws._msgTimestamps = kept;
      return false;
    }
    kept.push(now);
    ws._msgTimestamps = kept;
    return true;
  }

  checkCreateRoom(ip, rooms, now = Date.now()) {
    // 1. Check active block
    const blockedUntil = this.roomCreateBlockedUntil.get(ip);
    if (blockedUntil && blockedUntil > now) {
      const remaining = blockedUntil - now;
      return {
        allowed: false,
        code: "RATE_LIMITED",
        message: `Too many rooms created. Try again in ${formatRemaining(remaining)}.`,
        retryAfterMs: remaining,
      };
    }
    if (blockedUntil && blockedUntil <= now) {
      this.roomCreateBlockedUntil.delete(ip);
    }

    // 2. Enforce max active rooms per IP (1 by default)
    let activeForIp = 0;
    for (const room of rooms.values()) {
      if (room.hostIp === ip) activeForIp++;
    }
    if (activeForIp >= this.maxActiveRoomsPerIp) {
      return {
        allowed: false,
        code: "ROOM_LIMIT_REACHED",
        message: "You already have an active room from this network. Stop it before creating a new one.",
      };
    }

    // 3. Enforce global room cap
    if (rooms.size >= this.maxGlobalRooms) {
      return {
        allowed: false,
        code: "SERVER_BUSY",
        message: "Server is currently at room capacity. Please try again shortly.",
      };
    }

    // 4. Enforce sliding-window room creation limit (3 per 10 min -> 5 min block)
    const history = this.pruneWindow(this.roomCreatesByIp, ip, this.roomCreateWindowMs, now);
    if (history.length >= this.maxRoomCreates) {
      const until = now + this.roomCreateBlockMs;
      this.roomCreateBlockedUntil.set(ip, until);
      this.roomCreatesByIp.delete(ip);
      return {
        allowed: false,
        code: "RATE_LIMITED",
        message: `Too many rooms created (${this.maxRoomCreates} max). You are temporarily blocked for ${formatRemaining(this.roomCreateBlockMs)}.`,
        retryAfterMs: this.roomCreateBlockMs,
      };
    }

    history.push(now);
    this.roomCreatesByIp.set(ip, history);
    return { allowed: true };
  }

  checkJoinAllowed(ip, now = Date.now()) {
    const blockedUntil = this.joinBlockedUntil.get(ip);
    if (blockedUntil && blockedUntil > now) {
      const remaining = blockedUntil - now;
      return {
        allowed: false,
        code: "RATE_LIMITED",
        message: `Too many invalid room attempts. Try again in ${formatRemaining(remaining)}.`,
      };
    }
    if (blockedUntil && blockedUntil <= now) {
      this.joinBlockedUntil.delete(ip);
    }
    return { allowed: true };
  }

  recordFailedJoin(ip, now = Date.now()) {
    const fails = this.pruneWindow(this.failedJoinsByIp, ip, this.failedJoinWindowMs, now);
    fails.push(now);
    if (fails.length >= this.maxFailedJoins) {
      this.joinBlockedUntil.set(ip, now + this.failedJoinBlockMs);
      this.failedJoinsByIp.delete(ip);
    } else {
      this.failedJoinsByIp.set(ip, fails);
    }
  }

  sweep(now = Date.now()) {
    for (const [ip, until] of this.roomCreateBlockedUntil) {
      if (until <= now) this.roomCreateBlockedUntil.delete(ip);
    }
    for (const [ip, until] of this.joinBlockedUntil) {
      if (until <= now) this.joinBlockedUntil.delete(ip);
    }
    for (const ip of this.httpHitsByIp.keys()) {
      this.pruneWindow(this.httpHitsByIp, ip, this.httpWindowMs, now);
    }
    for (const ip of this.roomCreatesByIp.keys()) {
      this.pruneWindow(this.roomCreatesByIp, ip, this.roomCreateWindowMs, now);
    }
    for (const ip of this.failedJoinsByIp.keys()) {
      this.pruneWindow(this.failedJoinsByIp, ip, this.failedJoinWindowMs, now);
    }
  }

  dispose() {
    clearInterval(this.sweepTimer);
  }
}
