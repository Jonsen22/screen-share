// Stereo 48kHz f32 PCM Ring Buffer AudioWorkletProcessor
// Receives interleaved Float32 stereo chunks from Rust WASAPI Process Loopback.

const CAPACITY_FRAMES = 24000; // 500ms at 48kHz
const MAX_QUEUED_FRAMES = 5760; // 120ms max latency cap before trimming
const TARGET_TRIM_FRAMES = 1920; // 40ms target when trimming excess latency

class PcmRingBufferProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(CAPACITY_FRAMES);
    this.right = new Float32Array(CAPACITY_FRAMES);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.available = 0;
    this.muted = false;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg && msg.type === "mute") {
        this.muted = Boolean(msg.value);
        return;
      }
      if (msg && msg.type === "clear") {
        this.readIndex = 0;
        this.writeIndex = 0;
        this.available = 0;
        return;
      }

      // Raw ArrayBuffer containing interleaved stereo f32 samples (L, R, L, R, ...)
      if (msg instanceof ArrayBuffer) {
        const samples = new Float32Array(msg);
        const frameCount = samples.length >> 1;
        this.pushInterleaved(samples, frameCount);
      }
    };
  }

  pushInterleaved(samples, frameCount) {
    if (frameCount <= 0) return;

    // If buffer would overflow or drift beyond max latency, drop oldest frames
    if (this.available + frameCount > MAX_QUEUED_FRAMES) {
      const targetKeep = Math.min(TARGET_TRIM_FRAMES, CAPACITY_FRAMES - frameCount);
      if (this.available > targetKeep) {
        const drop = this.available - targetKeep;
        this.readIndex = (this.readIndex + drop) % CAPACITY_FRAMES;
        this.available -= drop;
      }
    }

    const toWrite = Math.min(frameCount, CAPACITY_FRAMES - this.available);
    let w = this.writeIndex;
    for (let i = 0; i < toWrite; i++) {
      this.left[w] = samples[i * 2];
      this.right[w] = samples[i * 2 + 1];
      w++;
      if (w === CAPACITY_FRAMES) w = 0;
    }
    this.writeIndex = w;
    this.available += toWrite;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outL = output[0];
    const outR = output[1] || output[0];
    const frames = outL.length;

    if (this.available === 0) {
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      return true;
    }

    const toRead = Math.min(frames, this.available);
    let r = this.readIndex;

    if (this.muted) {
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      r = (r + toRead) % CAPACITY_FRAMES;
    } else {
      for (let i = 0; i < toRead; i++) {
        outL[i] = this.left[r];
        if (outR !== outL) outR[i] = this.right[r];
        r++;
        if (r === CAPACITY_FRAMES) r = 0;
      }
      if (toRead < frames) {
        outL.fill(0, toRead);
        if (outR !== outL) outR.fill(0, toRead);
      }
    }

    this.readIndex = r;
    this.available -= toRead;
    return true;
  }
}

registerProcessor("pcm-ring-buffer", PcmRingBufferProcessor);
