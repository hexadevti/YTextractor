/**
 * Web Audio multitrack mixer engine.
 *
 * Each stem becomes a channel: AudioBufferSourceNode -> GainNode (vol/mute) ->
 * AnalyserNode (spectrum) -> masterGain -> destination. All stems share one
 * AudioContext and are started from a single reference time so playback stays
 * sample-synchronised. Pausing stops the one-shot sources and remembers the
 * offset; resuming recreates them at that offset.
 */

import type { SelectableStem, StemName, StemSet } from '@prismaxim/shared';

export interface TrackState {
  name: SelectableStem;
  muted: boolean;
  soloed: boolean;
  removed: boolean;
  /** linear gain 0..1.5 */
  volume: number;
}

interface Channel {
  name: SelectableStem;
  buffer: AudioBuffer;
  gain: GainNode;
  analyser: AnalyserNode;
  source: AudioBufferSourceNode | null;
}

export class MixerEngine {
  readonly ctx: AudioContext;
  readonly duration: number;
  readonly sampleRate: number;
  private master: GainNode;
  private channels: Channel[] = [];
  private tracks = new Map<SelectableStem, TrackState>();

  private playing = false;
  /** ctx.currentTime when playback (re)started */
  private startedAt = 0;
  /** playback offset in seconds captured at last pause/seek */
  private offset = 0;

  constructor(set: StemSet) {
    this.ctx = new AudioContext({ sampleRate: set.sampleRate });
    this.sampleRate = set.sampleRate;
    this.duration = set.length / set.sampleRate;
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);

    for (const stem of set.stems) {
      const buffer = this.ctx.createBuffer(set.numChannels, set.length, set.sampleRate);
      for (let ch = 0; ch < set.numChannels; ch++) {
        buffer.copyToChannel(stem.channels[ch]! as Float32Array<ArrayBuffer>, ch);
      }
      const gain = this.ctx.createGain();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.75;
      gain.connect(analyser);
      analyser.connect(this.master);
      this.channels.push({ name: stem.name, buffer, gain, analyser, source: null });
      this.tracks.set(stem.name, {
        name: stem.name,
        muted: false,
        soloed: false,
        removed: false,
        volume: 1,
      });
      gain.gain.value = 1;
    }
  }

  getChannelBuffer(name: SelectableStem): AudioBuffer | undefined {
    return this.channels.find((c) => c.name === name)?.buffer;
  }

  getAnalyser(name: SelectableStem): AnalyserNode | undefined {
    return this.channels.find((c) => c.name === name)?.analyser;
  }

  getTracks(): TrackState[] {
    return this.channels.map((c) => this.tracks.get(c.name)!);
  }

  /** Channels that are currently audible, with their effective linear gain. */
  getMixPlan(): { name: SelectableStem; buffer: AudioBuffer; gain: number }[] {
    return this.channels
      .map((c) => ({ name: c.name, buffer: c.buffer, gain: this.effectiveGain(c.name) }))
      .filter((p) => p.gain > 0);
  }

  get numChannels(): number {
    return this.channels[0]?.buffer.numberOfChannels ?? 2;
  }

  get lengthSamples(): number {
    return this.channels[0]?.buffer.length ?? 0;
  }

  /** Effective gain for a channel given mute/solo/remove across all tracks. */
  private effectiveGain(name: SelectableStem): number {
    const t = this.tracks.get(name)!;
    if (t.removed || t.muted) return 0;
    const anySolo = [...this.tracks.values()].some((s) => s.soloed && !s.removed);
    if (anySolo && !t.soloed) return 0;
    return t.volume;
  }

  private applyGains() {
    const now = this.ctx.currentTime;
    for (const ch of this.channels) {
      ch.gain.gain.setTargetAtTime(this.effectiveGain(ch.name), now, 0.015);
    }
  }

  setMuted(name: SelectableStem, muted: boolean) {
    this.tracks.get(name)!.muted = muted;
    this.applyGains();
  }

  setSoloed(name: SelectableStem, soloed: boolean) {
    this.tracks.get(name)!.soloed = soloed;
    this.applyGains();
  }

  setRemoved(name: SelectableStem, removed: boolean) {
    this.tracks.get(name)!.removed = removed;
    this.applyGains();
  }

  setVolume(name: SelectableStem, volume: number) {
    this.tracks.get(name)!.volume = volume;
    this.applyGains();
  }

  /** Apply a preset: mute exactly the named stems, unmute the rest. */
  applyPreset(mutedNames: StemName[]) {
    for (const t of this.tracks.values()) {
      t.muted = (mutedNames as SelectableStem[]).includes(t.name);
      t.soloed = false;
    }
    this.applyGains();
  }

  resetTracks() {
    for (const t of this.tracks.values()) {
      t.muted = false;
      t.soloed = false;
      t.removed = false;
      t.volume = 1;
    }
    this.applyGains();
  }

  get isPlaying() {
    return this.playing;
  }

  /** current playback position in seconds */
  currentTime(): number {
    if (!this.playing) return this.offset;
    return Math.min(this.duration, this.offset + (this.ctx.currentTime - this.startedAt));
  }

  async play() {
    if (this.playing) return;
    if (this.ctx.state === 'closed') return;
    await this.ctx.resume();
    let startOffset = this.offset;
    if (startOffset >= this.duration) startOffset = 0;
    this.startedAt = this.ctx.currentTime;
    this.offset = startOffset;
    this.applyGains();
    for (const ch of this.channels) {
      const src = this.ctx.createBufferSource();
      src.buffer = ch.buffer;
      src.connect(ch.gain);
      src.start(0, startOffset);
      ch.source = src;
    }
    this.playing = true;
    // auto-stop bookkeeping when the buffers end
    const first = this.channels[0]?.source;
    if (first) {
      first.onended = () => {
        if (this.playing && this.currentTime() >= this.duration - 0.05) {
          this.pause();
          this.offset = 0;
        }
      };
    }
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.currentTime();
    for (const ch of this.channels) {
      if (ch.source) {
        ch.source.onended = null;
        try {
          ch.source.stop();
        } catch {
          /* already stopped */
        }
        ch.source.disconnect();
        ch.source = null;
      }
    }
    this.playing = false;
  }

  seek(seconds: number) {
    const clamped = Math.min(this.duration, Math.max(0, seconds));
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.offset = clamped;
    if (wasPlaying) void this.play();
  }

  async close() {
    this.pause();
    if (this.ctx.state !== 'closed') {
      try {
        await this.ctx.close();
      } catch {
        /* already closing/closed */
      }
    }
  }
}
