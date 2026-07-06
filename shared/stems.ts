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

/**
 * Synthetic "remaining instruments" bucket: a single track summing every model
 * source the user did NOT pick individually. It is not a model output — the
 * separation pipeline builds it by summing the leftover sources (see
 * `separateMixture`). Combined with a few individual picks it gives the classic
 * "vocals + instrumental" style split without a track per source.
 */
export const REMAINING_STEM = 'remaining';
export type RemainingStem = typeof REMAINING_STEM;

/** A user-selectable / produced stem: a real model source or the summed leftover. */
export type SelectableStem = StemName | RemainingStem;

/** Human-facing labels + a stable colour hint for the mixer UI. */
export const STEM_META: Record<SelectableStem, { label: string; color: string }> = {
  drums: { label: 'Drums', color: '#f97316' },
  bass: { label: 'Bass', color: '#a855f7' },
  other: { label: 'Other', color: '#64748b' },
  vocals: { label: 'Vocals', color: '#ef4444' },
  guitar: { label: 'Guitar', color: '#22c55e' },
  piano: { label: 'Piano', color: '#3b82f6' },
  remaining: { label: 'Remaining', color: '#94a3b8' },
};

/** One separated stem: one Float32Array of PCM per channel. */
export interface Stem {
  name: SelectableStem;
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

/** True for one of the 6 real model source names (excludes the remaining bucket). */
export function isStemName(name: string): name is StemName {
  return (STEM_NAMES as readonly string[]).includes(name);
}

/**
 * Split a raw user selection (real stem names, optionally the `remaining`
 * sentinel) into the individual stems to emit and whether to also emit the
 * summed leftover bucket.
 *
 * `include` is canonical-ordered and deduped, and may be empty — an empty
 * `include` with `remaining: true` means "no individual stems, sum everything
 * into one remaining track". This is intentionally NOT the historical
 * "empty selection = all 6" default; that default is applied by the callers /
 * `separateMixture` when no remaining bucket is requested.
 */
export function splitStemSelection(selection?: readonly string[] | null): {
  include: StemName[];
  remaining: boolean;
} {
  const remaining = !!selection && selection.includes(REMAINING_STEM);
  const include = STEM_NAMES.filter((n) => !!selection && selection.includes(n));
  return { include, remaining };
}

/**
 * Canonicalise a raw selection into ordered, deduped SelectableStem[] (the 6
 * stems in model order, then the remaining bucket if present). Empty stays empty
 * — no "all 6" expansion.
 */
export function orderSelection(selection?: readonly string[] | null): SelectableStem[] {
  const { include, remaining } = splitStemSelection(selection);
  return remaining ? [...include, REMAINING_STEM] : [...include];
}

/** Parse a comma-separated selection (wire header) preserving the remaining flag. */
export function parseStemSelection(csv?: string | null): SelectableStem[] {
  return orderSelection(csv ? csv.split(',').map((s) => s.trim()) : null);
}
