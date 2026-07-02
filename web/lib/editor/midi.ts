/** Minimal Standard MIDI File (Type-0) writer — no dependencies. */

import type { MidiNote } from './model';

function pushVlq(arr: number[], value: number) {
  let v = Math.max(0, Math.floor(value));
  let buffer = v & 0x7f;
  while ((v >>= 7)) {
    buffer <<= 8;
    buffer |= (v & 0x7f) | 0x80;
  }
  for (;;) {
    arr.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
}

interface SmfOpts {
  name?: string;
  ppq?: number; // ticks per quarter note
  bpm?: number;
  program?: number; // General MIDI program (instrument) 0..127
}

export function notesToSmf(notes: MidiNote[], opts: SmfOpts = {}): Uint8Array {
  const ppq = opts.ppq ?? 480;
  const bpm = opts.bpm ?? 120;
  const ticksPerSec = (ppq * bpm) / 60;

  type Ev = { tick: number; data: number[] };
  const events: Ev[] = [];
  for (const n of notes) {
    const pitch = Math.max(0, Math.min(127, Math.round(n.pitch)));
    const vel = Math.max(1, Math.min(127, Math.round(n.velocity)));
    const onTick = Math.max(0, Math.round(n.startSec * ticksPerSec));
    const offTick = Math.max(onTick + 1, Math.round((n.startSec + n.durationSec) * ticksPerSec));
    events.push({ tick: onTick, data: [0x90, pitch, vel] });
    events.push({ tick: offTick, data: [0x80, pitch, 0] });
  }
  // by tick, then note-offs (0x80) before note-ons (0x90) at the same tick
  events.sort((a, b) => a.tick - b.tick || (a.data[0]! & 0xf0) - (b.data[0]! & 0xf0));

  const track: number[] = [];
  // tempo meta
  const mpqn = Math.round(60000000 / bpm);
  pushVlq(track, 0);
  track.push(0xff, 0x51, 0x03, (mpqn >> 16) & 0xff, (mpqn >> 8) & 0xff, mpqn & 0xff);
  // track name
  if (opts.name) {
    const bytes = Array.from(opts.name).map((c) => c.charCodeAt(0) & 0x7f);
    pushVlq(track, 0);
    track.push(0xff, 0x03);
    pushVlq(track, bytes.length);
    track.push(...bytes);
  }
  // instrument (program change) on channel 0
  if (opts.program !== undefined) {
    pushVlq(track, 0);
    track.push(0xc0, opts.program & 0x7f);
  }
  let last = 0;
  for (const ev of events) {
    pushVlq(track, ev.tick - last);
    last = ev.tick;
    track.push(...ev.data);
  }
  // end of track
  pushVlq(track, 0);
  track.push(0xff, 0x2f, 0x00);

  const header = [
    0x4d, 0x54, 0x68, 0x64, // "MThd"
    0, 0, 0, 6, // header length
    0, 0, // format 0
    0, 1, // 1 track
    (ppq >> 8) & 0xff, ppq & 0xff, // division
  ];
  const len = track.length;
  const trkHeader = [
    0x4d, 0x54, 0x72, 0x6b, // "MTrk"
    (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff,
  ];
  return new Uint8Array([...header, ...trkHeader, ...track]);
}
