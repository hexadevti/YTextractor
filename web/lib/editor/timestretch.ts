/**
 * Pitch-preserving time-stretch (WSOLA) for the "keep pitch" speed mode.
 *
 * Web Audio's AudioBufferSourceNode.playbackRate changes speed AND pitch
 * (chipmunk effect). To change tempo while keeping pitch we resynthesize the
 * audio at a different length using WSOLA (Waveform-Similarity Overlap-Add):
 * regularly-spaced output frames are filled with the best-correlated input
 * frames (Hann-windowed, 50% overlap → the windows tile to unity), so pitch
 * periods line up and there is no warble.
 *
 * The correlation search runs on an 8× decimated mono reference to keep a full
 * song's worth of stems fast enough to stretch on the main thread (a few
 * hundred ms per stem); the copy itself is full-resolution per channel.
 */

const FRAME = 2048; // analysis/synthesis window length (~46 ms @ 44.1k; aligns bass to ~43 Hz)
const SYN_HOP = FRAME >> 1; // synthesis hop (regular output spacing) → 50% overlap
const OVERLAP = FRAME - SYN_HOP; // == SYN_HOP; the region compared during the search
const DECIM = 4; // coarse-search decimation factor
const SEEK = SYN_HOP; // ± search tolerance (full-res samples)

function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** Linear-interpolation resample (fallback for clips shorter than a couple frames). */
function resample(channels: Float32Array[], outLen: number): Float32Array[] {
  const inLen = channels[0]?.length ?? 0;
  return channels.map((src) => {
    const out = new Float32Array(outLen);
    if (inLen < 2) {
      out.fill(src[0] ?? 0);
      return out;
    }
    const step = (inLen - 1) / Math.max(1, outLen - 1);
    for (let i = 0; i < outLen; i++) {
      const x = i * step;
      const i0 = Math.floor(x);
      const frac = x - i0;
      const a = src[i0] ?? 0;
      const b = src[i0 + 1] ?? a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  });
}

/**
 * Time-stretch `channels` by `factor` (output length ≈ input length × factor)
 * preserving pitch. factor < 1 compresses (plays faster), factor > 1 expands.
 */
export function timeStretch(channels: Float32Array[], factor: number): Float32Array[] {
  const chs = channels.length;
  const inLen = channels[0]?.length ?? 0;
  if (chs === 0 || inLen === 0 || factor === 1) return channels.map((c) => c.slice());

  const outLen = Math.max(1, Math.round(inLen * factor));
  if (inLen < FRAME * 2) return resample(channels, outLen);

  const anaHop = Math.max(1, Math.round(SYN_HOP / factor)); // input advance per output frame
  const win = hann(FRAME);
  const out: Float32Array[] = [];
  for (let c = 0; c < chs; c++) out.push(new Float32Array(outLen + FRAME));

  // Mono reference for the similarity search: full-resolution for sample-accurate
  // phase alignment, plus a decimated copy for a fast coarse period search.
  const monoF = new Float32Array(inLen);
  for (let i = 0; i < inLen; i++) {
    let s = 0;
    for (let c = 0; c < chs; c++) s += channels[c]![i] ?? 0;
    monoF[i] = s / chs;
  }
  const monoLen = Math.ceil(inLen / DECIM);
  const mono = new Float32Array(monoLen);
  for (let i = 0, j = 0; i < inLen; i += DECIM, j++) mono[j] = monoF[i]!;

  const ovD = Math.max(1, Math.floor(OVERLAP / DECIM)); // overlap length, decimated
  const seekD = Math.max(1, Math.round(SEEK / DECIM));
  const maxIn = inLen - FRAME;

  const overlapAdd = (inPos: number, outPos: number) => {
    const last = Math.min(FRAME, inLen - inPos);
    for (let c = 0; c < chs; c++) {
      const oc = out[c]!;
      const cc = channels[c]!;
      for (let k = 0; k < last; k++) {
        const o = outPos + k;
        oc[o] = (oc[o] ?? 0) + win[k]! * (cc[inPos + k] ?? 0);
      }
    }
  };

  // First frame is copied straight; subsequent frames are aligned to the
  // "natural continuation" of the previous frame (its samples one synth-hop on).
  let inPos = 0;
  let outPos = 0;
  overlapAdd(inPos, outPos);
  outPos += SYN_HOP;
  // The ideal analysis position advances by a FIXED hop every frame. The search
  // only nudges which nearby frame we actually copy (±SEEK); that nudge must NOT
  // feed back into the next target, or the offsets accumulate and the tempo
  // drifts (the audio slowly slips out of sync over the length of the clip).
  let ideal = anaHop;

  while (outPos + FRAME <= outLen + FRAME && ideal < maxIn) {
    const refStart = inPos + SYN_HOP; // continuation of the last copied frame
    const target = ideal; // fixed, non-accumulating analysis position

    // --- coarse search (decimated): pick the right period near the target. A
    // small distance penalty breaks ties toward the target, so a periodic
    // signal (equal correlation every period) can't jump a whole period. ---
    const refStartD = Math.round(refStart / DECIM);
    let er = 0;
    for (let i = 0; i < ovD; i++) {
      const v = mono[refStartD + i] ?? 0;
      er += v * v;
    }
    const refNorm = Math.sqrt(er) || 1e-9;
    const targetD = Math.round(target / DECIM);
    const lo = Math.max(0, targetD - seekD);
    const hi = Math.min(monoLen - ovD - 1, targetD + seekD);
    let bestD = targetD;
    let bestScore = -Infinity;
    for (let cand = lo; cand <= hi; cand++) {
      let dot = 0;
      let ec = 0;
      for (let i = 0; i < ovD; i++) {
        const cv = mono[cand + i] ?? 0;
        dot += cv * (mono[refStartD + i] ?? 0);
        ec += cv * cv;
      }
      const score = dot / ((Math.sqrt(ec) || 1e-9) * refNorm) - 1e-4 * Math.abs(cand - targetD);
      if (score > bestScore) {
        bestScore = score;
        bestD = cand;
      }
    }

    // --- fine search (full-res) around the coarse pick for sample-accurate
    // phase alignment (the decimated grid is too coarse for short periods). ---
    let er2 = 0;
    for (let i = 0; i < OVERLAP; i++) {
      const v = monoF[refStart + i] ?? 0;
      er2 += v * v;
    }
    const refN2 = Math.sqrt(er2) || 1e-9;
    const center = bestD * DECIM;
    const flo = Math.max(0, center - 3 * DECIM);
    const fhi = Math.min(maxIn, center + 3 * DECIM);
    let bestPos = center;
    let bestFine = -Infinity;
    for (let p = flo; p <= fhi; p++) {
      let dot = 0;
      let ec = 0;
      for (let i = 0; i < OVERLAP; i++) {
        const cv = monoF[p + i] ?? 0;
        dot += cv * (monoF[refStart + i] ?? 0);
        ec += cv * cv;
      }
      const score = dot / ((Math.sqrt(ec) || 1e-9) * refN2);
      if (score > bestFine) {
        bestFine = score;
        bestPos = p;
      }
    }

    inPos = Math.min(maxIn, Math.max(0, bestPos));
    overlapAdd(inPos, outPos);
    outPos += SYN_HOP;
    ideal += anaHop; // fixed advance — no accumulation of the search nudges
  }

  return out.map((c) => c.subarray(0, outLen));
}
