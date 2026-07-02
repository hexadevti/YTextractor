/**
 * Offline analysis of a rendered mix: tempo (BPM) and chords.
 *
 * Tempo: energy-onset envelope + autocorrelation over a plausible BPM range.
 * Chords: STFT → 12-bin chroma → correlate with major/minor triad templates,
 * then merge into time segments.
 */

export interface ChordSegment {
  startSec: number;
  endSec: number;
  label: string;
}

/** pitch-class 0 = A (since the log-freq mapping is anchored at 440 Hz = A4). */
const NOTE_NAMES = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'];

export function toMono(buffer: AudioBuffer): Float32Array {
  const n = buffer.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] = out[i]! + ch[i]!;
  }
  const inv = 1 / Math.max(1, buffer.numberOfChannels);
  for (let i = 0; i < n; i++) out[i] = out[i]! * inv;
  return out;
}

/* ---------------- tempo ---------------- */

export function detectTempo(buffer: AudioBuffer, minBpm = 60, maxBpm = 200): number {
  const x = toMono(buffer);
  const sr = buffer.sampleRate;
  const hop = 512;
  const nFrames = Math.floor(x.length / hop);
  const onset = new Float32Array(nFrames);
  let prev = 0;
  for (let f = 0; f < nFrames; f++) {
    let e = 0;
    const base = f * hop;
    for (let i = 0; i < hop; i++) {
      const v = x[base + i] ?? 0;
      e += v * v;
    }
    onset[f] = Math.max(0, e - prev);
    prev = e;
  }
  // normalise
  let mean = 0;
  for (let f = 0; f < nFrames; f++) mean += onset[f]!;
  mean /= nFrames || 1;
  for (let f = 0; f < nFrames; f++) onset[f] = Math.max(0, onset[f]! - mean);

  const onsetRate = sr / hop;
  let bestBpm = 120;
  let bestScore = -Infinity;
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 1) {
    const lag = Math.round((onsetRate * 60) / bpm);
    if (lag < 1 || lag >= nFrames) continue;
    let sum = 0;
    for (let f = lag; f < nFrames; f++) sum += onset[f]! * onset[f - lag]!;
    // slight preference for mid-tempo to avoid octave errors
    const weight = 1 - Math.abs(Math.log2(bpm / 120)) * 0.08;
    const score = sum * weight;
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }
  return Math.round(bestBpm);
}

/* ---------------- FFT ---------------- */

function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len >> 1; k++) {
        const idx = i + k;
        const idx2 = idx + (len >> 1);
        const vr = re[idx2]! * cr - im[idx2]! * ci;
        const vi = re[idx2]! * ci + im[idx2]! * cr;
        const ur = re[idx]!;
        const ui = im[idx]!;
        re[idx] = ur + vr;
        im[idx] = ui + vi;
        re[idx2] = ur - vr;
        im[idx2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/* ---------------- key ---------------- */

// Krumhansl–Schmuckler tonic-relative key profiles.
const KS_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function corr(a: number[], b: number[]): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / (Math.sqrt(da * db) || 1);
}

export function detectKey(buffer: AudioBuffer): { key: string; scale: 'Major' | 'Minor' } {
  const x = toMono(buffer);
  const sr = buffer.sampleRate;
  const N = 4096;
  const hop = 4096;
  const nFrames = Math.floor((x.length - N) / hop);
  if (nFrames <= 0) return { key: '—', scale: 'Major' };
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const chroma = new Array(12).fill(0);
  const minBin = Math.max(1, Math.floor((55 * N) / sr));
  const maxBin = Math.min(N >> 1, Math.floor((2000 * N) / sr));
  for (let f = 0; f < nFrames; f++) {
    const base = f * hop;
    for (let i = 0; i < N; i++) {
      re[i] = (x[base + i] ?? 0) * win[i]!;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = minBin; k <= maxBin; k++) {
      const mag = Math.hypot(re[k]!, im[k]!);
      const pc = ((Math.round(12 * Math.log2(((k * sr) / N) / 440)) % 12) + 12) % 12;
      chroma[pc] += mag;
    }
  }
  let bestScore = -Infinity;
  let bestRoot = 0;
  let bestMaj = true;
  for (let t = 0; t < 12; t++) {
    const rot = Array.from({ length: 12 }, (_, i) => chroma[(t + i) % 12]);
    const maj = corr(rot, KS_MAJ);
    const min = corr(rot, KS_MIN);
    if (maj > bestScore) {
      bestScore = maj;
      bestRoot = t;
      bestMaj = true;
    }
    if (min > bestScore) {
      bestScore = min;
      bestRoot = t;
      bestMaj = false;
    }
  }
  return {
    key: `${NOTE_NAMES[bestRoot]} ${bestMaj ? 'maj' : 'min'}`,
    scale: bestMaj ? 'Major' : 'Minor',
  };
}

/** Rhythmic regularity as a 0..100 percentage (higher = steadier tempo). */
export function tempoStability(buffer: AudioBuffer, bpm: number): number {
  const x = toMono(buffer);
  const sr = buffer.sampleRate;
  const hop = 512;
  const nFrames = Math.floor(x.length / hop);
  if (nFrames < 8 || bpm <= 0) return 0;
  const onset = new Float32Array(nFrames);
  let prev = 0;
  let mean = 0;
  for (let f = 0; f < nFrames; f++) {
    let e = 0;
    const base = f * hop;
    for (let i = 0; i < hop; i++) {
      const v = x[base + i] ?? 0;
      e += v * v;
    }
    onset[f] = Math.max(0, e - prev);
    prev = e;
    mean += onset[f]!;
  }
  mean /= nFrames;
  const thr = mean * 1.5;
  const peaks: number[] = [];
  for (let f = 1; f < nFrames - 1; f++) {
    if (onset[f]! > thr && onset[f]! >= onset[f - 1]! && onset[f]! > onset[f + 1]!) peaks.push(f);
  }
  if (peaks.length < 4) return 50;
  const iv: number[] = [];
  for (let i = 1; i < peaks.length; i++) iv.push(peaks[i]! - peaks[i - 1]!);
  let m = 0;
  for (const v of iv) m += v;
  m /= iv.length;
  let sd = 0;
  for (const v of iv) sd += (v - m) * (v - m);
  sd = Math.sqrt(sd / iv.length);
  const cv = sd / (m || 1);
  return Math.round(Math.max(0, Math.min(100, 100 * (1 - cv))));
}

/* ---------------- chords ---------------- */

export function detectChords(buffer: AudioBuffer): ChordSegment[] {
  const x = toMono(buffer);
  const sr = buffer.sampleRate;
  const N = 4096;
  const hop = 4096;
  const nFrames = Math.floor((x.length - N) / hop);
  if (nFrames <= 0) return [];

  // Hann window
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  // triad templates (12 major + 12 minor), pc 0 = A
  const templates: { label: string; vec: number[] }[] = [];
  for (let r = 0; r < 12; r++) {
    const maj = new Array(12).fill(0);
    [r, (r + 4) % 12, (r + 7) % 12].forEach((p) => (maj[p] = 1));
    templates.push({ label: NOTE_NAMES[r]!, vec: maj });
    const min = new Array(12).fill(0);
    [r, (r + 3) % 12, (r + 7) % 12].forEach((p) => (min[p] = 1));
    templates.push({ label: NOTE_NAMES[r]! + 'm', vec: min });
  }

  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const perFrame: string[] = [];

  const minBin = Math.max(1, Math.floor((55 * N) / sr));
  const maxBin = Math.min(N >> 1, Math.floor((2000 * N) / sr));

  for (let f = 0; f < nFrames; f++) {
    const base = f * hop;
    for (let i = 0; i < N; i++) {
      re[i] = (x[base + i] ?? 0) * win[i]!;
      im[i] = 0;
    }
    fft(re, im);
    const chroma = new Float32Array(12);
    for (let k = minBin; k <= maxBin; k++) {
      const mag = Math.hypot(re[k]!, im[k]!);
      const freq = (k * sr) / N;
      const pc = ((Math.round(12 * Math.log2(freq / 440)) % 12) + 12) % 12;
      chroma[pc] = chroma[pc]! + mag;
    }
    // normalise
    let norm = 0;
    for (let p = 0; p < 12; p++) norm += chroma[p]! * chroma[p]!;
    norm = Math.sqrt(norm);
    if (norm < 1e-6) {
      perFrame.push('–');
      continue;
    }
    for (let p = 0; p < 12; p++) chroma[p] = chroma[p]! / norm;

    let best = '–';
    let bestScore = 0.55; // threshold for "some chord"
    for (const t of templates) {
      let dot = 0;
      for (let p = 0; p < 12; p++) dot += chroma[p]! * t.vec[p]!;
      dot /= Math.sqrt(3); // template norm
      if (dot > bestScore) {
        bestScore = dot;
        best = t.label;
      }
    }
    perFrame.push(best);
  }

  // merge consecutive frames into segments (drop very short ones)
  const secPerFrame = hop / sr;
  const raw: ChordSegment[] = [];
  let curLabel = perFrame[0]!;
  let curStart = 0;
  for (let f = 1; f <= perFrame.length; f++) {
    if (f === perFrame.length || perFrame[f] !== curLabel) {
      raw.push({ startSec: curStart * secPerFrame, endSec: f * secPerFrame, label: curLabel });
      if (f < perFrame.length) {
        curLabel = perFrame[f]!;
        curStart = f;
      }
    }
  }
  // merge short/no-chord segments into the previous
  const merged: ChordSegment[] = [];
  for (const seg of raw) {
    const dur = seg.endSec - seg.startSec;
    const last = merged[merged.length - 1];
    if (last && (dur < 0.4 || seg.label === '–' || seg.label === last.label)) {
      last.endSec = seg.endSec;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged.filter((s) => s.label !== '–');
}
