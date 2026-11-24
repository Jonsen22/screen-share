import { SignalingClient, SignalPayload } from "./signaling";

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

export interface StreamSubscriberCallbacks {
  onStream: (stream: MediaStream | null) => void;
  onBanner?: (text: string | null) => void;
  onStats?: (stats: ViewerStats) => void;
  onFailed?: (reason: string) => void;
}

export class StreamSubscriber {
  private signaling: SignalingClient;
  private callbacks: StreamSubscriberCallbacks;
  private pc: RTCPeerConnection | null = null;
  private remoteStream = new MediaStream();
  private pendingIce: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private statsTimer: number | null = null;
  private watchedStreamerId: string | null = null;
  private prevBytes = 0;
  private prevTimestamp = 0;
  private prevAudioBytes = 0;
  private prevAudioTimestamp = 0;

  constructor(signaling: SignalingClient, callbacks: StreamSubscriberCallbacks) {
    this.signaling = signaling;
    this.callbacks = callbacks;
  }

  getWatchedStreamerId(): string | null {
    return this.watchedStreamerId;
  }

  watch(streamerId: string, streamerNickname?: string): void {
    if (
      this.watchedStreamerId === streamerId &&
      this.pc &&
      this.pc.connectionState !== "failed" &&
      this.pc.connectionState !== "closed"
    ) {
      return;
    }
    if (this.watchedStreamerId) {
      this.stopWatching(true);
    }

    this.watchedStreamerId = streamerId;
    this.remoteStream = new MediaStream();
    this.pendingIce = [];
    this.remoteSet = false;
    this.prevBytes = 0;
    this.prevTimestamp = 0;
    this.prevAudioBytes = 0;
    this.prevAudioTimestamp = 0;

    const label = streamerNickname ? `${streamerNickname}'s stream` : "stream";
    this.callbacks.onBanner?.(`Connecting to ${label}...`);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;

    pc.ontrack = (event) => {
      if (this.pc !== pc) return;
      if (event.streams[0]) {
        this.callbacks.onStream(event.streams[0]);
      } else {
        this.remoteStream.addTrack(event.track);
        this.callbacks.onStream(this.remoteStream);
      }
    };

    pc.onicecandidate = (event) => {
      if (this.pc !== pc) return;
      if (event.candidate && this.watchedStreamerId) {
        try {
          this.signaling.send({
            type: "signal",
            targetId: this.watchedStreamerId,
            streamId: this.watchedStreamerId,
            payload: { kind: "ice", candidate: event.candidate.toJSON() },
          });
        } catch {
          // Ignore send failure during teardown
        }
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const state = pc.connectionState;
      if (state === "connected") {
        this.callbacks.onBanner?.(null);
      } else if (state === "connecting") {
        this.callbacks.onBanner?.(`Connecting to ${label}...`);
      } else if (state === "disconnected") {
        this.callbacks.onBanner?.("Connection interrupted — reconnecting...");
      } else if (state === "failed") {
        this.callbacks.onBanner?.("Stream connection failed. Click a live stream to retry.");
        this.callbacks.onFailed?.("Peer connection failed (check firewall/NAT or network).");
      }
    };

    try {
      this.signaling.send({ type: "watch_stream", streamerId });
    } catch {
      // Ignore if socket temporarily disconnected
    }

    this.startStatsLoop();
  }

  stopWatching(notifyServer = true): void {
    const prevId = this.watchedStreamerId;
    this.watchedStreamerId = null;

    if (notifyServer && prevId) {
      try {
        this.signaling.send({ type: "stop_watching", streamerId: prevId });
      } catch {
        // Ignore if socket already closed
      }
    }

    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (this.pc) {
      const old = this.pc;
      this.pc = null;
      old.ontrack = null;
      old.onicecandidate = null;
      old.onconnectionstatechange = null;
      try {
        old.close();
      } catch {
        // Ignore
      }
    }
    this.pendingIce = [];
    this.remoteSet = false;
    this.prevBytes = 0;
    this.prevTimestamp = 0;
    this.prevAudioBytes = 0;
    this.prevAudioTimestamp = 0;
    this.callbacks.onStream(null);
  }

  async handleSignal(fromId: string, payload: SignalPayload): Promise<void> {
    const pc = this.pc;
    if (!pc || fromId !== this.watchedStreamerId) return;

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
          targetId: fromId,
          streamId: fromId,
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
      this.callbacks.onBanner?.(`WebRTC negotiation failed: ${String(err)}`);
    }
  }

  private startStatsLoop(): void {
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
    }
    if (!this.callbacks.onStats) return;
    this.statsTimer = window.setInterval(() => {
      void this.pollStats();
    }, 1000);
  }

  private async pollStats(): Promise<void> {
    const pc = this.pc;
    if (!pc || !this.watchedStreamerId || !this.callbacks.onStats) return;

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
}
