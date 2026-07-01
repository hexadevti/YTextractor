/**
 * Runtime-agnostic Demucs (`htdemucs_6s`) separation pipeline.
 *
 * Mirrors the reference `apply_model` logic: normalize the mixture, slide a
 * fixed-length window across it with overlap, run each window through the ONNX
 * model, and recombine the per-window stems with a triangular overlap-add
 * weighting. Works with any `SeparationSession` (browser or node).
 *
 * NOTE: `SEGMENT_SECONDS` must match the length the ONNX model was exported
 * with (htdemucs training segment = 7.8 s). If a different export is used,
 * override it via `SeparationOptions.segmentSeconds`.
 */

import type { SeparationSession } from './runtime';
import { STEM_NAMES, type Stem, type StemName, type StemSet } from './stems';

export const MODEL_SAMPLE_RATE = 44100;
export const MODEL_CHANNELS = 2;
export const SEGMENT_SECONDS = 7.8;

export interface SeparationOptions {
  segmentSeconds?: number;
  /** fraction of overlap between consecutive windows (0..0.9) */
  overlap?: number;
  /** called after each window with overall progress 0..1 */
  onProgress?: (fraction: number) => void;
}

/** Triangular window used to cross-fade overlapping segments (peak in centre). */
function triangularWeights(length: number): Float32Array {
  const w = new Float32Array(length);
  const half = (length - 1) / 2;
  for (let i = 0; i < length; i++) {
    // 1 at the centre, ramping to ~0 at the edges; +1 avoids zero weight
    w[i] = 1 + half - Math.abs(i - half);
  }
  // normalise to a max of 1 for numerical stability
  let max = 0;
  for (let i = 0; i < length; i++) max = Math.max(max, w[i]!);
  if (max > 0) for (let i = 0; i < length; i++) w[i]! /= max;
  return w;
}

/** mean and std of the mono mixture, used to normalise input like Demucs does. */
function mixtureStats(channels: Float32Array[]): { mean: number; std: number } {
  const n = channels[0]!.length;
  const c = channels.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let ch = 0; ch < c; ch++) m += channels[ch]![i]!;
    sum += m / c;
  }
  const mean = sum / n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let ch = 0; ch < c; ch++) m += channels[ch]![i]!;
    m = m / c - mean;
    variance += m * m;
  }
  const std = Math.sqrt(variance / n) || 1;
  return { mean, std };
}

/**
 * Separate a decoded, 44.1 kHz stereo mixture into 6 stems.
 *
 * @param channels one Float32Array per channel (must be MODEL_CHANNELS, MODEL_SAMPLE_RATE)
 */
export async function separateMixture(
  channels: Float32Array[],
  session: SeparationSession,
  opts: SeparationOptions = {},
): Promise<StemSet> {
  const numChannels = channels.length;
  const total = channels[0]!.length;
  const sr = MODEL_SAMPLE_RATE;
  const segmentSeconds = opts.segmentSeconds ?? SEGMENT_SECONDS;
  const overlap = Math.min(Math.max(opts.overlap ?? 0.25, 0), 0.9);

  const segLen = Math.round(segmentSeconds * sr);
  const stride = Math.max(1, Math.round(segLen * (1 - overlap)));
  const weights = triangularWeights(segLen);
  const numSources = STEM_NAMES.length;

  // Accumulators for weighted overlap-add: out[source][channel] and summed weights.
  const out: Float32Array[][] = [];
  for (let s = 0; s < numSources; s++) {
    const perChannel: Float32Array[] = [];
    for (let ch = 0; ch < numChannels; ch++) perChannel.push(new Float32Array(total));
    out.push(perChannel);
  }
  const weightSum = new Float32Array(total);

  // Normalise the mixture (undo per-source after inference).
  const { mean, std } = mixtureStats(channels);

  const starts: number[] = [];
  for (let start = 0; start < total; start += stride) starts.push(start);
  const numWindows = starts.length;

  for (let w = 0; w < numWindows; w++) {
    const start = starts[w]!;
    const end = Math.min(start + segLen, total);
    const valid = end - start;

    // Build normalised input tensor [1, channels, segLen] (zero-padded tail).
    const input = new Float32Array(numChannels * segLen);
    for (let ch = 0; ch < numChannels; ch++) {
      const src = channels[ch]!;
      const base = ch * segLen;
      for (let i = 0; i < valid; i++) input[base + i] = (src[start + i]! - mean) / std;
    }

    const result = await session.run({ data: input, dims: [1, numChannels, segLen] });
    const o = result.data; // [1, sources, channels, segLen] row-major
    const srcStride = numChannels * segLen;

    for (let s = 0; s < numSources; s++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const acc = out[s]![ch]!;
        const base = s * srcStride + ch * segLen;
        for (let i = 0; i < valid; i++) {
          const weight = weights[i]!;
          // de-normalise back to original scale
          acc[start + i]! += (o[base + i]! * std + mean) * weight;
        }
      }
    }
    for (let i = 0; i < valid; i++) weightSum[start + i]! += weights[i]!;

    opts.onProgress?.((w + 1) / numWindows);
  }

  // Divide by accumulated weights to finish the overlap-add.
  for (let i = 0; i < total; i++) {
    const denom = weightSum[i]! || 1;
    for (let s = 0; s < numSources; s++) {
      for (let ch = 0; ch < numChannels; ch++) out[s]![ch]![i]! /= denom;
    }
  }

  const stems: Stem[] = STEM_NAMES.map((name: StemName, s: number) => ({
    name,
    channels: out[s]!,
  }));

  return { sampleRate: sr, length: total, numChannels, stems };
}

/**
 * Sum selected stems into a single interleaved-per-channel mixdown.
 * Used for backend preset generation; the browser mixer uses Web Audio instead.
 */
export function sumStems(
  set: StemSet,
  includeNames: StemName[],
  gains?: Partial<Record<StemName, number>>,
): Float32Array[] {
  const mix: Float32Array[] = [];
  for (let ch = 0; ch < set.numChannels; ch++) mix.push(new Float32Array(set.length));
  for (const stem of set.stems) {
    if (!includeNames.includes(stem.name)) continue;
    const gain = gains?.[stem.name] ?? 1;
    if (gain === 0) continue;
    for (let ch = 0; ch < set.numChannels; ch++) {
      const src = stem.channels[ch]!;
      const dst = mix[ch]!;
      for (let i = 0; i < set.length; i++) dst[i]! += src[i]! * gain;
    }
  }
  return mix;
}
