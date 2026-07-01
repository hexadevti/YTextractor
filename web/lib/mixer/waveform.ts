/** Precompute waveform peaks from an AudioBuffer and draw them on a canvas. */

export interface Peaks {
  /** min[i]/max[i] amplitude per pixel bucket, in [-1, 1] */
  min: Float32Array;
  max: Float32Array;
  buckets: number;
}

/** Reduce a buffer (mono-summed) to `buckets` min/max pairs. */
export function computePeaks(buffer: AudioBuffer, buckets: number): Peaks {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const length = buffer.length;
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const per = Math.max(1, Math.floor(length / buckets));
  for (let b = 0; b < buckets; b++) {
    let lo = 1;
    let hi = -1;
    const start = b * per;
    const end = Math.min(length, start + per);
    for (let i = start; i < end; i++) {
      let s = 0;
      for (let c = 0; c < channels.length; c++) s += channels[c]![i]!;
      s /= channels.length;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max, buckets };
}

export function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: Peaks,
  color: string,
): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const mid = h / 2;
  ctx.fillStyle = color;
  const step = w / peaks.buckets;
  for (let b = 0; b < peaks.buckets; b++) {
    const x = b * step;
    const top = mid - peaks.max[b]! * mid;
    const bottom = mid - peaks.min[b]! * mid;
    ctx.fillRect(x, top, Math.max(1, step - 0.5), Math.max(1, bottom - top));
  }
}
