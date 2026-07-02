/**
 * Input controller: opens the selected input device once and keeps it live so we
 * can show a real-time level meter and monitor, then captures PCM (via an
 * AudioWorklet on the editor's AudioContext) when recording.
 */

import type { EditorEngine } from './engine';

export interface RecordingResult {
  channels: Float32Array[];
  sampleRate: number;
}

/** Down-sampled peaks captured so far, for drawing the live recording waveform. */
export interface LivePeaks {
  peaks: number[]; // one absolute-peak value (0..1) per PEAK_BUCKET samples
  bucketSec: number; // seconds each peak spans
}

const PEAK_BUCKET = 1024;

export class InputController {
  private engine: EditorEngine;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private meterBuf: Float32Array<ArrayBuffer> | null = null;
  private worklet: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private frames: Float32Array[][] = [];
  private numChannels = 1;
  private capturing = false;
  private moduleLoaded = false;
  private livePeakArr: number[] = [];
  private curPeak = 0;
  private curCount = 0;
  deviceId: string | null = null;

  constructor(engine: EditorEngine) {
    this.engine = engine;
  }

  get isOpen(): boolean {
    return !!this.stream;
  }
  get isCapturing(): boolean {
    return this.capturing;
  }

  /** Open (or switch to) an input device and start metering + monitoring. */
  async open(deviceId: string | null, monitor: boolean): Promise<void> {
    const ctx = this.engine.ctx;
    await ctx.resume();
    if (this.stream && this.deviceId === deviceId) {
      this.engine.setMonitorEnabled(monitor);
      return;
    }
    this.closeStream();
    if (!this.moduleLoaded) {
      await ctx.audioWorklet.addModule('/worklets/recorder-processor.js');
      this.moduleLoaded = true;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.deviceId = deviceId;
    this.source = ctx.createMediaStreamSource(this.stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.meterBuf = new Float32Array(this.analyser.fftSize);
    this.source.connect(this.analyser);
    this.source.connect(this.engine.monitorGain);
    this.engine.setMonitorEnabled(monitor);
  }

  setMonitor(on: boolean) {
    this.engine.setMonitorEnabled(on);
  }

  /** Current input level (0..1, ~peak of RMS). Returns 0 if no input. */
  getLevel(): number {
    if (!this.analyser || !this.meterBuf) return 0;
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const v = this.meterBuf[i]!;
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / this.meterBuf.length);
    return Math.min(1, Math.max(rms * 1.8, peak * 0.9));
  }

  /** Peaks captured so far (for the live recording waveform), or null if idle. */
  livePeaks(): LivePeaks | null {
    if (!this.capturing) return null;
    return { peaks: this.livePeakArr, bucketSec: PEAK_BUCKET / this.engine.ctx.sampleRate };
  }

  /** Begin capturing PCM from the open input. */
  startCapture(): boolean {
    if (!this.source || this.capturing) return false;
    const ctx = this.engine.ctx;
    this.worklet = new AudioWorkletNode(ctx, 'recorder-processor');
    this.frames = [];
    this.numChannels = 1;
    this.livePeakArr = [];
    this.curPeak = 0;
    this.curCount = 0;
    this.worklet.port.onmessage = (e: MessageEvent<{ channels: Float32Array[] }>) => {
      const chs = e.data.channels;
      if (chs.length > 0) this.numChannels = chs.length;
      this.frames.push(chs);
      // Accumulate down-sampled peaks so the timeline can draw the waveform live.
      const ch0 = chs[0];
      if (ch0) {
        for (let i = 0; i < ch0.length; i++) {
          const a = Math.abs(ch0[i]!);
          if (a > this.curPeak) this.curPeak = a;
          if (++this.curCount >= PEAK_BUCKET) {
            this.livePeakArr.push(this.curPeak);
            this.curPeak = 0;
            this.curCount = 0;
          }
        }
      }
    };
    this.source.connect(this.worklet);
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.worklet.connect(this.sink);
    this.sink.connect(ctx.destination);
    this.capturing = true;
    return true;
  }

  /** Stop capturing and assemble the recorded channels (keeps the stream open). */
  stopCapture(): RecordingResult | null {
    if (!this.capturing) return null;
    this.capturing = false;
    try {
      if (this.worklet) {
        // Detach the processor completely. Just calling worklet.disconnect()
        // only removes its OUTPUT; the source→worklet input stays and, because
        // process() returns true, the node keeps running and keeps posting
        // frames. A second recording would then receive frames from BOTH the
        // old and new worklets → ~2× the samples. Cut the input and the port.
        this.worklet.port.onmessage = null;
        this.source?.disconnect(this.worklet);
        this.worklet.disconnect();
      }
      this.sink?.disconnect();
    } catch {
      /* ignore */
    }
    this.worklet = null;
    this.sink = null;

    const sampleRate = this.engine.ctx.sampleRate;
    const nch = Math.max(1, this.numChannels);
    let total = 0;
    for (const f of this.frames) total += f[0]?.length ?? 0;
    const channels: Float32Array[] = [];
    for (let c = 0; c < nch; c++) channels.push(new Float32Array(total));
    let off = 0;
    for (const frame of this.frames) {
      const len = frame[0]?.length ?? 0;
      for (let c = 0; c < nch; c++) {
        const src = frame[c] ?? frame[0];
        if (src) channels[c]!.set(src, off);
      }
      off += len;
    }
    this.frames = [];
    if (total === 0) return null;
    return { channels, sampleRate };
  }

  private closeStream() {
    try {
      this.worklet?.disconnect();
      this.sink?.disconnect();
      this.source?.disconnect();
      this.analyser?.disconnect();
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.engine.setMonitorEnabled(false);
    this.stream = null;
    this.source = null;
    this.analyser = null;
    this.meterBuf = null;
    this.worklet = null;
    this.sink = null;
    this.capturing = false;
    this.deviceId = null;
  }

  close() {
    this.closeStream();
  }
}
