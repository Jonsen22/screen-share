import { AudioBridgeStatus, AudioCaptureTarget } from "../audio/app-audio";
import {
  ContentHintMode,
  QualityPresetId,
  StreamPublisher,
} from "./publisher";
import {
  ActiveStreamInfo,
  ServerMessage,
  SignalingClient,
  signalingUrlToHealthUrl,
} from "./signaling";
import { StreamSubscriber } from "./subscriber";

export type { ContentHintMode, QualityPresetId } from "./publisher";

const RENDER_KEEPALIVE_MS = 10 * 60 * 1000; // 10 min (prevents 15-min Render free-tier sleep)

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
  onActiveStreamsChange?: (streams: ActiveStreamInfo[], watchedStreamerId: string | null) => void;
  onRemoteStream?: (stream: MediaStream | null, streamer: ActiveStreamInfo | null) => void;
  onRemoteBanner?: (text: string | null) => void;
  onSignalingStatus?: (status: "connected" | "reconnecting") => void;
  onEnded: (reason?: string) => void;
  onError: (message: string) => void;
}

export class HostManager {
  private signaling = new SignalingClient();
  private publisher: StreamPublisher;
  private subscriber: StreamSubscriber;
  private connectedViewers = new Map<string, ConnectedViewer>();
  private activeStreams = new Map<string, ActiveStreamInfo>();
  private signalingUrl = "";
  private hostNickname = "Host";
  private roomCode = "";
  private hostToken = "";
  private maxViewers = 5;
  private active = false;
  private reconnecting = false;
  private reconnectTimer: number | null = null;
  private healthKeepaliveTimer: number | null = null;
  private callbacks: HostCallbacks;

  constructor(callbacks: HostCallbacks) {
    this.callbacks = callbacks;

    this.publisher = new StreamPublisher(this.signaling, {
      onStreamChanged: (stream) => this.callbacks.onStreamChanged(stream),
      onUnexpectedTrackEnded: () => {
        if (this.active) {
          void this.stop("Screen sharing ended from system controls.");
        }
      },
      onError: (msg) => this.callbacks.onError(msg),
    });
    this.publisher.setSelfId("host");

    this.subscriber = new StreamSubscriber(this.signaling, {
      onStream: (stream) => {
        const watchedId = this.subscriber.getWatchedStreamerId();
        const info = watchedId ? this.activeStreams.get(watchedId) ?? null : null;
        this.callbacks.onRemoteStream?.(stream, info);
      },
      onBanner: (text) => this.callbacks.onRemoteBanner?.(text),
    });
  }

  async start(options: HostStartOptions): Promise<void> {
    if (this.active) return;

    this.signalingUrl = options.signalingUrl;
    this.hostNickname = options.nickname;

    const previewStream = await this.publisher.start({
      preset: options.preset,
      contentHint: options.contentHint,
      audioTarget: options.audioTarget,
    });

    try {
      await this.signaling.connect(options.signalingUrl);

      const roomInfo = await new Promise<{
        code: string;
        hostToken: string;
        maxViewers: number;
        activeStreams: ActiveStreamInfo[];
      }>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          unsub();
          reject(new Error("Timed out waiting for room creation."));
        }, 8000);

        const unsub = this.signaling.onMessage((msg) => {
          if (msg.type === "room_created") {
            window.clearTimeout(timer);
            unsub();
            resolve({
              code: msg.code,
              hostToken: msg.hostToken || "",
              maxViewers: msg.maxViewers,
              activeStreams: msg.activeStreams || [
                { streamerId: "host", nickname: options.nickname },
              ],
            });
          } else if (msg.type === "error") {
            window.clearTimeout(timer);
            unsub();
            reject(new Error(msg.message));
          }
        });

        this.signaling.send({ type: "create_room", nickname: options.nickname });
      });

      this.active = true;
      this.roomCode = roomInfo.code;
      this.hostToken = roomInfo.hostToken;
      this.maxViewers = roomInfo.maxViewers;
      this.connectedViewers.clear();
      this.syncActiveStreams(roomInfo.activeStreams);

      this.signaling.onMessage((msg) => this.handleServerMessage(msg));
      this.signaling.onClose(() => {
        if (this.active) {
          this.scheduleSignalingReconnect();
        }
      });

      this.startHealthKeepalive();

      this.callbacks.onRoomCreated(roomInfo.code, roomInfo.maxViewers, previewStream);
      this.callbacks.onSignalingStatus?.("connected");
      this.emitViewersChange();
      this.emitActiveStreamsChange();
    } catch (err) {
      await this.cleanup();
      throw err;
    }
  }

  private syncActiveStreams(list: ActiveStreamInfo[] | undefined): void {
    this.activeStreams.clear();
    if (list && list.length > 0) {
      for (const s of list) {
        this.activeStreams.set(s.streamerId, s);
      }
    } else if (this.active) {
      this.activeStreams.set("host", { streamerId: "host", nickname: this.hostNickname });
    }
  }

  private emitActiveStreamsChange(): void {
    this.callbacks.onActiveStreamsChange?.(
      Array.from(this.activeStreams.values()),
      this.subscriber.getWatchedStreamerId()
    );
  }

  watchStream(streamerId: string): void {
    if (!this.active) return;
    if (streamerId === "host") {
      this.stopWatching(true);
      return;
    }
    const info = this.activeStreams.get(streamerId);
    if (!info) return;
    this.subscriber.watch(streamerId, info.nickname);
    this.emitActiveStreamsChange();
  }

  stopWatching(notifyServer = true): void {
    this.subscriber.stopWatching(notifyServer);
    this.callbacks.onRemoteBanner?.(null);
    this.emitActiveStreamsChange();
  }

  getWatchedStreamerId(): string | null {
    return this.subscriber.getWatchedStreamerId();
  }

  private startHealthKeepalive(): void {
    this.stopHealthKeepalive();
    const healthUrl = signalingUrlToHealthUrl(this.signalingUrl);
    if (!healthUrl) return;

    this.healthKeepaliveTimer = window.setInterval(() => {
      if (!this.active) return;
      void fetch(healthUrl, { method: "GET", cache: "no-store" }).catch(() => {});
    }, RENDER_KEEPALIVE_MS);
  }

  private stopHealthKeepalive(): void {
    if (this.healthKeepaliveTimer !== null) {
      window.clearInterval(this.healthKeepaliveTimer);
      this.healthKeepaliveTimer = null;
    }
  }

  private scheduleSignalingReconnect(delayMs = 2000): void {
    if (!this.active || this.reconnecting) return;
    this.reconnecting = true;
    this.callbacks.onSignalingStatus?.("reconnecting");

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
        if (this.hostToken) {
          this.signaling.send({
            type: "reclaim_room",
            code: this.roomCode,
            hostToken: this.hostToken,
            nickname: this.hostNickname,
            isStreaming: this.publisher.isActive(),
          });
        }
        this.reconnecting = false;
        this.callbacks.onSignalingStatus?.("connected");
      } catch {
        if (!this.active) {
          this.reconnecting = false;
          return;
        }
        const nextDelay = Math.min(currentDelay * 2, 15_000);
        this.reconnectTimer = window.setTimeout(() => {
          void attempt(nextDelay);
        }, currentDelay);
      }
    };

    this.reconnectTimer = window.setTimeout(() => {
      void attempt(delayMs);
    }, delayMs);
  }

  async switchScreen(): Promise<boolean> {
    if (!this.active) return false;
    return this.publisher.switchScreen();
  }

  async updateQuality(presetId: QualityPresetId, contentHint: ContentHintMode): Promise<void> {
    await this.publisher.updateQuality(presetId, contentHint);
  }

  async switchAudioTarget(target: AudioCaptureTarget): Promise<void> {
    if (!this.active) return;
    await this.publisher.switchAudioTarget(target);
  }

  setAudioMuted(muted: boolean): void {
    this.publisher.setAudioMuted(muted);
  }

  isAudioMuted(): boolean {
    return this.publisher.isAudioMuted();
  }

  setMonitorLocally(enabled: boolean): void {
    this.publisher.setMonitorLocally(enabled);
  }

  isMonitoringLocally(): boolean {
    return this.publisher.isMonitoringLocally();
  }

  getAudioStatus(): AudioBridgeStatus {
    return this.publisher.getAudioStatus();
  }

  getAudioLevel(): number {
    return this.publisher.getAudioLevel();
  }

  getVideoMeta(): string {
    return this.publisher.getVideoMeta();
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
    this.reconnecting = false;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHealthKeepalive();

    this.subscriber.stopWatching(false);
    await this.publisher.stop();
    this.connectedViewers.clear();
    this.activeStreams.clear();
    this.signaling.close();

    this.roomCode = "";
    this.hostToken = "";
  }

  kickViewer(viewerId: string): void {
    if (!this.active) return;
    if (!this.connectedViewers.has(viewerId)) return;
    try {
      this.signaling.send({ type: "kick_viewer", targetId: viewerId });
    } catch {
      // Ignore if socket already closed
    }
    this.connectedViewers.delete(viewerId);
    this.publisher.removeWatcher(viewerId);
    if (this.subscriber.getWatchedStreamerId() === viewerId) {
      this.stopWatching(false);
    }
    this.emitViewersChange();
  }

  banViewer(viewerId: string): void {
    if (!this.active) return;
    if (!this.connectedViewers.has(viewerId)) return;
    try {
      this.signaling.send({ type: "ban_viewer", targetId: viewerId });
    } catch {
      // Ignore if socket already closed
    }
    this.connectedViewers.delete(viewerId);
    this.publisher.removeWatcher(viewerId);
    if (this.subscriber.getWatchedStreamerId() === viewerId) {
      this.stopWatching(false);
    }
    this.emitViewersChange();
  }

  private emitViewersChange(): void {
    this.callbacks.onViewersChange(
      Array.from(this.connectedViewers.values()),
      this.maxViewers
    );
  }

  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "room_reclaimed":
        this.callbacks.onSignalingStatus?.("connected");
        this.syncActiveStreams(msg.activeStreams);
        if (
          this.subscriber.getWatchedStreamerId() &&
          !this.activeStreams.has(this.subscriber.getWatchedStreamerId()!)
        ) {
          this.stopWatching(false);
        }
        this.emitViewersChange();
        this.emitActiveStreamsChange();
        break;

      case "viewer_joined":
        this.connectedViewers.set(msg.viewerId, {
          id: msg.viewerId,
          nickname: msg.nickname || "Viewer",
        });
        this.emitViewersChange();
        break;

      case "viewer_left":
        this.connectedViewers.delete(msg.viewerId);
        if (msg.explicit || msg.kicked || msg.banned) {
          this.publisher.removeWatcher(msg.viewerId);
        }
        this.emitViewersChange();
        break;

      case "viewer_watching":
        void this.publisher.addWatcher(msg.viewerId, msg.nickname || "Viewer");
        break;

      case "viewer_unwatching":
        this.publisher.removeWatcher(msg.viewerId);
        break;

      case "stream_started":
        this.activeStreams.set(msg.streamerId, {
          streamerId: msg.streamerId,
          nickname: msg.nickname,
        });
        this.emitActiveStreamsChange();
        break;

      case "stream_stopped":
        this.activeStreams.delete(msg.streamerId);
        if (this.subscriber.getWatchedStreamerId() === msg.streamerId) {
          this.stopWatching(false);
        } else {
          this.emitActiveStreamsChange();
        }
        break;

      case "signal": {
        const streamId = msg.streamId || "host";
        if (streamId === "host") {
          void this.publisher.handleSignal(msg.fromId, msg.payload);
        } else if (streamId === this.subscriber.getWatchedStreamerId()) {
          void this.subscriber.handleSignal(msg.fromId, msg.payload);
        }
        break;
      }

      case "error":
        this.callbacks.onError(msg.message);
        break;
    }
  }
}
