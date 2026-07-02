/** Tiny polyphonic synth: schedules MIDI notes as oscillator blips on a context. */

import { fallbackOsc, type OscParams } from './instruments';
import type { MidiNote } from './model';

function midiToHz(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

/**
 * Schedule notes to play from song position `fromSec`, with song-time 0 mapped
 * to context time `ctxStart`. Returns the created oscillators (to stop later).
 * This is the lightweight fallback used until sampled instruments load.
 */
export function scheduleMidi(
  ctx: BaseAudioContext,
  out: AudioNode,
  notes: MidiNote[],
  ctxStart: number,
  fromSec: number,
  params: OscParams = fallbackOsc(0),
  rate = 1,
): OscillatorNode[] {
  const created: OscillatorNode[] = [];
  const attack = params.attack;
  const release = params.release;
  for (const n of notes) {
    const end = n.startSec + n.durationSec;
    if (end <= fromSec + 1e-4) continue;
    const noteStart = Math.max(fromSec, n.startSec);
    const when = ctxStart + (noteStart - fromSec) / rate;
    const dur = Math.max(0.03, (end - noteStart) / rate);
    const level = params.gain * (n.velocity / 127);

    const osc = ctx.createOscillator();
    osc.type = params.osc;
    osc.frequency.value = midiToHz(n.pitch);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(level, when + attack);
    g.gain.setValueAtTime(level, Math.max(when + attack, when + dur - release));
    g.gain.linearRampToValueAtTime(0.0001, when + dur);
    osc.connect(g);
    g.connect(out);
    osc.start(when);
    osc.stop(when + dur + 0.03);
    created.push(osc);
  }
  return created;
}
