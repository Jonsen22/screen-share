export type SignalPayload =
  | { kind: "offer"; sdp: RTCSessionDescriptionInit }
  | { kind: "answer"; sdp: RTCSessionDescriptionInit }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

export interface ActiveStreamInfo {
  streamerId: string;
  nickname: string;
}

export type ServerMessage =
  | { type: "pong" }
  | {
      type: "room_created";
      code: string;
      hostToken?: string;
      maxViewers: number;
      activeStreams?: ActiveStreamInfo[];
    }
  | {
      type: "room_reclaimed";
      code: string;
      maxViewers: number;
      viewerCount: number;
      activeStreams?: ActiveStreamInfo[];
    }
  | {
      type: "joined_room";
      code: string;
      viewerId: string;
      viewerToken?: string;
      hostNickname?: string;
      viewerCount: number;
      maxViewers: number;
      activeStreams?: ActiveStreamInfo[];
    }
  | {
      type: "reattached";
      code: string;
      viewerId: string;
      activeStreams?: ActiveStreamInfo[];
    }
  | { type: "viewer_joined"; viewerId: string; nickname?: string; viewerCount: number }
  | {
      type: "viewer_left";
      viewerId: string;
      nickname?: string;
      viewerCount: number;
      kicked?: boolean;
      banned?: boolean;
      explicit?: boolean;
    }
  | { type: "stream_started"; streamerId: string; nickname: string }
  | { type: "stream_stopped"; streamerId: string }
  | { type: "viewer_watching"; viewerId: string; nickname?: string; streamerId?: string }
  | { type: "viewer_unwatching"; viewerId: string; streamerId?: string }
  | { type: "kicked"; reason: string }
  | { type: "banned"; reason: string }
  | { type: "room_closed"; reason: string }
  | { type: "signal"; fromId: string; streamId?: string; payload: SignalPayload }
  | { type: "error"; code: string; message: string };

export function normalizeSignalingUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("https://")) {
    return "wss://" + trimmed.slice("https://".length);
  }
  if (trimmed.startsWith("http://")) {
    return "ws://" + trimmed.slice("http://".length);
  }
  return trimmed;
}

export function signalingUrlToHealthUrl(raw: string): string | null {
  const wsUrl = normalizeSignalingUrl(raw);
  if (wsUrl.startsWith("wss://")) {
    return "https://" + wsUrl.slice("wss://".length) + "/health";
  }
  if (wsUrl.startsWith("ws://")) {
    return "http://" + wsUrl.slice("ws://".length) + "/health";
  }
  return null;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<(msg: ServerMessage) => void>();
  private closeListeners = new Set<(reason: string) => void>();
  private pingTimer: number | null = null;
  private intentionalClose = false;

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  async connect(rawUrl: string, timeoutMs = 65000): Promise<void> {
    this.closeSocketOnly();
    this.intentionalClose = false;
    const url = normalizeSignalingUrl(rawUrl);

    return new Promise((resolve, reject) => {
      let settled = false;
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (err) {
        reject(new Error(`Invalid signaling server URL: ${String(err)}`));
        return;
      }

      const timer = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.close();
          reject(new Error(`Timed out connecting to signaling server (${url}).`));
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
          reject(new Error(`Could not connect to signaling server (${url}). Is it running?`));
        }
      };

      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data)) as ServerMessage;
          if (parsed.type === "pong") return;
          for (const listener of this.listeners) {
            listener(parsed);
          }
        } catch {
          // Ignore malformed frames
        }
      };

      socket.onclose = () => {
        if (this.ws === socket) {
          this.ws = null;
          this.stopKeepalive();
        }
        if (!this.intentionalClose && settled) {
          for (const listener of this.closeListeners) {
            listener("Disconnected from signaling server.");
          }
        }
      };
    });
  }

  onMessage(handler: (msg: ServerMessage) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  onClose(handler: (reason: string) => void): () => void {
    this.closeListeners.add(handler);
    return () => this.closeListeners.delete(handler);
  }

  send(msg: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Signaling socket is not connected.");
    }
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.intentionalClose = true;
    this.closeSocketOnly();
    this.listeners.clear();
    this.closeListeners.clear();
  }

  private closeSocketOnly(): void {
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

  private startKeepalive(): void {
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

  private stopKeepalive(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
