/**
 * Whole-song music statistics for the stats panel: key/scale, tempo, loudness
 * (approx LUFS), dynamic range, tempo stability, and per-stem presence.
 *
 * LUFS here is a rough proxy (RMS dBFS shifted) — no K-weighting/gating — good
 * enough for relative comparison, not broadcast measurement.
 */

import type { StemName } from '@ytx/shared';
import { detectKey, detectTempo, tempoStability, toMono } from './analyze';
import { renderProject } from './export';
import { totalDuration, type EditorProject, type EditorTrack } from './model';

export interface MusicStats {
  key: string;
  scale: 'Major' | 'Minor';
  bpm: number;
  lufs: number;
  peakDb: number;
  durationSec: number;
  dynamicRange: number;
  dynamicLabel: string;
  tempoStability: number;
  stabilityLabel: string;
  stems: { name: StemName; presence: number }[];
}

function levels(mono: Float32Array): { rmsDb: number; peakDb: number } {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < mono.length; i++) {
    const v = mono[i]!;
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / Math.max(1, mono.length));
  return { rmsDb: 20 * Math.log10(rms || 1e-9), peakDb: 20 * Math.log10(peak || 1e-9) };
}

function trackRms(track: EditorTrack): number {
  let sum = 0;
  let n = 0;
  for (const c of track.clips) {
    const sr = c.buffer.sampleRate;
    const s0 = Math.floor(c.offsetSec * sr);
    const len = Math.floor(c.durationSec * sr);
    for (let ch = 0; ch < c.buffer.numberOfChannels; ch++) {
      const d = c.buffer.getChannelData(ch);
      for (let i = s0; i < s0 + len && i < d.length; i++) {
        sum += d[i]! * d[i]!;
        n++;
      }
    }
  }
  return n ? Math.sqrt(sum / n) : 0;
}

export async function computeMusicStats(project: EditorProject): Promise<MusicStats> {
  const mix = await renderProject(project);
  const mono = toMono(mix);
  const bpm = detectTempo(mix);
  const { key, scale } = detectKey(mix);
  const { rmsDb, peakDb } = levels(mono);
  const lufs = -0.691 + rmsDb;
  const dr = peakDb - rmsDb;
  const dynamicLabel = dr >= 14 ? 'Wide' : dr >= 8 ? 'Medium' : 'Narrow';
  const stab = tempoStability(mix, bpm);
  const stabilityLabel = stab >= 90 ? 'Very Stable' : stab >= 70 ? 'Stable' : 'Variable';

  const stemTracks = project.tracks.filter((t) => !!t.stem);
  const rmsList = stemTracks.map((t) => ({ name: t.stem as StemName, rms: trackRms(t) }));
  const maxRms = Math.max(1e-9, ...rmsList.map((s) => s.rms));
  const stems = rmsList.map((s) => ({
    name: s.name,
    presence: Math.round((s.rms / maxRms) * 100),
  }));

  return {
    key,
    scale,
    bpm,
    lufs: Math.round(lufs * 10) / 10,
    peakDb: Math.round(peakDb * 10) / 10,
    durationSec: totalDuration(project),
    dynamicRange: Math.round(dr * 10) / 10,
    dynamicLabel,
    tempoStability: stab,
    stabilityLabel,
    stems,
  };
}
