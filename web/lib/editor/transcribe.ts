/**
 * Audio → MIDI transcription using Spotify Basic Pitch (polyphonic, TF.js).
 *
 * TensorFlow.js + the Basic Pitch model are **dynamically imported** on first use
 * so they don't affect initial load. The model expects 22.05 kHz mono audio.
 *
 * Basic Pitch is the best in-browser transcriber, but raw output has spurious
 * notes (harmonics/noise crossing the permissive default thresholds). We expose
 * the model's sensitivity knobs and post-process (confidence/length filtering,
 * optional pitch-range clamp, optional monophonic reduction) to keep it clean.
 */

import { BASIC_PITCH_MODEL_URL } from '../config';
import { cleanNotes, toMonophonic } from './midiClean';
import type { MidiNote } from './model';

// Basic Pitch annotations are at 22050 / 256 ≈ 86.13 frames per second.
const FRAMES_PER_SEC = 22050 / 256;

export interface TranscribeOptions {
  /** 0..1 — higher rejects weak note onsets (fewer, more confident notes). */
  onsetThreshold?: number;
  /** 0..1 — higher rejects weak sustained frames (shorter/fewer notes). */
  frameThreshold?: number;
  /** Drop notes shorter than this (ms). */
  minNoteLenMs?: number;
  /** Restrict detected pitches to a frequency range (Hz); null = unrestricted. */
  minFreqHz?: number | null;
  maxFreqHz?: number | null;
  /** Basic Pitch's melodia post-processing (helps melodies, can add notes). */
  melodiaTrick?: boolean;
  /** 0..1 — drop notes quieter than this fraction of full velocity. */
  minConfidence?: number;
  /** Reduce to a single-note line (great for bass / vocal / lead). */
  monophonic?: false | 'low' | 'high';
}

const DEFAULTS: Required<TranscribeOptions> = {
  onsetThreshold: 0.5,
  frameThreshold: 0.3,
  minNoteLenMs: 130,
  minFreqHz: null,
  maxFreqHz: null,
  melodiaTrick: true,
  minConfidence: 0.15,
  monophonic: false,
};

// Cache the loaded module + model instance across transcriptions.
let bpPromise: Promise<{ mod: any; bp: any }> | null = null;

async function getBasicPitch(): Promise<{ mod: any; bp: any }> {
  if (!bpPromise) {
    bpPromise = (async () => {
      const mod: any = await import('@spotify/basic-pitch');
      const bp = new mod.BasicPitch(BASIC_PITCH_MODEL_URL);
      return { mod, bp };
    })();
  }
  return bpPromise;
}

/** Resample an AudioBuffer to mono at `targetRate`. */
async function resampleMono(buffer: AudioBuffer, targetRate = 22050): Promise<AudioBuffer> {
  if (buffer.sampleRate === targetRate && buffer.numberOfChannels === 1) return buffer;
  const frames = Math.max(1, Math.ceil(buffer.duration * targetRate));
  const off = new OfflineAudioContext(1, frames, targetRate);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start(0);
  return off.startRendering();
}

/**
 * Transcribe an AudioBuffer to MIDI notes.
 * @param onProgress 0..1 model progress (loading is reported as an early ~0).
 */
export async function transcribeAudioBuffer(
  buffer: AudioBuffer,
  onProgress?: (p: number) => void,
  options: TranscribeOptions = {},
): Promise<MidiNote[]> {
  const opt = { ...DEFAULTS, ...options };
  const resampled = await resampleMono(buffer, 22050);
  onProgress?.(0.02);
  const { mod, bp } = await getBasicPitch();

  const frames: number[][] = [];
  const onsets: number[][] = [];
  const contours: number[][] = [];
  await bp.evaluateModel(
    resampled,
    (f: number[][], o: number[][], c: number[][]) => {
      frames.push(...f);
      onsets.push(...o);
      contours.push(...c);
    },
    (p: number) => onProgress?.(Math.max(0.02, p)),
  );

  const minNoteFrames = Math.max(1, Math.round((opt.minNoteLenMs / 1000) * FRAMES_PER_SEC));
  const rawNotes = mod.noteFramesToTime(
    mod.addPitchBendsToNoteEvents(
      contours,
      mod.outputToNotesPoly(
        frames,
        onsets,
        opt.onsetThreshold,
        opt.frameThreshold,
        minNoteFrames,
        true, // inferOnsets
        opt.maxFreqHz,
        opt.minFreqHz,
        opt.melodiaTrick,
      ),
    ),
  ) as {
    startTimeSeconds: number;
    durationSeconds: number;
    pitchMidi: number;
    amplitude: number;
  }[];

  const notes: MidiNote[] = rawNotes
    .map((n) => ({
      startSec: n.startTimeSeconds,
      durationSec: Math.max(0.02, n.durationSeconds),
      pitch: Math.round(n.pitchMidi),
      velocity: Math.max(1, Math.min(127, Math.round((n.amplitude || 0.7) * 127))),
    }))
    .sort((a, b) => a.startSec - b.startSec);

  // Post-process: drop short/quiet ghost notes and merge fragments; optionally
  // collapse to a single line (removes the bulk of spurious overlapping notes).
  const cleanOpts = {
    minDur: opt.minNoteLenMs / 1000,
    minVel: Math.max(1, Math.round(opt.minConfidence * 127)),
  };
  return opt.monophonic
    ? toMonophonic(notes, opt.monophonic, cleanOpts)
    : cleanNotes(notes, cleanOpts);
}
