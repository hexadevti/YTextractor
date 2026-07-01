/**
 * Stem definitions for the Demucs `htdemucs_6s` model.
 *
 * The source order below matches the model's output channel order
 * (`[drums, bass, other, vocals, guitar, piano]`). Keep this array in sync with
 * the ONNX model — the separation pipeline maps output source index -> name by
 * this order.
 */

export type StemName = 'drums' | 'bass' | 'other' | 'vocals' | 'guitar' | 'piano';

export const STEM_NAMES: readonly StemName[] = [
  'drums',
  'bass',
  'other',
  'vocals',
  'guitar',
  'piano',
] as const;

/** Human-facing labels + a stable colour hint for the mixer UI. */
export const STEM_META: Record<StemName, { label: string; color: string }> = {
  drums: { label: 'Drums', color: '#f97316' },
  bass: { label: 'Bass', color: '#a855f7' },
  other: { label: 'Other', color: '#64748b' },
  vocals: { label: 'Vocals', color: '#ef4444' },
  guitar: { label: 'Guitar', color: '#22c55e' },
  piano: { label: 'Piano', color: '#3b82f6' },
};

/** One separated stem: one Float32Array of PCM per channel. */
export interface Stem {
  name: StemName;
  /** channels[c][i] = sample i of channel c. Usually 2 channels (stereo). */
  channels: Float32Array[];
}

/** Full result of a separation: all stems sharing sampleRate/length/channels. */
export interface StemSet {
  sampleRate: number;
  /** samples per channel */
  length: number;
  numChannels: number;
  stems: Stem[];
}

/** A one-click mix preset: which stems to silence. */
export interface Preset {
  id: string;
  label: string;
  /** stems muted by this preset */
  muted: StemName[];
}

export const PRESETS: Preset[] = [
  { id: 'karaoke', label: 'Karaoke (no vocals)', muted: ['vocals'] },
  { id: 'solo', label: 'Solo practice (no guitar)', muted: ['guitar'] },
];

export function getStem(set: StemSet, name: StemName): Stem | undefined {
  return set.stems.find((s) => s.name === name);
}
