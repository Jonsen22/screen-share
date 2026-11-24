import { AudioBridgeStatus } from "../audio/app-audio";
import { PublisherStartOptions, StreamPublisher } from "./publisher";
import { ActiveStreamInfo, ServerMessage, SignalingClient } from "./signaling";
import { StreamSubscriber, ViewerStats } from "./subscriber";

export type { ViewerStats } from "./subscriber";

export interface ViewerCallbacks {
  onJoined: (code: string, hostNickname: string, viewerId: string) => void;
  onStream: (stream: MediaStream | null) => void;
  onLocalPreviewChange?: (stream: MediaStream | null, sharing: boolean) => void;
  onActiveStreamsChange?: (
    streams: ActiveStreamInfo[],
    watchedStreamerId: string | null,
    selfId: string,
    isSharing: boolean
  ) => void;
  onBanner: (text: string | null) => void;
  onStats: (stats: ViewerStats) => void;
  onEnded: (reason?: string) => void;
  onShareError?: (message: string) => void;
}

export class ViewerManager {
  private signaling = new SignalingClient();
  private subscriber: StreamSubscriber;
  private publisher: StreamPublisher;
  private activeStreams = new Map<string, ActiveStreamInfo>();
  private reconnectTimer: number | null = null;
  private reconnecting = false;
  private signalingUrl = "";
  private roomCode = "";
  private viewerId = "";
  private viewerToken = "";
  private viewerNickname = "Viewer";
  private active = false;
  private sharing = false;
  private viewingSelfPreview = false;
  private callbacks: ViewerCallbacks;

  constructor(callbacks: ViewerCallbacks) {
    this.callbacks = callbacks;

    this.subscriber = new StreamSubscriber(this.signaling, {
      onStream: (stream) => this.callbacks.onStream(stream),
      onBanner: (text) => this.callbacks.onBanner(text),
      onStats: (stats) => this.callbacks.onStats(stats),
    });

    this.publisher = new StreamPublisher(this.signaling, {
      onStreamChanged: (stream) => {
        if (this.sharing) {
          this.callbacks.onLocalPreviewChange?.(stream, true);
        }
      },
      onUnexpectedTrackEnded: () => {
        if (this.sharing) {
          void this.stopSharing();
        }
      },
      onError: (msg) => this.callbacks.onShareError?.(msg),
    });
  }

  getSelfId(): string {
    return this.viewerId;
  }

  isSharing(): boolean {
    return this.sharing;
  }

  getWatchedStreamerId(): string | null {
    if (this.viewingSelfPreview) return this.viewerId;
    return this.subscriber.getWatchedStreamerId();
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
        activeStreams: ActiveStreamInfo[];
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
              activeStreams: msg.activeStreams || [
                { streamerId: "host", nickname: msg.hostNickname || "Host" },
              ],
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
      this.sharing = false;
      this.viewingSelfPreview = false;
      this.publisher.setSelfId(joined.viewerId);

      this.syncActiveStreams(joined.activeStreams);

      this.signaling.onMessage((msg) => this.handleServerMessage(msg));
      this.signaling.onClose(() => {
        if (this.active) {
          this.scheduleSignalingReattach();
        }
      });

      this.callbacks.onJoined(joined.code, joined.hostNickname, joined.viewerId);

      const firstStream = Array.from(this.activeStreams.values()).find(
        (s) => s.streamerId !== this.viewerId
      );
      if (firstStream) {
        this.watchStream(firstStream.streamerId);
      } else {
        this.callbacks.onBanner("Waiting for someone to share their screen...");
        this.emitActiveStreamsChange();
      }
    } catch (err) {
      await this.cleanup();
      throw err;
    }
  }

  private syncActiveStreams(list: ActiveStreamInfo[] | undefined): void {
    this.activeStreams.clear();
    if (list) {
      for (const s of list) {
        this.activeStreams.set(s.streamerId, s);
      }
    }
    if (this.sharing && this.viewerId) {
      this.activeStreams.set(this.viewerId, {
        streamerId: this.viewerId,
        nickname: this.viewerNickname,
      });
    }
  }

  private emitActiveStreamsChange(): void {
    this.callbacks.onActiveStreamsChange?.(
      Array.from(this.activeStreams.values()),
      this.getWatchedStreamerId(),
      this.viewerId,
      this.sharing
    );
  }

  watchStream(streamerId: string): void {
    if (!this.active) return;
    if (streamerId === this.viewerId) {
      if (!this.sharing) return;
      this.subscriber.stopWatching(true);
      this.viewingSelfPreview = true;
      this.callbacks.onBanner(null);
      this.emitActiveStreamsChange();
      return;
    }

    const info = this.activeStreams.get(streamerId);
    if (!info) return;
    this.viewingSelfPreview = false;
    this.subscriber.watch(streamerId, info.nickname);
    this.emitActiveStreamsChange();
  }

  stopWatching(notifyServer = true): void {
    this.viewingSelfPreview = false;
    this.subscriber.stopWatching(notifyServer);
    this.emitActiveStreamsChange();
  }

  async startSharing(options: PublisherStartOptions): Promise<MediaStream> {
    if (!this.active) {
      throw new Error("Join a room before sharing your screen.");
    }
    if (this.sharing && this.publisher.getPreviewStream()) {
      return this.publisher.getPreviewStream()!;
    }

    this.publisher.setSelfId(this.viewerId);
    const previewStream = await this.publisher.start(options);
    if (!this.active) {
      await this.publisher.stop();
      throw new Error("Left room before screen sharing started.");
    }
    this.sharing = true;

    try {
      this.signaling.send({ type: "start_stream" });
    } catch {
      // Will re-announce on reattach if socket briefly disconnected
    }

    this.activeStreams.set(this.viewerId, {
      streamerId: this.viewerId,
      nickname: this.viewerNickname,
    });
    this.callbacks.onLocalPreviewChange?.(previewStream, true);
    this.emitActiveStreamsChange();
    return previewStream;
  }

  async stopSharing(): Promise<void> {
    if (!this.sharing) return;
    this.sharing = false;

    try {
      this.signaling.send({ type: "stop_stream" });
    } catch {
      // Ignore if socket already closed
    }

    await this.publisher.stop();
    this.activeStreams.delete(this.viewerId);
    this.callbacks.onLocalPreviewChange?.(null, false);

    if (this.viewingSelfPreview) {
      this.viewingSelfPreview = false;
      const other = Array.from(this.activeStreams.values()).find(
        (s) => s.streamerId !== this.viewerId
      );
      if (other) {
        this.subscriber.watch(other.streamerId, other.nickname);
      } else {
        this.callbacks.onBanner("Waiting for someone to share their screen...");
      }
    }

    this.emitActiveStreamsChange();
  }

  async switchSharedScreen(): Promise<boolean> {
    if (!this.active || !this.sharing) return false;
    return this.publisher.switchScreen();
  }

  setSharedAudioMuted(muted: boolean): void {
    this.publisher.setAudioMuted(muted);
  }

  isSharedAudioMuted(): boolean {
    return this.publisher.isAudioMuted();
  }

  getSharedAudioStatus(): AudioBridgeStatus {
    return this.publisher.getAudioStatus();
  }

  getSharedAudioLevel(): number {
    return this.publisher.getAudioLevel();
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
      if (this.sharing) {
        try {
          this.signaling.send({ type: "stop_stream" });
        } catch {
          // Ignore
        }
      }
      try {
        this.signaling.send({ type: "leave_room" });
      } catch {
        // Ignore
      }
    }
    void this.cleanup();
    this.callbacks.onEnded(reason);
  }

  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "reattached": {
        this.syncActiveStreams(msg.activeStreams);
        if (this.sharing) {
          try {
            this.signaling.send({ type: "start_stream" });
          } catch {
            // Ignore
          }
        }
        const watched = this.subscriber.getWatchedStreamerId();
        if (watched && !this.activeStreams.has(watched)) {
          this.subscriber.stopWatching(false);
          this.callbacks.onBanner(
            this.activeStreams.size > 0
              ? "Stream ended — pick another live stream above."
              : "Waiting for someone to share their screen..."
          );
        }
        this.emitActiveStreamsChange();
        break;
      }

      case "stream_started":
        this.activeStreams.set(msg.streamerId, {
          streamerId: msg.streamerId,
          nickname: msg.nickname,
        });
        if (
          !this.subscriber.getWatchedStreamerId() &&
          !this.viewingSelfPreview &&
          msg.streamerId !== this.viewerId
        ) {
          this.subscriber.watch(msg.streamerId, msg.nickname);
        }
        this.emitActiveStreamsChange();
        break;

      case "stream_stopped":
        this.activeStreams.delete(msg.streamerId);
        if (this.subscriber.getWatchedStreamerId() === msg.streamerId) {
          this.subscriber.stopWatching(false);
          this.callbacks.onBanner(
            this.activeStreams.size > 0
              ? "Stream ended — pick another live stream above."
              : "Waiting for someone to share their screen..."
          );
        }
        this.emitActiveStreamsChange();
        break;

      case "viewer_watching":
        if (this.sharing) {
          void this.publisher.addWatcher(msg.viewerId, msg.nickname || "Viewer");
        }
        break;

      case "viewer_unwatching":
        if (this.sharing) {
          this.publisher.removeWatcher(msg.viewerId);
        }
        break;

      case "signal": {
        const streamId = msg.streamId || "host";
        if (streamId === this.viewerId && this.sharing) {
          void this.publisher.handleSignal(msg.fromId, msg.payload);
        } else if (streamId === this.subscriber.getWatchedStreamerId()) {
          void this.subscriber.handleSignal(msg.fromId, msg.payload);
        }
        break;
      }

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

  private async cleanup(): Promise<void> {
    this.reconnecting = false;
    this.sharing = false;
    this.viewingSelfPreview = false;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.subscriber.stopWatching(false);
    this.callbacks.onLocalPreviewChange?.(null, false);
    this.signaling.close();
    this.activeStreams.clear();
    this.roomCode = "";
    this.viewerId = "";
    this.viewerToken = "";

    await this.publisher.stop();
  }
}
