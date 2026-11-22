import { Channel, invoke } from "@tauri-apps/api/core";

export interface AudioAppInfo {
  pid: number;
  processName: string;
  windowTitle: string;
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
  private destination: MediaStreamAudioDestinationNode | null = null;
  private meterBuffer: Float32Array<ArrayBuffer> | null = null;
  private activePid: number | null = null;
  private muted = false;

  async init(): Promise<MediaStreamTrack> {
    if (this.destination) {
      return this.destination.stream.getAudioTracks()[0];
    }

    const ctx = new AudioContext({
      sampleRate: 48000,
      latencyHint: "interactive",
    });
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
    worklet.connect(analyser);
    analyser.connect(destination);

    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    this.ctx = ctx;
    this.worklet = worklet;
    this.analyser = analyser;
    this.destination = destination;
    this.meterBuffer = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));

    return destination.stream.getAudioTracks()[0];
  }

  async setTargetPid(pid: number | null): Promise<void> {
    if (this.activePid === pid) return;

    if (isTauriRuntime()) {
      await invoke("stop_app_audio").catch(() => {});
    }
    this.worklet?.port.postMessage({ type: "clear" });
    this.activePid = null;

    if (pid === null) {
      return;
    }

    if (!isTauriRuntime()) {
      throw new Error("Per-application WASAPI audio capture requires the Tauri desktop app.");
    }

    if (!this.worklet) {
      await this.init();
    }
    if (this.ctx && this.ctx.state === "suspended") {
      await this.ctx.resume();
    }

    const channel = new Channel<ArrayBuffer | Uint8Array | number[]>();
    channel.onmessage = (chunk) => {
      if (!this.worklet) return;
      const buf = toArrayBuffer(chunk);
      if (buf && buf.byteLength >= 8) {
        this.worklet.port.postMessage(buf, [buf]);
      }
    };

    await invoke("start_app_audio", { pid, onAudio: channel });
    this.activePid = pid;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.worklet?.port.postMessage({ type: "mute", value: muted });
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Returns normalized RMS audio level [0..1] for the host UI meter. */
  getLevel(): number {
    if (!this.analyser || !this.meterBuffer || this.muted || this.activePid === null) {
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
    this.activePid = null;

    if (this.destination) {
      for (const track of this.destination.stream.getTracks()) {
        track.stop();
      }
      this.destination = null;
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
