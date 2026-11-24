import { AppAudioBridge, AudioBridgeStatus, AudioCaptureTarget } from "../audio/app-audio";
import { SignalingClient, SignalPayload } from "./signaling";

export type QualityPresetId = "720p30" | "1080p30" | "1080p60" | "source60";
export type ContentHintMode = "motion" | "detail";

interface PresetConfig {
  width?: number;
  height?: number;
  frameRate: number;
  maxBitrate: number;
}

const PRESETS: Record<QualityPresetId, PresetConfig> = {
  "720p30": { width: 1280, height: 720, frameRate: 30, maxBitrate: 2_500_000 },
  "1080p30": { width: 1920, height: 1080, frameRate: 30, maxBitrate: 4_500_000 },
  "1080p60": { width: 1920, height: 1080, frameRate: 60, maxBitrate: 8_000_000 },
  source60: { frameRate: 60, maxBitrate: 10_000_000 },
};

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export interface PublisherStartOptions {
  preset: QualityPresetId;
  contentHint: ContentHintMode;
  audioTarget: AudioCaptureTarget;
}

export interface StreamPublisherCallbacks {
  onStreamChanged?: (previewStream: MediaStream) => void;
  onUnexpectedTrackEnded?: () => void;
  onError?: (message: string) => void;
}

interface WatcherPeer {
  id: string;
  nickname: string;
  pc: RTCPeerConnection;
  videoSender: RTCRtpSender | null;
  pendingIce: RTCIceCandidateInit[];
  remoteSet: boolean;
}

function preferStereoOpus(sdp: string): string {
  const lines = sdp.split("\r\n");
  let opusPayload: string | null = null;
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+)\s+opus\/48000\/2/i.exec(line);
    if (m) {
      opusPayload = m[1];
      break;
    }
  }
  if (!opusPayload) return sdp;

  const fmtpPrefix = `a=fmtp:${opusPayload} `;
  let foundFmtp = false;
  const updated = lines.map((line) => {
    if (!line.startsWith(fmtpPrefix)) return line;
    foundFmtp = true;
    let next = line;
    if (!next.includes("stereo=1")) next += ";stereo=1";
    if (!next.includes("sprop-stereo=1")) next += ";sprop-stereo=1";
    if (!next.includes("maxaveragebitrate=")) next += ";maxaveragebitrate=128000";
    return next;
  });

  if (!foundFmtp) {
    const idx = updated.findIndex((l) => l.startsWith(`a=rtpmap:${opusPayload} `));
    if (idx >= 0) {
      updated.splice(
        idx + 1,
        0,
        `a=fmtp:${opusPayload} minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000`
      );
    }
  }
  return updated.join("\r\n");
}

export class StreamPublisher {
  private signaling: SignalingClient;
  private callbacks: StreamPublisherCallbacks;
  private audioBridge = new AppAudioBridge();
  private videoStream: MediaStream | null = null;
  private outboundStream: MediaStream | null = null;
  private videoEndedHandler: (() => void) | null = null;
  private peers = new Map<string, WatcherPeer>();
  private preset: PresetConfig = PRESETS["1080p30"];
  private contentHint: ContentHintMode = "motion";
  private selfId = "host";
  private active = false;

  constructor(signaling: SignalingClient, callbacks: StreamPublisherCallbacks = {}) {
    this.signaling = signaling;
    this.callbacks = callbacks;
  }

  setSelfId(selfId: string): void {
    this.selfId = selfId;
  }

  isActive(): boolean {
    return this.active;
  }

  getPreviewStream(): MediaStream | null {
    return this.videoStream;
  }

  private buildVideoConstraints(): MediaTrackConstraints {
    const constraints: MediaTrackConstraints = {
      frameRate: { ideal: this.preset.frameRate, max: this.preset.frameRate },
    };
    if (this.preset.width && this.preset.height) {
      constraints.width = { ideal: this.preset.width, max: this.preset.width };
      constraints.height = { ideal: this.preset.height, max: this.preset.height };
    }
    return constraints;
  }

  private attachVideoEndedHandler(track: MediaStreamTrack): void {
    const handler = () => {
      if (this.active && this.videoStream?.getVideoTracks()[0] === track) {
        this.callbacks.onUnexpectedTrackEnded?.();
      }
    };
    this.videoEndedHandler = handler;
    track.addEventListener("ended", handler);
  }

  private detachVideoEndedHandler(track: MediaStreamTrack | undefined): void {
    if (track && this.videoEndedHandler) {
      track.removeEventListener("ended", this.videoEndedHandler);
    }
    this.videoEndedHandler = null;
  }

  async start(options: PublisherStartOptions): Promise<MediaStream> {
    if (this.active && this.videoStream) {
      return this.videoStream;
    }

    this.preset = PRESETS[options.preset];
    this.contentHint = options.contentHint;

    // Initialize AudioContext BEFORE opening the async screen picker so it stays
    // unlocked by the user's click gesture in Chromium/WebView2.
    const audioTrack = await this.audioBridge.init();

    // Always capture video with audio: false so system audio is never leaked
    let videoStream: MediaStream;
    try {
      videoStream = await navigator.mediaDevices.getDisplayMedia({
        video: this.buildVideoConstraints(),
        audio: false,
      });
    } catch (err) {
      await this.audioBridge.dispose();
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "AbortError") {
        throw new Error("Screen capture was cancelled.");
      }
      throw new Error(`Failed to capture screen: ${String(err)}`);
    }

    const videoTrack = videoStream.getVideoTracks()[0];
    if (!videoTrack) {
      videoStream.getTracks().forEach((t) => t.stop());
      await this.audioBridge.dispose();
      throw new Error("No video track returned by screen picker.");
    }

    if ("contentHint" in videoTrack) {
      videoTrack.contentHint = options.contentHint;
    }

    this.videoStream = videoStream;

    try {
      await this.audioBridge.ensureRunning();
      if (options.audioTarget.kind !== "none") {
        await this.audioBridge.setTarget(options.audioTarget);
      }

      this.outboundStream = new MediaStream([videoTrack, audioTrack]);
      this.active = true;
      this.attachVideoEndedHandler(videoTrack);
      return videoStream;
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async switchScreen(): Promise<boolean> {
    if (!this.active) return false;

    let nextStream: MediaStream;
    try {
      nextStream = await navigator.mediaDevices.getDisplayMedia({
        video: this.buildVideoConstraints(),
        audio: false,
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "AbortError") {
        return false;
      }
      throw new Error(`Failed to switch screen: ${String(err)}`);
    }

    if (!this.active) {
      nextStream.getTracks().forEach((t) => t.stop());
      return false;
    }

    const nextTrack = nextStream.getVideoTracks()[0];
    if (!nextTrack) {
      nextStream.getTracks().forEach((t) => t.stop());
      throw new Error("No video track returned by screen picker.");
    }

    if ("contentHint" in nextTrack) {
      nextTrack.contentHint = this.contentHint;
    }

    const prevStream = this.videoStream;
    const prevTrack = prevStream?.getVideoTracks()[0];

    const replaceTasks: Promise<void>[] = [];
    for (const peer of this.peers.values()) {
      if (peer.videoSender) {
        const sender = peer.videoSender;
        replaceTasks.push(
          sender.replaceTrack(nextTrack).then(() => this.configureSender(sender, "video"))
        );
      }
    }
    await Promise.all(replaceTasks);

    if (this.outboundStream) {
      for (const oldTrack of this.outboundStream.getVideoTracks()) {
        this.outboundStream.removeTrack(oldTrack);
      }
      this.outboundStream.addTrack(nextTrack);
    }

    this.detachVideoEndedHandler(prevTrack);
    if (prevStream) {
      for (const t of prevStream.getTracks()) {
        t.stop();
      }
    }

    this.videoStream = nextStream;
    this.attachVideoEndedHandler(nextTrack);
    this.callbacks.onStreamChanged?.(nextStream);
    return true;
  }

  async updateQuality(presetId: QualityPresetId, contentHint: ContentHintMode): Promise<void> {
    this.preset = PRESETS[presetId];
    this.contentHint = contentHint;

    if (!this.active) return;

    const videoTrack = this.videoStream?.getVideoTracks()[0];
    if (videoTrack) {
      if ("contentHint" in videoTrack) {
        videoTrack.contentHint = contentHint;
      }
      try {
        await videoTrack.applyConstraints(this.buildVideoConstraints());
      } catch {
        // Some capture sources only apply new resolution constraints on next picker switch
      }
    }

    const tasks: Promise<void>[] = [];
    for (const peer of this.peers.values()) {
      if (peer.videoSender) {
        tasks.push(this.configureSender(peer.videoSender, "video"));
      }
    }
    await Promise.all(tasks);
  }

  async switchAudioTarget(target: AudioCaptureTarget): Promise<void> {
    if (!this.active) return;
    await this.audioBridge.setTarget(target);
  }

  setAudioMuted(muted: boolean): void {
    this.audioBridge.setMuted(muted);
  }

  isAudioMuted(): boolean {
    return this.audioBridge.isMuted();
  }

  setMonitorLocally(enabled: boolean): void {
    this.audioBridge.setMonitorLocally(enabled);
  }

  isMonitoringLocally(): boolean {
    return this.audioBridge.isMonitoringLocally();
  }

  getAudioStatus(): AudioBridgeStatus {
    return this.audioBridge.getStatus();
  }

  getAudioLevel(): number {
    return this.audioBridge.getLevel();
  }

  getVideoMeta(): string {
    const track = this.videoStream?.getVideoTracks()[0];
    if (!track) return "No video";
    const s = track.getSettings();
    const w = s.width ?? 0;
    const h = s.height ?? 0;
    const fps = s.frameRate ? Math.round(s.frameRate) : this.preset.frameRate;
    if (w && h) {
      return `${w}×${h} · ${fps} fps`;
    }
    return `${fps} fps`;
  }

  async addWatcher(watcherId: string, nickname: string): Promise<void> {
    if (!this.active || !this.outboundStream) return;
    if (watcherId === this.selfId) return;
    this.removeWatcher(watcherId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry: WatcherPeer = {
      id: watcherId,
      nickname,
      pc,
      videoSender: null,
      pendingIce: [],
      remoteSet: false,
    };
    this.peers.set(watcherId, entry);

    for (const track of this.outboundStream.getTracks()) {
      const sender = pc.addTrack(track, this.outboundStream);
      if (track.kind === "video") {
        entry.videoSender = sender;
      }
      void this.configureSender(sender, track.kind);
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        try {
          this.signaling.send({
            type: "signal",
            targetId: watcherId,
            streamId: this.selfId,
            payload: { kind: "ice", candidate: event.candidate.toJSON() },
          });
        } catch {
          // Ignore send failure during teardown
        }
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        if (this.peers.get(watcherId)?.pc === pc) {
          this.removeWatcher(watcherId);
        }
      }
    };

    try {
      const offer = await pc.createOffer();
      if (offer.sdp) {
        offer.sdp = preferStereoOpus(offer.sdp);
      }
      await pc.setLocalDescription(offer);
      this.signaling.send({
        type: "signal",
        targetId: watcherId,
        streamId: this.selfId,
        payload: { kind: "offer", sdp: pc.localDescription! },
      });
    } catch (err) {
      this.callbacks.onError?.(`Failed to negotiate with viewer ${nickname}: ${String(err)}`);
      this.removeWatcher(watcherId);
    }
  }

  removeWatcher(watcherId: string): void {
    const entry = this.peers.get(watcherId);
    if (!entry) return;
    this.peers.delete(watcherId);
    try {
      entry.pc.close();
    } catch {
      // Ignore
    }
  }

  async handleSignal(fromId: string, payload: SignalPayload): Promise<void> {
    const entry = this.peers.get(fromId);
    if (!entry) return;

    try {
      if (payload.kind === "answer") {
        await entry.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        entry.remoteSet = true;
        for (const cand of entry.pendingIce) {
          await entry.pc.addIceCandidate(new RTCIceCandidate(cand));
        }
        entry.pendingIce = [];
      } else if (payload.kind === "ice") {
        if (entry.remoteSet) {
          await entry.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } else {
          entry.pendingIce.push(payload.candidate);
        }
      }
    } catch (err) {
      this.callbacks.onError?.(`Signaling error for viewer ${fromId}: ${String(err)}`);
    }
  }

  private async configureSender(sender: RTCRtpSender, kind: string): Promise<void> {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      if (kind === "video") {
        params.encodings[0].maxBitrate = this.preset.maxBitrate;
        params.encodings[0].maxFramerate = this.preset.frameRate;
        params.degradationPreference =
          this.contentHint === "detail" ? "maintain-resolution" : "maintain-framerate";
      } else if (kind === "audio") {
        params.encodings[0].maxBitrate = 128_000;
      }
      await sender.setParameters(params);
    } catch {
      // Some WebView implementations ignore optional RTP params
    }
  }

  async stop(): Promise<void> {
    this.active = false;
    for (const peer of this.peers.values()) {
      try {
        peer.pc.close();
      } catch {
        // Ignore
      }
    }
    this.peers.clear();

    const track = this.videoStream?.getVideoTracks()[0];
    this.detachVideoEndedHandler(track);

    if (this.videoStream) {
      for (const t of this.videoStream.getTracks()) {
        t.stop();
      }
      this.videoStream = null;
    }
    this.outboundStream = null;

    await this.audioBridge.dispose();
  }
}
