/**
 * Clip-aware Web Audio playback engine for the editor.
 *
 * Schedules each clip via an AudioBufferSourceNode at its timeline position,
 * routed through a per-track GainNode (mute/solo/volume) into a master → output.
 * Also owns the AudioContext used for recording + monitoring, and applies the
 * selected output device via setSinkId.
 */

import { clipEnd, effectiveTrackGain, totalDuration, type EditorProject } from './model';
import { scheduleMidi } from './synth';
import { fallbackOsc, getInstrument } from './instruments';
import { SamplerBank } from './sampler';
import type { StretchIn, StretchOut } from './stretch.worker';

interface TrackNode {
  gain: GainNode;
  analyser: AnalyserNode;
}

type SinkCapableContext = AudioContext & {
  setSinkId?: (id: string) => Promise<void>;
};

export class EditorEngine {
  readonly ctx: SinkCapableContext;
  private master: GainNode;
  /** Mic/instrument monitoring path (independent of track gains). */
  readonly monitorGain: GainNode;
  private trackNodes = new Map<string, TrackNode>();
  private activeSources: AudioScheduledSourceNode[] = [];
  private project: EditorProject;
  private bank: SamplerBank;
  /** called when a sampled instrument finishes loading (to refresh the UI). */
  onMidiLoaded?: () => void;
  /** called when pitch-preserved buffers for the current rate finish building. */
  onStretchReady?: () => void;
  /** called as pitch-preserved buffers build (done, total) for a progress hint. */
  onStretchProgress?: (done: number, total: number) => void;

  private playing = false;
  private startedAt = 0;
  private offset = 0;
  private rate = 1;
  /** "keep pitch" mode: time-stretch clips instead of resampling (pitch shift). */
  private keepPitch = false;
  /** cache of pitch-preserved buffers: original buffer → rate → stretched buffer. */
  private stretchCache = new Map<AudioBuffer, Map<number, AudioBuffer>>();
  private preparingStretch = false;

  constructor(project: EditorProject) {
    this.ctx = new AudioContext({ sampleRate: project.sampleRate });
    this.project = project;
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.monitorGain = this.ctx.createGain();
    this.monitorGain.gain.value = 0;
    this.monitorGain.connect(this.ctx.destination);
    this.bank = new SamplerBank(this.ctx, () => this.onMidiLoaded?.());
    this.reconcileTracks();
    this.applyGains();
  }

  /** Whether the sampled instrument for a track is loaded and ready. */
  isMidiReady(trackId: string, instrument?: string): boolean {
    return this.bank.isReady(trackId, getInstrument(instrument).name);
  }

  /** Start loading a track's sampled instrument (routed to its gain node). */
  ensureInstrument(trackId: string, instrument?: string): void {
    const node = this.trackNodes.get(trackId);
    if (node) void this.bank.ensure(trackId, getInstrument(instrument).name, node.gain);
  }

  /** Create/remove per-track nodes to match the project. */
  private reconcileTracks() {
    const ids = new Set(this.project.tracks.map((t) => t.id));
    for (const [id, node] of this.trackNodes) {
      if (!ids.has(id)) {
        node.gain.disconnect();
        node.analyser.disconnect();
        this.trackNodes.delete(id);
        this.bank.dispose(id);
      }
    }
    for (const track of this.project.tracks) {
      if (this.trackNodes.has(track.id)) continue;
      const gain = this.ctx.createGain();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      gain.connect(analyser);
      analyser.connect(this.master);
      this.trackNodes.set(track.id, { gain, analyser });
    }
  }

  private applyGains() {
    const now = this.ctx.currentTime;
    for (const track of this.project.tracks) {
      const node = this.trackNodes.get(track.id);
      if (node) node.gain.gain.setTargetAtTime(effectiveTrackGain(this.project, track), now, 0.015);
    }
  }

  /** Update the project (after an edit); reconciles nodes and re-applies gains. */
  setProject(project: EditorProject) {
    this.project = project;
    this.reconcileTracks();
    this.applyGains();
  }

  getAnalyser(trackId: string): AnalyserNode | undefined {
    return this.trackNodes.get(trackId)?.analyser;
  }

  get duration(): number {
    return totalDuration(this.project);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  currentTime(): number {
    if (!this.playing) return this.offset;
    return this.offset + (this.ctx.currentTime - this.startedAt) * this.rate;
  }

  get playbackRate(): number {
    return this.rate;
  }

  /** Set playback speed (0.25–2×). Caller should reschedule if playing. */
  setRate(rate: number) {
    const r = Math.max(0.25, Math.min(2, rate));
    if (r !== this.rate) this.stretchCache.clear(); // cached buffers are rate-specific
    this.rate = r;
  }

  get keepPitchEnabled(): boolean {
    return this.keepPitch;
  }

  /** Toggle pitch-preserving time-stretch for off-speed playback. */
  setKeepPitch(on: boolean) {
    this.keepPitch = on;
    if (!on) this.stretchCache.clear();
  }

  /** True once every clip has a pitch-preserved buffer cached for the current rate. */
  isStretchReady(): boolean {
    if (!this.keepPitch || this.rate === 1) return true;
    for (const track of this.project.tracks) {
      for (const clip of track.clips) {
        if (!this.stretchCache.get(clip.buffer)?.has(this.rate)) return false;
      }
    }
    return true;
  }

  private stretchAborted(rate: number): boolean {
    return this.rate !== rate || !this.keepPitch || (this.ctx.state as string) === 'closed';
  }

  /**
   * Time-stretch one buffer in a dedicated worker; always settles — falls back
   * to the original buffer on worker error/timeout so it can never hang.
   */
  private stretchOne(buffer: AudioBuffer, rate: number): Promise<AudioBuffer> {
    const chs = buffer.numberOfChannels;
    // Copy the channels so the transfer to the worker never detaches the clip's
    // own PCM (the originals must stay playable on this thread).
    const channels: Float32Array[] = [];
    for (let c = 0; c < chs; c++) channels.push(buffer.getChannelData(c).slice());
    return new Promise<AudioBuffer>((resolve) => {
      let worker: Worker | null = null;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: AudioBuffer) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try {
          worker?.terminate();
        } catch {
          /* ignore */
        }
        resolve(result);
      };
      try {
        worker = new Worker(new URL('./stretch.worker.ts', import.meta.url), { type: 'module' });
      } catch {
        finish(buffer); // bundler/spawn failure → pitch-shift fallback
        return;
      }
      // Watchdog: a single buffer should take a few seconds; if the worker never
      // answers (crash/load failure), fall back instead of hanging "building…".
      timer = setTimeout(() => finish(buffer), 45000);
      worker.onmessage = (ev: MessageEvent<StretchOut>) => {
        const outCh = ev.data.channels;
        if (!outCh || outCh.length === 0 || (this.ctx.state as string) === 'closed') {
          finish(buffer);
          return;
        }
        const len = Math.max(1, outCh[0]!.length);
        const out = this.ctx.createBuffer(chs, len, buffer.sampleRate);
        for (let c = 0; c < chs; c++) out.copyToChannel(outCh[c] as Float32Array<ArrayBuffer>, c);
        finish(out);
      };
      worker.onerror = () => finish(buffer);
      const msg: StretchIn = { channels, factor: 1 / rate };
      worker.postMessage(
        msg,
        channels.map((c) => c.buffer),
      );
    });
  }

  /**
   * Build pitch-preserved buffers for all clips at the current rate, across a
   * pool of workers (one per CPU) so several stems stretch at once. Reports
   * progress and fires onStretchReady when done. Never freezes the UI.
   */
  async prepareStretch(): Promise<void> {
    if (this.preparingStretch) return;
    if (!this.keepPitch || this.rate === 1 || this.ctx.state === 'closed') return;
    this.preparingStretch = true;
    const rate = this.rate;
    try {
      const seen = new Set<AudioBuffer>();
      const todo: AudioBuffer[] = [];
      for (const track of this.project.tracks) {
        for (const clip of track.clips) {
          if (seen.has(clip.buffer)) continue;
          seen.add(clip.buffer);
          if (!this.stretchCache.get(clip.buffer)?.has(rate)) todo.push(clip.buffer);
        }
      }
      const total = todo.length;
      if (total === 0) {
        if (!this.stretchAborted(rate)) this.onStretchReady?.();
        return;
      }
      let done = 0;
      let aborted = false;
      this.onStretchProgress?.(0, total);
      const cores =
        typeof navigator !== 'undefined' && navigator.hardwareConcurrency
          ? navigator.hardwareConcurrency
          : 4;
      const concurrency = Math.max(1, Math.min(total, cores));
      let next = 0;
      const runner = async () => {
        for (;;) {
          if (this.stretchAborted(rate)) {
            aborted = true;
            return;
          }
          const i = next++;
          if (i >= todo.length) return;
          const buf = todo[i]!;
          const stretched = await this.stretchOne(buf, rate);
          if (this.stretchAborted(rate)) {
            aborted = true;
            return;
          }
          let m = this.stretchCache.get(buf);
          if (!m) {
            m = new Map();
            this.stretchCache.set(buf, m);
          }
          m.set(rate, stretched);
          done++;
          this.onStretchProgress?.(done, total);
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => runner()));
      if (!aborted && this.rate === rate && this.keepPitch) this.onStretchReady?.();
    } finally {
      this.preparingStretch = false;
    }
  }

  private stopSources() {
    for (const src of this.activeSources) {
      try {
        src.onended = null;
        src.stop();
      } catch {
        /* already stopped */
      }
      src.disconnect();
    }
    this.activeSources = [];
    this.bank.stopAll();
  }

  async play(fromSec?: number) {
    if (this.playing) return;
    if (this.ctx.state === 'closed') return;
    await this.ctx.resume();
    const start = fromSec ?? this.offset;
    this.offset = start;
    this.startedAt = this.ctx.currentTime;
    const useStretch = this.keepPitch && this.rate !== 1;
    let needStretch = false;

    for (const track of this.project.tracks) {
      const node = this.trackNodes.get(track.id);
      if (!node) continue;
      for (const clip of track.clips) {
        const end = clipEnd(clip);
        if (end <= start + 1e-4) continue;
        const when = this.ctx.currentTime + Math.max(0, clip.startSec - start) / this.rate;
        const bufferOffset = clip.offsetSec + Math.max(0, start - clip.startSec);
        const playDur = end - Math.max(start, clip.startSec);
        if (playDur <= 1e-4) continue;

        // Keep-pitch: play a time-stretched buffer at rate 1 (same pitch); its
        // timeline is compressed by `rate`, so offsets/durations divide by rate.
        // Until the stretched buffer is built, fall back to the pitch-shift path.
        let buffer = clip.buffer;
        let pbRate = this.rate;
        let offSec = bufferOffset;
        let durSec = playDur;
        if (useStretch) {
          const cached = this.stretchCache.get(clip.buffer)?.get(this.rate);
          if (cached) {
            buffer = cached;
            pbRate = 1;
            offSec = bufferOffset / this.rate;
            durSec = playDur / this.rate;
          } else {
            needStretch = true;
          }
        }

        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.playbackRate.value = pbRate; // rate 1 when pitch-preserved
        src.connect(node.gain);
        try {
          src.start(when, offSec, durSec);
        } catch {
          continue;
        }
        this.activeSources.push(src);
      }

      // MIDI notes (a MIDI track) — play through the track's gain, so
      // mute/solo/volume apply like an audio track. Use the sampled instrument
      // when loaded, else the oscillator fallback (and start loading samples).
      if (track.midi && track.midi.length) {
        const inst = getInstrument(track.instrument);
        if (this.bank.isReady(track.id, inst.name)) {
          this.bank.schedule(track.id, track.midi, this.ctx.currentTime, start, this.rate);
        } else {
          const oscs = scheduleMidi(
            this.ctx,
            node.gain,
            track.midi,
            this.ctx.currentTime,
            start,
            fallbackOsc(inst.gm),
            this.rate,
          );
          this.activeSources.push(...oscs);
          void this.bank.ensure(track.id, inst.name, node.gain);
        }
      }
    }
    this.playing = true;
    // Some clips are still playing pitch-shifted — build their stretched buffers
    // in the background; onStretchReady lets the UI reschedule seamlessly.
    if (needStretch) void this.prepareStretch();
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.currentTime();
    this.stopSources();
    this.playing = false;
  }

  seek(sec: number) {
    const clamped = Math.max(0, sec);
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.offset = clamped;
    if (wasPlaying) void this.play(clamped);
  }

  /** Select the output device (Chrome/Edge). Returns false if unsupported. */
  async setOutputDevice(deviceId: string): Promise<boolean> {
    if (typeof this.ctx.setSinkId !== 'function') return false;
    try {
      await this.ctx.setSinkId(deviceId);
      return true;
    } catch {
      return false;
    }
  }

  setMonitorEnabled(on: boolean) {
    this.monitorGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  async close() {
    this.pause();
    this.bank.disposeAll();
    this.stretchCache.clear();
    if (this.ctx.state !== 'closed') {
      try {
        await this.ctx.close();
      } catch {
        /* already closed */
      }
    }
  }
}
