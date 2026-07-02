/**
 * Clip-based, non-destructive editor model.
 *
 * A project has tracks; a track has clips laid out on a timeline. A clip
 * references an AudioBuffer and plays `[offsetSec, offsetSec+durationSec)` of it
 * starting at `startSec` on the timeline. Splitting/trimming only adjusts
 * offset/duration — the underlying buffer is shared and never mutated, which
 * makes undo/redo (snapshotting metadata) cheap.
 */

import { STEM_META, type StemName, type StemSet } from '@ytx/shared';

export interface Clip {
  id: string;
  buffer: AudioBuffer;
  /** position on the timeline, seconds */
  startSec: number;
  /** trim start within the buffer, seconds */
  offsetSec: number;
  /** playable length, seconds */
  durationSec: number;
}

/** A transcribed MIDI note (attached to a track). */
export interface MidiNote {
  startSec: number;
  durationSec: number;
  pitch: number; // MIDI note number 0..127
  velocity: number; // 1..127
}

export interface EditorTrack {
  id: string;
  name: string;
  color: string;
  /** origin stem name (absent for recorded tracks) — used for presets */
  stem?: StemName;
  clips: Clip[];
  muted: boolean;
  soloed: boolean;
  volume: number; // linear 0..1.5
  armed: boolean; // record-enabled
  /** MIDI notes — present on a MIDI track (rendered as a piano-roll, no audio clips) */
  midi?: MidiNote[];
  /** synth instrument id for a MIDI track (see instruments.ts) */
  instrument?: string;
}

export interface EditorProject {
  tracks: EditorTrack[];
  sampleRate: number;
  numChannels: number;
}

export interface Selection {
  startSec: number;
  endSec: number;
  trackIds: string[];
  clipIds: string[];
}

export const EMPTY_SELECTION: Selection = {
  startSec: 0,
  endSec: 0,
  trackIds: [],
  clipIds: [],
};

export function uid(): string {
  return crypto.randomUUID();
}

/** Build an AudioBuffer from raw channel data without needing an AudioContext. */
export function makeAudioBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  const length = channels[0]?.length ?? 0;
  const buffer = new AudioBuffer({
    length: Math.max(1, length),
    numberOfChannels: Math.max(1, channels.length),
    sampleRate,
  });
  for (let c = 0; c < channels.length; c++) {
    buffer.copyToChannel(channels[c]! as Float32Array<ArrayBuffer>, c);
  }
  return buffer;
}

/** Convert a separation StemSet into an editor project (one clip per stem). */
export function fromStemSet(set: StemSet): EditorProject {
  const durationSec = set.length / set.sampleRate;
  const tracks: EditorTrack[] = set.stems.map((stem) => ({
    id: uid(),
    name: STEM_META[stem.name]?.label ?? stem.name,
    color: STEM_META[stem.name]?.color ?? '#64748b',
    stem: stem.name,
    clips: [
      {
        id: uid(),
        buffer: makeAudioBuffer(stem.channels, set.sampleRate),
        startSec: 0,
        offsetSec: 0,
        durationSec,
      },
    ],
    muted: false,
    soloed: false,
    volume: 1,
    armed: false,
  }));
  return { tracks, sampleRate: set.sampleRate, numChannels: set.numChannels };
}

/** An empty editor project (no tracks) — the base state before anything is loaded. */
export function emptyProject(): EditorProject {
  return { tracks: [], sampleRate: 44100, numChannels: 2 };
}

export function clipEnd(clip: Clip): number {
  return clip.startSec + clip.durationSec;
}

export function totalDuration(project: EditorProject): number {
  let max = 0;
  for (const t of project.tracks) {
    for (const c of t.clips) max = Math.max(max, clipEnd(c));
    if (t.midi) for (const n of t.midi) max = Math.max(max, n.startSec + n.durationSec);
  }
  return max;
}

/** Shallow-immutable clone: new track/clip objects, shared AudioBuffers. */
export function cloneProject(project: EditorProject): EditorProject {
  return {
    sampleRate: project.sampleRate,
    numChannels: project.numChannels,
    tracks: project.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => ({ ...c })),
      midi: t.midi ? t.midi.map((n) => ({ ...n })) : undefined,
    })),
  };
}

export function findTrack(project: EditorProject, trackId: string): EditorTrack | undefined {
  return project.tracks.find((t) => t.id === trackId);
}

/** Effective gain given mute/solo across all tracks (0 = silent). */
export function effectiveTrackGain(project: EditorProject, track: EditorTrack): number {
  if (track.muted) return 0;
  const anySolo = project.tracks.some((t) => t.soloed);
  if (anySolo && !track.soloed) return 0;
  return track.volume;
}
