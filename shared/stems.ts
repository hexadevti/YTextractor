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

/**
 * Normalise a user stem selection: keep only valid names, in canonical
 * `STEM_NAMES` order, deduped. An empty/absent selection means "all 6".
 * Used to keep the separation output order stable regardless of pick order.
 */
export function orderStems(selection?: readonly string[] | null): StemName[] {
  if (!selection || selection.length === 0) return [...STEM_NAMES];
  return STEM_NAMES.filter((n) => selection.includes(n));
}

/** Parse a comma-separated stem list (wire header) into ordered valid names. */
export function parseStemList(csv?: string | null): StemName[] {
  return orderStems(csv ? csv.split(',').map((s) => s.trim()) : null);
}
