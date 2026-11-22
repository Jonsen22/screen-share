import { AppAudioBridge, AudioBridgeStatus, AudioCaptureTarget } from "../audio/app-audio";
import { SignalingClient, ServerMessage } from "./signaling";

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

export interface HostStartOptions {
  signalingUrl: string;
  nickname: string;
  preset: QualityPresetId;
  contentHint: ContentHintMode;
  audioTarget: AudioCaptureTarget;
}

export interface ConnectedViewer {
  id: string;
  nickname: string;
}

export interface HostCallbacks {
  onRoomCreated: (code: string, maxViewers: number, previewStream: MediaStream) => void;
  onStreamChanged: (previewStream: MediaStream) => void;
  onViewersChange: (viewers: ConnectedViewer[], maxViewers: number) => void;
  onEnded: (reason?: string) => void;
  onError: (message: string) => void;
}

interface ViewerPeer {
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

export class HostManager {
  private signaling = new SignalingClient();
  private audioBridge = new AppAudioBridge();
  private videoStream: MediaStream | null = null;
  private outboundStream: MediaStream | null = null;
  private videoEndedHandler: (() => void) | null = null;
  private peers = new Map<string, ViewerPeer>();
  private preset: PresetConfig = PRESETS["1080p30"];
  private contentHint: ContentHintMode = "motion";
  private maxViewers = 5;
  private active = false;
  private callbacks: HostCallbacks;

  constructor(callbacks: HostCallbacks) {
    this.callbacks = callbacks;
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
        void this.stop("Screen sharing ended from system controls.");
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

  async start(options: HostStartOptions): Promise<void> {
    if (this.active) return;

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

      await this.signaling.connect(options.signalingUrl);

      const roomInfo = await new Promise<{ code: string; maxViewers: number }>(
        (resolve, reject) => {
          const timer = window.setTimeout(() => {
            unsub();
            reject(new Error("Timed out waiting for room creation."));
          }, 8000);

          const unsub = this.signaling.onMessage((msg) => {
            if (msg.type === "room_created") {
              window.clearTimeout(timer);
              unsub();
              resolve({ code: msg.code, maxViewers: msg.maxViewers });
            } else if (msg.type === "error") {
              window.clearTimeout(timer);
              unsub();
              reject(new Error(msg.message));
            }
          });

          this.signaling.send({ type: "create_room", nickname: options.nickname });
        }
      );

      this.active = true;
      this.maxViewers = roomInfo.maxViewers;

      this.signaling.onMessage((msg) => this.handleServerMessage(msg));
      this.signaling.onClose((reason) => {
        if (this.active) {
          void this.stop(reason);
        }
      });

      this.attachVideoEndedHandler(videoTrack);

      this.callbacks.onRoomCreated(roomInfo.code, roomInfo.maxViewers, videoStream);
      this.emitViewersChange();
    } catch (err) {
      await this.cleanup();
      throw err;
    }
  }

  /**
   * Opens the Windows screen/window picker and seamlessly swaps the outgoing
   * video track on all connected viewers via RTCRtpSender.replaceTrack()
   * without closing or reconnecting the room.
   * Returns true if switched, false if the user cancelled the picker.
   */
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
        // User cancelled picker — keep existing stream running untouched
        return false;
      }
      throw new Error(`Failed to switch screen: ${String(err)}`);
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

    // Swap track on all active viewer peer connections seamlessly
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

    // Update outboundStream so any future viewers joining receive the new track
    if (this.outboundStream) {
      for (const oldTrack of this.outboundStream.getVideoTracks()) {
        this.outboundStream.removeTrack(oldTrack);
      }
      this.outboundStream.addTrack(nextTrack);
    }

    // Detach old ended handler BEFORE stopping old track so room stays open
    this.detachVideoEndedHandler(prevTrack);
    if (prevStream) {
      for (const t of prevStream.getTracks()) {
        t.stop();
      }
    }

    this.videoStream = nextStream;
    this.attachVideoEndedHandler(nextTrack);
    this.callbacks.onStreamChanged(nextStream);
    return true;
  }

  /**
   * Live-updates quality preset (bitrate/framerate/resolution constraints) and
   * encoding contentHint for all connected viewers without interrupting the room.
   */
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

  async stop(reason?: string): Promise<void> {
    if (!this.active) return;
    this.active = false;
    try {
      this.signaling.send({ type: "close_room" });
    } catch {
      // Ignore if socket already closed
    }
    await this.cleanup();
    this.callbacks.onEnded(reason);
  }

  private async cleanup(): Promise<void> {
    for (const peer of this.peers.values()) {
      peer.pc.close();
    }
    this.peers.clear();

    this.signaling.close();
    await this.audioBridge.dispose();

    const track = this.videoStream?.getVideoTracks()[0];
    this.detachVideoEndedHandler(track);

    if (this.videoStream) {
      for (const t of this.videoStream.getTracks()) {
        t.stop();
      }
      this.videoStream = null;
    }
    this.outboundStream = null;
  }

  kickViewer(viewerId: string): void {
    if (!this.active) return;
    if (!this.peers.has(viewerId)) return;
    try {
      this.signaling.send({ type: "kick_viewer", targetId: viewerId });
    } catch {
      // Ignore if socket already closed
    }
    this.removePeer(viewerId);
    this.emitViewersChange();
  }

  private emitViewersChange(): void {
    const viewers: ConnectedViewer[] = Array.from(this.peers.values()).map((peer) => ({
      id: peer.id,
      nickname: peer.nickname,
    }));
    this.callbacks.onViewersChange(viewers, this.maxViewers);
  }

  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "viewer_joined":
        void this.createPeerForViewer(msg.viewerId, msg.nickname || "Viewer");
        break;

      case "viewer_left":
        this.removePeer(msg.viewerId);
        this.emitViewersChange();
        break;

      case "signal":
        void this.handleSignal(msg.fromId, msg.payload);
        break;

      case "error":
        this.callbacks.onError(msg.message);
        break;
    }
  }

  private async createPeerForViewer(viewerId: string, nickname: string): Promise<void> {
    if (!this.outboundStream) return;
    this.removePeer(viewerId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry: ViewerPeer = {
      id: viewerId,
      nickname,
      pc,
      videoSender: null,
      pendingIce: [],
      remoteSet: false,
    };
    this.peers.set(viewerId, entry);
    this.emitViewersChange();

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
            targetId: viewerId,
            payload: { kind: "ice", candidate: event.candidate.toJSON() },
          });
        } catch {
          // Ignore send failure during teardown
        }
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.removePeer(viewerId);
        this.emitViewersChange();
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
        targetId: viewerId,
        payload: { kind: "offer", sdp: pc.localDescription! },
      });
    } catch (err) {
      this.callbacks.onError(`Failed to negotiate with viewer ${nickname}: ${String(err)}`);
      this.removePeer(viewerId);
      this.emitViewersChange();
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

  private async handleSignal(
    viewerId: string,
    payload: Extract<ServerMessage, { type: "signal" }>["payload"]
  ): Promise<void> {
    const entry = this.peers.get(viewerId);
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
      this.callbacks.onError(`Signaling error for viewer ${viewerId}: ${String(err)}`);
    }
  }

  private removePeer(viewerId: string): void {
    const entry = this.peers.get(viewerId);
    if (!entry) return;
    this.peers.delete(viewerId);
    try {
      entry.pc.close();
    } catch {
      // Ignore
    }
  }
}
