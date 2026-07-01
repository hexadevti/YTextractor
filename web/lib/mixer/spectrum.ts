/** Draw a live frequency spectrum from an AnalyserNode onto a canvas. */

export function drawSpectrum(
  canvas: HTMLCanvasElement,
  analyser: AnalyserNode,
  data: Uint8Array<ArrayBuffer>,
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
  analyser.getByteFrequencyData(data);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Log-ish bin grouping so lows aren't crammed into the first few pixels.
  const bars = 48;
  const barWidth = w / bars;
  const bins = data.length;
  ctx.fillStyle = color;
  for (let i = 0; i < bars; i++) {
    const from = Math.floor(Math.pow(i / bars, 2) * bins);
    const to = Math.max(from + 1, Math.floor(Math.pow((i + 1) / bars, 2) * bins));
    let sum = 0;
    for (let j = from; j < to && j < bins; j++) sum += data[j]!;
    const avg = sum / (to - from);
    const barHeight = (avg / 255) * h;
    ctx.globalAlpha = 0.35 + (avg / 255) * 0.65;
    ctx.fillRect(i * barWidth, h - barHeight, Math.max(1, barWidth - 1), barHeight);
  }
  ctx.globalAlpha = 1;
}

/** Allocate the reusable byte buffer for an analyser's frequency bins. */
export function freqBuffer(analyser: AnalyserNode): Uint8Array<ArrayBuffer> {
  return new Uint8Array(analyser.frequencyBinCount);
}
