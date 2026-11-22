import { Channel, invoke } from "@tauri-apps/api/core";

export interface AudioAppInfo {
  pid: number;
  processName: string;
  windowTitle: string;
  hasAudioSession: boolean;
  isPlayingAudio: boolean;
}

export interface DiscordProcessInfo {
  pid: number;
  processName: string;
}

export type AudioCaptureTarget =
  | { kind: "none" }
  | { kind: "include_pid"; pid: number }
  | { kind: "exclude_discord" };

export interface AudioBridgeStatus {
  state: "off" | "suspended" | "waiting" | "capturing";
  label: string;
  chunksReceived: number;
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function listAudioApps(): Promise<AudioAppInfo[]> {
  if (!isTauriRuntime()) {
    return [];
  }
  return invoke<AudioAppInfo[]>("list_audio_apps");
}

export async function findDiscordApp(): Promise<DiscordProcessInfo | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  return invoke<DiscordProcessInfo | null>("find_discord_app");
}

function toArrayBuffer(chunk: ArrayBuffer | Uint8Array | number[]): ArrayBuffer | null {
  if (chunk instanceof ArrayBuffer) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength) {
      return chunk.buffer as ArrayBuffer;
    }
    return chunk.slice().buffer;
  }
  if (Array.isArray(chunk)) {
    return new Uint8Array(chunk).buffer;
  }
  return null;
}

/**
 * Bridges Windows WASAPI Process Loopback PCM chunks from Rust into a live
 * WebRTC-compatible stereo 48kHz MediaStreamTrack via AudioWorkletNode.
 *
 * The output MediaStreamTrack stays stable across audio source switches, so
 * the host can change or disable the target application mid-stream without
 * renegotiating WebRTC peers.
 */
export class AppAudioBridge {
  private ctx: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private monitorGain: GainNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private meterBuffer: Float32Array<ArrayBuffer> | null = null;
  private activeTarget: AudioCaptureTarget = { kind: "none" };
  private muted = false;
  private monitoringLocally = false;
  private chunksReceived = 0;
  private lastChunkAt = 0;

  async init(): Promise<MediaStreamTrack> {
    if (this.destination) {
      await this.ensureRunning();
      return this.destination.stream.getAudioTracks()[0];
    }

    const ctx = new AudioContext({
      sampleRate: 48000,
      latencyHint: "interactive",
    });

    // Resume immediately while still inside the user's click gesture
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }

    await ctx.audioWorklet.addModule("/pcm-worklet.js");

    const worklet = new AudioWorkletNode(ctx, "pcm-ring-buffer", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;

    const destination = ctx.createMediaStreamDestination();

    // Always connect a 0-gain monitor branch to ctx.destination so Chromium/WebView2
    // keeps the AudioWorklet render graph clocked even when 0 viewers are connected,
    // and allows toggling local test monitoring on demand.
    const monitorGain = ctx.createGain();
    monitorGain.gain.value = 0;

    worklet.connect(analyser);
    analyser.connect(destination);
    analyser.connect(monitorGain);
    monitorGain.connect(ctx.destination);

    if (ctx.state === "suspended") {
      await ctx.resume().catch(() => {});
    }

    this.ctx = ctx;
    this.worklet = worklet;
    this.analyser = analyser;
    this.monitorGain = monitorGain;
    this.destination = destination;
    this.meterBuffer = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));

    return destination.stream.getAudioTracks()[0];
  }

  async ensureRunning(): Promise<void> {
    if (this.ctx && this.ctx.state === "suspended") {
      await this.ctx.resume().catch(() => {});
    }
  }

  private isSameTarget(a: AudioCaptureTarget, b: AudioCaptureTarget): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === "include_pid" && b.kind === "include_pid") {
      return a.pid === b.pid;
    }
    return true;
  }

  async setTarget(target: AudioCaptureTarget): Promise<void> {
    if (this.isSameTarget(this.activeTarget, target)) return;

    if (isTauriRuntime()) {
      await invoke("stop_app_audio").catch(() => {});
    }
    this.worklet?.port.postMessage({ type: "clear" });
    this.activeTarget = { kind: "none" };
    this.chunksReceived = 0;
    this.lastChunkAt = 0;

    if (target.kind === "none") {
      return;
    }

    if (!isTauriRuntime()) {
      throw new Error("Windows WASAPI audio capture requires the Tauri desktop app.");
    }

    if (!this.worklet) {
      await this.init();
    }
    await this.ensureRunning();

    const channel = new Channel<ArrayBuffer | Uint8Array | number[]>();
    channel.onmessage = (chunk) => {
      if (!this.worklet) return;
      const buf = toArrayBuffer(chunk);
      if (buf && buf.byteLength >= 8) {
        this.chunksReceived++;
        this.lastChunkAt = performance.now();
        this.worklet.port.postMessage(buf, [buf]);
      }
    };

    if (target.kind === "exclude_discord") {
      await invoke("start_app_audio", { pid: null, exclude: true, onAudio: channel });
    } else {
      await invoke("start_app_audio", { pid: target.pid, exclude: false, onAudio: channel });
    }
    this.activeTarget = target;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.worklet?.port.postMessage({ type: "mute", value: muted });
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMonitorLocally(enabled: boolean): void {
    this.monitoringLocally = enabled;
    if (this.monitorGain && this.ctx) {
      void this.ensureRunning();
      this.monitorGain.gain.setTargetAtTime(enabled ? 0.75 : 0, this.ctx.currentTime, 0.015);
    }
  }

  isMonitoringLocally(): boolean {
    return this.monitoringLocally;
  }

  getStatus(): AudioBridgeStatus {
    if (this.activeTarget.kind === "none") {
      return { state: "off", label: "Audio off", chunksReceived: 0 };
    }
    if (this.ctx && this.ctx.state !== "running") {
      return {
        state: "suspended",
        label: "Audio engine paused — click Test Sound to wake",
        chunksReceived: this.chunksReceived,
      };
    }
    const isExcludeDiscord = this.activeTarget.kind === "exclude_discord";
    const recentlyActive = this.lastChunkAt > 0 && performance.now() - this.lastChunkAt < 1200;
    if (recentlyActive) {
      const modeLabel = isExcludeDiscord
        ? "All PC (Discord excluded) · 48 kHz"
        : "Capturing · 48 kHz stereo";
      return {
        state: "capturing",
        label: this.muted ? "Capturing (muted)" : modeLabel,
        chunksReceived: this.chunksReceived,
      };
    }
    return {
      state: "waiting",
      label: isExcludeDiscord
        ? "Connected — waiting for PC sound..."
        : "Connected — waiting for app sound...",
      chunksReceived: this.chunksReceived,
    };
  }

  /** Returns normalized RMS audio level [0..1] for the host UI meter. */
  getLevel(): number {
    if (!this.analyser || !this.meterBuffer || this.muted || this.activeTarget.kind === "none") {
      return 0;
    }
    this.analyser.getFloatTimeDomainData(this.meterBuffer);
    let sum = 0;
    for (let i = 0; i < this.meterBuffer.length; i++) {
      const s = this.meterBuffer[i];
      sum += s * s;
    }
    const rms = Math.sqrt(sum / this.meterBuffer.length);
    return Math.min(1, rms * 3.5);
  }

  async dispose(): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("stop_app_audio").catch(() => {});
    }
    this.activeTarget = { kind: "none" };
    this.monitoringLocally = false;
    this.chunksReceived = 0;
    this.lastChunkAt = 0;

    if (this.destination) {
      for (const track of this.destination.stream.getTracks()) {
        track.stop();
      }
      this.destination = null;
    }
    if (this.monitorGain) {
      this.monitorGain.disconnect();
      this.monitorGain = null;
    }
    if (this.worklet) {
      this.worklet.disconnect();
      this.worklet = null;
    }
    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
    }
    if (this.ctx) {
      await this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.meterBuffer = null;
  }
}
