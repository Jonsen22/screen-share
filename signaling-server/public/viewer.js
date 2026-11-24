const NICKNAME_KEY = "screen-share.web.nickname";
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node;
}

const viewerJoin = el("viewer-join");
const viewerStage = el("viewer-stage");
const viewerJoinForm = el("viewer-join-form");
const nicknameInput = el("nickname-input");
const roomCodeInput = el("room-code-input");
const btnJoinRoom = el("btn-join-room");
const btnOpenDesktop = el("btn-open-desktop");
const downloadDesktopLink = el("download-desktop-link");
const liveStatusBadge = el("live-status-badge");
const joinTitle = el("join-title");
const joinSubtitle = el("join-subtitle");
const viewerError = el("viewer-error");
const viewerVideoWrap = el("viewer-video-wrap");
const viewerVideo = el("viewer-video");
const viewerBanner = el("viewer-banner");
const viewerBannerText = el("viewer-banner-text");
const btnUnmuteOverlay = el("btn-unmute-overlay");
const viewerRoomBadge = el("viewer-room-badge");
const btnViewerMute = el("btn-viewer-mute");
const viewerVolume = el("viewer-volume");
const btnToggleStats = el("btn-toggle-stats");
const btnFullscreen = el("btn-fullscreen");
const btnLeaveRoom = el("btn-leave-room");
const statsHud = el("stats-hud");

const statRes = el("stat-res");
const statFps = el("stat-fps");
const statBitrate = el("stat-bitrate");
const statAudio = el("stat-audio");
const statRtt = el("stat-rtt");
const statLoss = el("stat-loss");
const statCodec = el("stat-codec");
const statState = el("stat-state");

function getSignalingUrl() {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

function sanitizeNickname(raw) {
  return String(raw || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
}

function showError(message) {
  if (!message) {
    viewerError.textContent = "";
    viewerError.classList.add("hidden");
  } else {
    viewerError.textContent = message;
    viewerError.classList.remove("hidden");
  }
}

class SignalingClient {
  constructor() {
    this.ws = null;
    this.listeners = new Set();
    this.closeListeners = new Set();
    this.pingTimer = null;
    this.intentionalClose = false;
  }

  connect(url, timeoutMs = 65000) {
    this.closeSocketOnly();
    this.intentionalClose = false;

    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(url);

      const timer = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.close();
          reject(new Error("Timed out connecting to signaling server."));
        }
      }, timeoutMs);

      socket.onopen = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.ws = socket;
        this.startKeepalive();
        resolve();
      };

      socket.onerror = () => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          reject(new Error("Could not connect to signaling server."));
        }
      };

      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data));
          if (parsed.type === "pong") return;
          for (const fn of this.listeners) fn(parsed);
        } catch {
          // Ignore malformed JSON
        }
      };

      socket.onclose = () => {
        if (this.ws === socket) {
          this.ws = null;
          this.stopKeepalive();
        }
        if (!this.intentionalClose && settled) {
          for (const fn of this.closeListeners) fn("Disconnected from signaling server.");
        }
      };
    });
  }

  onMessage(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onClose(fn) {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Signaling socket is not connected.");
    }
    this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.intentionalClose = true;
    this.closeSocketOnly();
    this.listeners.clear();
    this.closeListeners.clear();
  }

  closeSocketOnly() {
    this.stopKeepalive();
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      old.onclose = null;
      old.onerror = null;
      old.onmessage = null;
      try {
        old.close();
      } catch {
        // Ignore
      }
    }
  }

  startKeepalive() {
    this.stopKeepalive();
    this.pingTimer = window.setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: "ping" }));
        } catch {
          // Ignore
        }
      }
    }, 20_000);
  }

  stopKeepalive() {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

class WebViewer {
  constructor() {
    this.signaling = new SignalingClient();
    this.pc = null;
    this.remoteStream = new MediaStream();
    this.pendingIce = [];
    this.remoteSet = false;
    this.statsTimer = null;
    this.reconnectTimer = null;
    this.reconnecting = false;
    this.roomCode = "";
    this.viewerId = "";
    this.viewerToken = "";
    this.nickname = "Viewer";
    this.prevBytes = 0;
    this.prevTimestamp = 0;
    this.prevAudioBytes = 0;
    this.prevAudioTimestamp = 0;
    this.active = false;
  }

  async join(roomCode, nickname) {
    if (this.active) return;
    this.nickname = nickname;
    const url = getSignalingUrl();
    await this.signaling.connect(url);

    try {
      const joined = await new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          unsub();
          reject(new Error("Timed out joining room."));
        }, 8000);

        const unsub = this.signaling.onMessage((msg) => {
          if (msg.type === "joined_room") {
            window.clearTimeout(timer);
            unsub();
            resolve({
              code: msg.code,
              viewerId: msg.viewerId,
              viewerToken: msg.viewerToken || "",
              hostNickname: msg.hostNickname || "Host",
            });
          } else if (msg.type === "error") {
            window.clearTimeout(timer);
            unsub();
            reject(new Error(msg.message));
          }
        });

        this.signaling.send({ type: "join_room", code: roomCode, nickname });
      });

      this.active = true;
      this.roomCode = joined.code;
      this.viewerId = joined.viewerId;
      this.viewerToken = joined.viewerToken;
      this.remoteStream = new MediaStream();
      this.pendingIce = [];
      this.remoteSet = false;
      this.prevBytes = 0;
      this.prevTimestamp = 0;
      this.prevAudioBytes = 0;
      this.prevAudioTimestamp = 0;

      this.setupPeerConnection();
      this.signaling.onMessage((msg) => this.handleServerMessage(msg));
      this.signaling.onClose(() => {
        if (this.active) this.scheduleReattach();
      });

      showError(null);
      btnUnmuteOverlay.classList.add("hidden");
      viewerRoomBadge.textContent = `${joined.hostNickname} · ${joined.code}`;
      viewerJoin.classList.add("hidden");
      viewerStage.classList.remove("hidden");
      setBanner("Connecting to host...");
      this.startStatsLoop();
    } catch (err) {
      this.cleanup();
      throw err;
    }
  }

  scheduleReattach(delayMs = 3000) {
    if (!this.active || this.reconnecting) return;
    this.reconnecting = true;

    const attempt = async (currentDelay) => {
      if (!this.active) {
        this.reconnecting = false;
        return;
      }
      try {
        await this.signaling.connect(getSignalingUrl(), 65000);
        if (!this.active) {
          this.signaling.close();
          this.reconnecting = false;
          return;
        }
        this.signaling.send({
          type: "reattach_viewer",
          code: this.roomCode,
          viewerId: this.viewerId,
          viewerToken: this.viewerToken,
          nickname: this.nickname,
        });
        this.reconnecting = false;
      } catch {
        if (!this.active) {
          this.reconnecting = false;
          return;
        }
        const nextDelay = Math.min(currentDelay * 2, 20_000);
        this.reconnectTimer = window.setTimeout(() => void attempt(nextDelay), currentDelay);
      }
    };

    this.reconnectTimer = window.setTimeout(() => void attempt(delayMs), delayMs);
  }

  leave(reason, notifyServer = true) {
    if (!this.active) return;
    this.active = false;
    if (notifyServer) {
      try {
        this.signaling.send({ type: "leave_room" });
      } catch {
        // Ignore
      }
    }
    this.cleanup();

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
    viewerVideo.srcObject = null;
    btnUnmuteOverlay.classList.add("hidden");
    viewerStage.classList.add("hidden");
    viewerJoin.classList.remove("hidden");
    btnJoinRoom.disabled = false;
    btnJoinRoom.textContent = "Watch in Browser";
    if (reason) showError(reason);
  }

  setupPeerConnection() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;

    pc.ontrack = (event) => {
      const stream = event.streams[0] || this.remoteStream;
      if (!event.streams[0]) {
        this.remoteStream.addTrack(event.track);
      }
      if (viewerVideo.srcObject !== stream) {
        viewerVideo.srcObject = stream;
      }
      viewerVideo.volume = Number(viewerVolume.value);
      viewerVideo.muted = Number(viewerVolume.value) === 0;
      void viewerVideo.play().catch(() => {
        viewerVideo.muted = true;
        btnViewerMute.textContent = "Unmute";
        btnUnmuteOverlay.classList.remove("hidden");
        void viewerVideo.play().catch(() => {});
      });
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        try {
          this.signaling.send({
            type: "signal",
            payload: { kind: "ice", candidate: event.candidate.toJSON() },
          });
        } catch {
          // Ignore
        }
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "connected") {
        setBanner(null);
      } else if (state === "connecting") {
        setBanner("Connecting to host...");
      } else if (state === "disconnected") {
        setBanner("Connection interrupted — reconnecting...");
      } else if (state === "failed") {
        this.leave("Host ended the stream or peer connection failed.", false);
      }
    };
  }

  handleServerMessage(msg) {
    switch (msg.type) {
      case "signal":
        void this.handleSignal(msg.payload);
        break;
      case "kicked":
        this.leave(msg.reason || "You were removed from the room by the host.", false);
        break;
      case "banned":
        this.leave(msg.reason || "You were banned from this room by the host.", false);
        break;
      case "room_closed":
        this.leave(msg.reason || "Host ended the stream.", false);
        break;
      case "error":
        this.leave(msg.message, false);
        break;
    }
  }

  async handleSignal(payload) {
    const pc = this.pc;
    if (!pc) return;
    try {
      if (payload.kind === "offer") {
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        this.remoteSet = true;
        for (const cand of this.pendingIce) {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
        }
        this.pendingIce = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signaling.send({
          type: "signal",
          payload: { kind: "answer", sdp: pc.localDescription },
        });
      } else if (payload.kind === "ice") {
        if (this.remoteSet) {
          await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } else {
          this.pendingIce.push(payload.candidate);
        }
      }
    } catch (err) {
      this.leave(`WebRTC negotiation failed: ${String(err)}`, false);
    }
  }

  startStatsLoop() {
    this.statsTimer = window.setInterval(() => void this.pollStats(), 1000);
  }

  async pollStats() {
    const pc = this.pc;
    if (!pc || !this.active) return;

    try {
      const report = await pc.getStats();
      let width = 0;
      let height = 0;
      let fps = 0;
      let bytesReceived = 0;
      let timestamp = 0;
      let packetsReceived = 0;
      let packetsLost = 0;
      let codecId = "";
      let audioBytes = 0;
      let audioTimestamp = 0;
      let audioLevel = null;
      let hasAudioReport = false;
      let rttSeconds = null;
      const codecs = new Map();

      report.forEach((stat) => {
        if (stat.type === "codec" && stat.mimeType) {
          codecs.set(stat.id, String(stat.mimeType).replace("video/", ""));
        } else if (stat.type === "inbound-rtp" && stat.kind === "video") {
          width = stat.frameWidth ?? 0;
          height = stat.frameHeight ?? 0;
          fps = stat.framesPerSecond ?? 0;
          bytesReceived = stat.bytesReceived ?? 0;
          timestamp = stat.timestamp ?? 0;
          packetsReceived = stat.packetsReceived ?? 0;
          packetsLost = stat.packetsLost ?? 0;
          codecId = stat.codecId ?? "";
        } else if (stat.type === "inbound-rtp" && stat.kind === "audio") {
          hasAudioReport = true;
          audioBytes = stat.bytesReceived ?? 0;
          audioTimestamp = stat.timestamp ?? 0;
          if (typeof stat.audioLevel === "number") audioLevel = stat.audioLevel;
        } else if (
          stat.type === "candidate-pair" &&
          stat.state === "succeeded" &&
          typeof stat.currentRoundTripTime === "number"
        ) {
          rttSeconds = stat.currentRoundTripTime;
        }
      });

      let bitrateLabel = "-";
      if (this.prevTimestamp > 0 && timestamp > this.prevTimestamp) {
        const dtSec = (timestamp - this.prevTimestamp) / 1000;
        const bps = ((bytesReceived - this.prevBytes) * 8) / dtSec;
        bitrateLabel =
          bps >= 1_000_000
            ? `${(bps / 1_000_000).toFixed(2)} Mbps`
            : bps > 0
              ? `${Math.round(bps / 1000)} kbps`
              : "-";
      }
      this.prevBytes = bytesReceived;
      this.prevTimestamp = timestamp;

      let audioLabel = hasAudioReport ? "Connected" : "No track";
      if (this.prevAudioTimestamp > 0 && audioTimestamp > this.prevAudioTimestamp) {
        const dtSec = (audioTimestamp - this.prevAudioTimestamp) / 1000;
        const kbps = Math.round(((audioBytes - this.prevAudioBytes) * 8) / dtSec / 1000);
        const loud = audioLevel !== null && audioLevel > 0.002 ? " · Active" : " · Silent";
        audioLabel = `${kbps} kbps${loud}`;
      }
      this.prevAudioBytes = audioBytes;
      this.prevAudioTimestamp = audioTimestamp;

      const totalPackets = packetsReceived + Math.max(0, packetsLost);
      const lossPct =
        totalPackets > 0
          ? `${((Math.max(0, packetsLost) / totalPackets) * 100).toFixed(1)}%`
          : "0.0%";

      statRes.textContent = width && height ? `${width}×${height}` : "-";
      statFps.textContent = fps ? `${Math.round(fps)} fps` : "-";
      statBitrate.textContent = bitrateLabel;
      statAudio.textContent = audioLabel;
      statRtt.textContent = rttSeconds !== null ? `${Math.round(rttSeconds * 1000)} ms` : "-";
      statLoss.textContent = lossPct;
      statCodec.textContent = codecs.get(codecId) ?? "-";
      statState.textContent = pc.connectionState;
    } catch {
      // Ignore transient stats errors
    }
  }

  cleanup() {
    this.reconnecting = false;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    this.signaling.close();
    this.pendingIce = [];
    this.remoteSet = false;
    this.roomCode = "";
    this.viewerId = "";
    this.viewerToken = "";
  }
}

function setBanner(text) {
  if (!text) {
    viewerBanner.classList.add("hidden");
  } else {
    viewerBannerText.textContent = text;
    viewerBanner.classList.remove("hidden");
  }
}

const viewer = new WebViewer();

// Restore saved nickname
const savedNick = sanitizeNickname(window.localStorage.getItem(NICKNAME_KEY));
if (savedNick) {
  nicknameInput.value = savedNick;
}

// Apply injected /join/<CODE> context if present
let ctx = null;
const ctxEl = document.getElementById("join-context");
if (ctxEl && ctxEl.textContent) {
  try {
    ctx = JSON.parse(ctxEl.textContent);
  } catch {
    ctx = null;
  }
}
if (ctx) {
  if (ctx.downloadUrl) {
    downloadDesktopLink.href = ctx.downloadUrl;
  }
  if (ctx.code) {
    roomCodeInput.value = ctx.code;
    btnOpenDesktop.href = `screenshare://join/${encodeURIComponent(ctx.code)}`;
    btnOpenDesktop.classList.remove("hidden");
  }
  if (ctx.isLive && ctx.hostNickname) {
    liveStatusBadge.classList.remove("hidden");
    joinTitle.textContent = `${ctx.hostNickname} is sharing their screen`;
    joinSubtitle.textContent = `Room ${ctx.code} is live right now. Click Watch in Browser to join immediately.`;
  }
}

roomCodeInput.addEventListener("input", () => {
  const cleaned = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  roomCodeInput.value =
    cleaned.length > 4 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}` : cleaned;
});

viewerJoinForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError(null);

  const nickname = sanitizeNickname(nicknameInput.value);
  if (!nickname) {
    showError("Enter a nickname (1–24 characters).");
    nicknameInput.focus();
    return;
  }
  const code = roomCodeInput.value.trim();
  if (code.length < 8) {
    showError("Enter a valid 8-character room code (e.g. ABCD-1234).");
    roomCodeInput.focus();
    return;
  }

  window.localStorage.setItem(NICKNAME_KEY, nickname);
  btnJoinRoom.disabled = true;
  btnJoinRoom.textContent = "Connecting...";

  try {
    await viewer.join(code, nickname);
  } catch (err) {
    btnJoinRoom.disabled = false;
    btnJoinRoom.textContent = "Watch in Browser";
    showError(err instanceof Error ? err.message : String(err));
  }
});

btnLeaveRoom.addEventListener("click", () => viewer.leave(undefined, true));

btnUnmuteOverlay.addEventListener("click", () => {
  viewerVideo.muted = false;
  if (Number(viewerVolume.value) === 0) viewerVolume.value = "1";
  viewerVideo.volume = Number(viewerVolume.value);
  btnViewerMute.textContent = "Mute";
  btnUnmuteOverlay.classList.add("hidden");
  void viewerVideo.play().catch(() => {});
});

viewerVolume.addEventListener("input", () => {
  const vol = Number(viewerVolume.value);
  viewerVideo.volume = vol;
  viewerVideo.muted = vol === 0;
  btnViewerMute.textContent = viewerVideo.muted ? "Unmute" : "Mute";
  if (!viewerVideo.muted) btnUnmuteOverlay.classList.add("hidden");
});

btnViewerMute.addEventListener("click", () => {
  viewerVideo.muted = !viewerVideo.muted;
  btnViewerMute.textContent = viewerVideo.muted ? "Unmute" : "Mute";
  if (!viewerVideo.muted) btnUnmuteOverlay.classList.add("hidden");
});

function toggleStats() {
  statsHud.classList.toggle("hidden");
}

async function toggleFullscreen() {
  if (document.fullscreenElement) {
    await document.exitFullscreen().catch(() => {});
  } else {
    await viewerVideoWrap.requestFullscreen().catch(() => {});
  }
}

btnToggleStats.addEventListener("click", toggleStats);
btnFullscreen.addEventListener("click", () => void toggleFullscreen());
viewerVideo.addEventListener("dblclick", () => void toggleFullscreen());

window.addEventListener("keydown", (e) => {
  if (!viewer.active) return;
  if (e.key === "i" || e.key === "I") {
    toggleStats();
  } else if (e.key === "f" || e.key === "F") {
    void toggleFullscreen();
  }
});
