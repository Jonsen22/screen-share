import { SignalingClient, ServerMessage } from "./signaling";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export interface ViewerStats {
  resolution: string;
  fps: string;
  bitrate: string;
  audio: string;
  rtt: string;
  packetLoss: string;
  codec: string;
  state: string;
}

export interface ViewerCallbacks {
  onJoined: (code: string, hostNickname: string) => void;
  onStream: (stream: MediaStream) => void;
  onBanner: (text: string | null) => void;
  onStats: (stats: ViewerStats) => void;
  onEnded: (reason?: string) => void;
}

export class ViewerManager {
  private signaling = new SignalingClient();
  private pc: RTCPeerConnection | null = null;
  private remoteStream = new MediaStream();
  private pendingIce: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private statsTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnecting = false;
  private signalingUrl = "";
  private roomCode = "";
  private viewerId = "";
  private viewerToken = "";
  private viewerNickname = "Viewer";
  private prevBytes = 0;
  private prevTimestamp = 0;
  private prevAudioBytes = 0;
  private prevAudioTimestamp = 0;
  private active = false;
  private callbacks: ViewerCallbacks;

  constructor(callbacks: ViewerCallbacks) {
    this.callbacks = callbacks;
  }

  async join(signalingUrl: string, roomCode: string, nickname: string): Promise<void> {
    if (this.active) return;
    this.signalingUrl = signalingUrl;
    this.viewerNickname = nickname;

    await this.signaling.connect(signalingUrl);

    try {
      const joined = await new Promise<{
        code: string;
        viewerId: string;
        viewerToken: string;
        hostNickname: string;
      }>((resolve, reject) => {
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
        if (this.active) {
          // Never interrupt a live P2P WebRTC stream when signaling blips;
          // quietly reattach signaling in the background.
          this.scheduleSignalingReattach();
        }
      });

      this.callbacks.onJoined(joined.code, joined.hostNickname);
      this.callbacks.onBanner("Connecting to host...");
      this.startStatsLoop();
    } catch (err) {
      this.cleanup();
      throw err;
    }
  }

  private scheduleSignalingReattach(delayMs = 3000): void {
    if (!this.active || this.reconnecting) return;
    this.reconnecting = true;

    const attempt = async (currentDelay: number) => {
      if (!this.active) {
        this.reconnecting = false;
        return;
      }
      try {
        await this.signaling.connect(this.signalingUrl, 65000);
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
          nickname: this.viewerNickname,
        });
        this.reconnecting = false;
      } catch {
        if (!this.active) {
          this.reconnecting = false;
          return;
        }
        const nextDelay = Math.min(currentDelay * 2, 20_000);
        this.reconnectTimer = window.setTimeout(() => {
          void attempt(nextDelay);
        }, currentDelay);
      }
    };

    this.reconnectTimer = window.setTimeout(() => {
      void attempt(delayMs);
    }, delayMs);
  }

  leave(reason?: string, notifyServer = true): void {
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
    this.callbacks.onEnded(reason);
  }

  private setupPeerConnection(): void {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;

    pc.ontrack = (event) => {
      if (event.streams[0]) {
        this.callbacks.onStream(event.streams[0]);
      } else {
        this.remoteStream.addTrack(event.track);
        this.callbacks.onStream(this.remoteStream);
      }
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
        this.callbacks.onBanner(null);
      } else if (state === "connecting") {
        this.callbacks.onBanner("Connecting to host...");
      } else if (state === "disconnected") {
        this.callbacks.onBanner("Connection interrupted — reconnecting...");
      } else if (state === "failed") {
        this.leave("Peer connection failed (check firewall/NAT or network).");
      }
    };
  }

  private handleServerMessage(msg: ServerMessage): void {
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

  private async handleSignal(
    payload: Extract<ServerMessage, { type: "signal" }>["payload"]
  ): Promise<void> {
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
          payload: { kind: "answer", sdp: pc.localDescription! },
        });
      } else if (payload.kind === "ice") {
        if (this.remoteSet) {
          await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } else {
          this.pendingIce.push(payload.candidate);
        }
      }
    } catch (err) {
      this.leave(`WebRTC negotiation failed: ${String(err)}`);
    }
  }

  private startStatsLoop(): void {
    this.statsTimer = window.setInterval(() => {
      void this.pollStats();
    }, 1000);
  }

  private async pollStats(): Promise<void> {
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
      let audioLevel: number | null = null;
      let hasAudioReport = false;
      let rttSeconds: number | null = null;
      const codecs = new Map<string, string>();

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
          if (typeof stat.audioLevel === "number") {
            audioLevel = stat.audioLevel;
          }
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
        if (bps >= 1_000_000) {
          bitrateLabel = `${(bps / 1_000_000).toFixed(2)} Mbps`;
        } else if (bps > 0) {
          bitrateLabel = `${Math.round(bps / 1000)} kbps`;
        }
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
        totalPackets > 0 ? `${((Math.max(0, packetsLost) / totalPackets) * 100).toFixed(1)}%` : "0.0%";

      this.callbacks.onStats({
        resolution: width && height ? `${width}×${height}` : "-",
        fps: fps ? `${Math.round(fps)} fps` : "-",
        bitrate: bitrateLabel,
        audio: audioLabel,
        rtt: rttSeconds !== null ? `${Math.round(rttSeconds * 1000)} ms` : "-",
        packetLoss: lossPct,
        codec: codecs.get(codecId) ?? "-",
        state: pc.connectionState,
      });
    } catch {
      // Ignore transient stats errors
    }
  }

  private cleanup(): void {
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
