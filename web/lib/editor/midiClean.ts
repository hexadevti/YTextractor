/** Cleanup utilities for transcribed MIDI: drop noise notes, and monophonic (bass) reduction. */

import type { MidiNote } from './model';

export interface CleanOpts {
  minDur?: number; // seconds — drop shorter notes
  minVel?: number; // 1..127 — drop quieter notes
  mergeGap?: number; // seconds — merge same-pitch notes closer than this
}

/** Remove short/quiet "noise" notes and merge near-adjacent same-pitch notes. */
export function cleanNotes(notes: MidiNote[], opts: CleanOpts = {}): MidiNote[] {
  const minDur = opts.minDur ?? 0.07;
  const minVel = opts.minVel ?? 8;
  const mergeGap = opts.mergeGap ?? 0.04;

  const kept = notes
    .filter((n) => n.durationSec >= minDur && n.velocity >= minVel)
    .map((n) => ({ ...n }))
    .sort((a, b) => a.pitch - b.pitch || a.startSec - b.startSec);

  const merged: MidiNote[] = [];
  for (const n of kept) {
    const last = merged[merged.length - 1];
    if (last && last.pitch === n.pitch && n.startSec - (last.startSec + last.durationSec) < mergeGap) {
      last.durationSec = Math.max(last.durationSec, n.startSec + n.durationSec - last.startSec);
      last.velocity = Math.max(last.velocity, n.velocity);
    } else {
      merged.push(n);
    }
  }
  return merged.sort((a, b) => a.startSec - b.startSec);
}

/**
 * Reduce to a clean monophonic line (one note at a time). Good for bass: keeps
 * the lowest note when notes overlap. Cleans noise first.
 */
export function toMonophonic(
  notes: MidiNote[],
  mode: 'low' | 'high' = 'low',
  opts: CleanOpts = {},
): MidiNote[] {
  const sorted = cleanNotes(notes, opts).sort((a, b) => a.startSec - b.startSec);
  const out: MidiNote[] = [];
  for (const n of sorted) {
    const cur = { ...n };
    const last = out[out.length - 1];
    if (!last) {
      out.push(cur);
      continue;
    }
    const lastEnd = last.startSec + last.durationSec;
    if (cur.startSec < lastEnd - 0.01) {
      // overlap — prefer lower (bass) / higher note
      const preferNew = mode === 'low' ? cur.pitch < last.pitch : cur.pitch > last.pitch;
      if (preferNew) {
        last.durationSec = Math.max(0.03, cur.startSec - last.startSec); // cut previous short
        out.push(cur);
      } else {
        const curEnd = cur.startSec + cur.durationSec;
        if (curEnd > lastEnd + 0.02) {
          out.push({ ...cur, startSec: lastEnd, durationSec: curEnd - lastEnd });
        }
      }
    } else {
      out.push(cur);
    }
  }
  return out;
}
