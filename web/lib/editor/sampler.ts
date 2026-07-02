/**
 * Sampled instrument bank for MIDI tracks, backed by smplr (General-MIDI
 * soundfonts). One smplr instrument per track (so each routes to its own track
 * gain). smplr + its samples are loaded lazily/on demand.
 */

import type { MidiNote } from './model';

/** smplr's start() returns a StopFn that cancels the note if it hasn't played
 * yet (removing it from the look-ahead scheduler queue) or stops it if it has. */
type StopFn = (time?: number) => void;

interface Entry {
  name: string;
  instr: {
    ready: Promise<void>;
    start: (e: { note: number; velocity?: number; time?: number; duration?: number }) => StopFn;
    stop: () => void;
    dispose: () => void;
  } | null;
  ready: boolean;
}

export class SamplerBank {
  private ctx: AudioContext;
  private lib: Promise<typeof import('smplr')> | null = null;
  private entries = new Map<string, Entry>(); // active (ready) instrument per trackId
  private loading = new Map<string, string>(); // trackId -> instrument name currently loading
  private stops = new Map<string, StopFn[]>(); // per-track stop handles for scheduled notes
  private onChange?: () => void;

  constructor(ctx: AudioContext, onChange?: () => void) {
    this.ctx = ctx;
    this.onChange = onChange;
  }

  private smplr() {
    if (!this.lib) this.lib = import('smplr');
    return this.lib;
  }

  isReady(trackId: string, name: string): boolean {
    const e = this.entries.get(trackId);
    return !!e && e.ready && e.name === name;
  }

  /**
   * Load (or switch to) an instrument for a track, routed to `out`. The current
   * instrument keeps playing until the new one is loaded, then they swap — so
   * changing instrument mid-playback doesn't cut the sound.
   */
  async ensure(trackId: string, name: string, out: AudioNode): Promise<void> {
    const active = this.entries.get(trackId);
    if (active?.ready && active.name === name) return; // already active
    if (this.loading.get(trackId) === name) return; // already loading this one
    this.loading.set(trackId, name);
    try {
      const mod = await this.smplr();
      if (this.loading.get(trackId) !== name) return; // superseded while importing
      const instr = mod.Soundfont(this.ctx, { instrument: name, destination: out }) as Entry['instr'];
      await instr!.ready;
      if (this.loading.get(trackId) !== name) {
        try {
          instr!.dispose();
        } catch {
          /* superseded */
        }
        return;
      }
      // swap: install the new instrument, then dispose the old one
      const old = this.entries.get(trackId);
      this.entries.set(trackId, { name, instr, ready: true });
      this.loading.delete(trackId);
      if (old?.instr) {
        try {
          old.instr.dispose();
        } catch {
          /* ignore */
        }
      }
      this.onChange?.();
    } catch {
      if (this.loading.get(trackId) === name) this.loading.delete(trackId);
    }
  }

  /** Cancel + forget any notes previously scheduled for a track. */
  private cancel(trackId: string): void {
    const handles = this.stops.get(trackId);
    if (!handles) return;
    for (const stop of handles) {
      try {
        stop();
      } catch {
        /* ignore */
      }
    }
    this.stops.delete(trackId);
  }

  /** Schedule a track's notes (must be ready). Times mirror the clip scheduler. */
  schedule(trackId: string, notes: MidiNote[], ctxStart: number, fromSec: number, rate = 1): void {
    const e = this.entries.get(trackId);
    if (!e?.ready || !e.instr) return;
    this.cancel(trackId); // drop any stale schedule before laying down a new one
    const handles: StopFn[] = [];
    for (const n of notes) {
      const end = n.startSec + n.durationSec;
      if (end <= fromSec + 1e-4) continue;
      const noteStart = Math.max(fromSec, n.startSec);
      handles.push(
        e.instr.start({
          note: n.pitch,
          velocity: n.velocity,
          time: ctxStart + (noteStart - fromSec) / rate,
          duration: Math.max(0.05, (end - noteStart) / rate),
        }),
      );
    }
    this.stops.set(trackId, handles);
  }

  stopAll(): void {
    // Cancel queued notes (smplr defers future notes to a look-ahead scheduler,
    // so instr.stop() alone won't reach them) as well as any sounding voices.
    for (const id of [...this.stops.keys()]) this.cancel(id);
    for (const e of this.entries.values()) {
      try {
        e.instr?.stop();
      } catch {
        /* ignore */
      }
    }
  }

  dispose(trackId: string): void {
    this.loading.delete(trackId); // cancel any in-flight load
    this.cancel(trackId);
    const e = this.entries.get(trackId);
    if (e) {
      try {
        e.instr?.dispose();
      } catch {
        /* ignore */
      }
      this.entries.delete(trackId);
    }
  }

  disposeAll(): void {
    this.loading.clear();
    for (const id of [...this.entries.keys()]) this.dispose(id);
    this.stops.clear();
  }
}
