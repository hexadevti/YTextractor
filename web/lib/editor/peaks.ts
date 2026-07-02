/**
 * Waveform peaks for a clip's trimmed sub-range, cached per clip and recomputed
 * when the zoom (pxPerSec) or the clip's offset/duration changes.
 */

import type { Peaks } from '../mixer/waveform';
import type { Clip } from './model';

const cache = new Map<string, { key: string; peaks: Peaks }>();

function compute(clip: Clip, buckets: number): Peaks {
  const sr = clip.buffer.sampleRate;
  const startSample = Math.floor(clip.offsetSec * sr);
  const totalSamples = Math.max(1, Math.floor(clip.durationSec * sr));
  const nch = clip.buffer.numberOfChannels;
  const channels: Float32Array[] = [];
  for (let c = 0; c < nch; c++) channels.push(clip.buffer.getChannelData(c));

  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const per = Math.max(1, Math.floor(totalSamples / buckets));
  const bufLen = clip.buffer.length;

  for (let b = 0; b < buckets; b++) {
    let lo = 1;
    let hi = -1;
    const s0 = startSample + b * per;
    const e0 = Math.min(startSample + totalSamples, s0 + per, bufLen);
    for (let i = s0; i < e0; i++) {
      let s = 0;
      for (let c = 0; c < nch; c++) s += channels[c]![i]!;
      s /= nch;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    if (hi < lo) {
      lo = 0;
      hi = 0;
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max, buckets };
}

export function computeClipPeaks(clip: Clip, pxPerSec: number): Peaks {
  const buckets = Math.max(1, Math.round(clip.durationSec * pxPerSec));
  const key = `${clip.offsetSec.toFixed(4)}:${clip.durationSec.toFixed(4)}:${buckets}`;
  const cached = cache.get(clip.id);
  if (cached && cached.key === key) return cached.peaks;
  const peaks = compute(clip, buckets);
  cache.set(clip.id, { key, peaks });
  return peaks;
}

/** Drop cache entries for clips no longer present (call occasionally). */
export function prunePeakCache(liveClipIds: Set<string>) {
  for (const id of cache.keys()) {
    if (!liveClipIds.has(id)) cache.delete(id);
  }
}
