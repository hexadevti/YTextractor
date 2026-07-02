/**
 * General-MIDI instrument bank for MIDI tracks.
 *
 * `name` is the smplr soundfont id (GM name, snake_case). `gm` is the GM program
 * number (used for .mid export). `fallbackOsc` maps a program to oscillator
 * params so the built-in synth can approximate an instrument until smplr's
 * samples finish loading (or if they fail to load).
 */

export interface GMInstrument {
  name: string;
  label: string;
  gm: number; // 0..127
  group: string;
}

export interface OscParams {
  osc: OscillatorType;
  attack: number;
  release: number;
  gain: number;
}

// GM families in program order — [smplr name, label]
const GROUPS: { group: string; items: [string, string][] }[] = [
  {
    group: 'Piano',
    items: [
      ['acoustic_grand_piano', 'Acoustic Grand Piano'],
      ['bright_acoustic_piano', 'Bright Acoustic Piano'],
      ['electric_grand_piano', 'Electric Grand Piano'],
      ['honkytonk_piano', 'Honky-tonk Piano'],
      ['electric_piano_1', 'Electric Piano 1'],
      ['electric_piano_2', 'Electric Piano 2'],
      ['harpsichord', 'Harpsichord'],
      ['clavinet', 'Clavinet'],
    ],
  },
  {
    group: 'Chromatic Percussion',
    items: [
      ['celesta', 'Celesta'],
      ['glockenspiel', 'Glockenspiel'],
      ['music_box', 'Music Box'],
      ['vibraphone', 'Vibraphone'],
      ['marimba', 'Marimba'],
      ['xylophone', 'Xylophone'],
      ['tubular_bells', 'Tubular Bells'],
      ['dulcimer', 'Dulcimer'],
    ],
  },
  {
    group: 'Organ',
    items: [
      ['drawbar_organ', 'Drawbar Organ'],
      ['percussive_organ', 'Percussive Organ'],
      ['rock_organ', 'Rock Organ'],
      ['church_organ', 'Church Organ'],
      ['reed_organ', 'Reed Organ'],
      ['accordion', 'Accordion'],
      ['harmonica', 'Harmonica'],
      ['tango_accordion', 'Tango Accordion'],
    ],
  },
  {
    group: 'Guitar',
    items: [
      ['acoustic_guitar_nylon', 'Acoustic Guitar (nylon)'],
      ['acoustic_guitar_steel', 'Acoustic Guitar (steel)'],
      ['electric_guitar_jazz', 'Electric Guitar (jazz)'],
      ['electric_guitar_clean', 'Electric Guitar (clean)'],
      ['electric_guitar_muted', 'Electric Guitar (muted)'],
      ['overdriven_guitar', 'Overdriven Guitar'],
      ['distortion_guitar', 'Distortion Guitar'],
      ['guitar_harmonics', 'Guitar Harmonics'],
    ],
  },
  {
    group: 'Bass',
    items: [
      ['acoustic_bass', 'Acoustic Bass'],
      ['electric_bass_finger', 'Electric Bass (finger)'],
      ['electric_bass_pick', 'Electric Bass (pick)'],
      ['fretless_bass', 'Fretless Bass'],
      ['slap_bass_1', 'Slap Bass 1'],
      ['slap_bass_2', 'Slap Bass 2'],
      ['synth_bass_1', 'Synth Bass 1'],
      ['synth_bass_2', 'Synth Bass 2'],
    ],
  },
  {
    group: 'Strings',
    items: [
      ['violin', 'Violin'],
      ['viola', 'Viola'],
      ['cello', 'Cello'],
      ['contrabass', 'Contrabass'],
      ['tremolo_strings', 'Tremolo Strings'],
      ['pizzicato_strings', 'Pizzicato Strings'],
      ['orchestral_harp', 'Orchestral Harp'],
      ['timpani', 'Timpani'],
    ],
  },
  {
    group: 'Ensemble',
    items: [
      ['string_ensemble_1', 'String Ensemble 1'],
      ['string_ensemble_2', 'String Ensemble 2'],
      ['synth_strings_1', 'Synth Strings 1'],
      ['synth_strings_2', 'Synth Strings 2'],
      ['choir_aahs', 'Choir Aahs'],
      ['voice_oohs', 'Voice Oohs'],
      ['synth_choir', 'Synth Voice'],
      ['orchestra_hit', 'Orchestra Hit'],
    ],
  },
  {
    group: 'Brass',
    items: [
      ['trumpet', 'Trumpet'],
      ['trombone', 'Trombone'],
      ['tuba', 'Tuba'],
      ['muted_trumpet', 'Muted Trumpet'],
      ['french_horn', 'French Horn'],
      ['brass_section', 'Brass Section'],
      ['synth_brass_1', 'Synth Brass 1'],
      ['synth_brass_2', 'Synth Brass 2'],
    ],
  },
  {
    group: 'Reed',
    items: [
      ['soprano_sax', 'Soprano Sax'],
      ['alto_sax', 'Alto Sax'],
      ['tenor_sax', 'Tenor Sax'],
      ['baritone_sax', 'Baritone Sax'],
      ['oboe', 'Oboe'],
      ['english_horn', 'English Horn'],
      ['bassoon', 'Bassoon'],
      ['clarinet', 'Clarinet'],
    ],
  },
  {
    group: 'Pipe',
    items: [
      ['piccolo', 'Piccolo'],
      ['flute', 'Flute'],
      ['recorder', 'Recorder'],
      ['pan_flute', 'Pan Flute'],
      ['blown_bottle', 'Blown Bottle'],
      ['shakuhachi', 'Shakuhachi'],
      ['whistle', 'Whistle'],
      ['ocarina', 'Ocarina'],
    ],
  },
  {
    group: 'Synth Lead',
    items: [
      ['lead_1_square', 'Lead 1 (square)'],
      ['lead_2_sawtooth', 'Lead 2 (sawtooth)'],
      ['lead_3_calliope', 'Lead 3 (calliope)'],
      ['lead_4_chiff', 'Lead 4 (chiff)'],
      ['lead_5_charang', 'Lead 5 (charang)'],
      ['lead_6_voice', 'Lead 6 (voice)'],
      ['lead_7_fifths', 'Lead 7 (fifths)'],
      ['lead_8_bass__lead', 'Lead 8 (bass + lead)'],
    ],
  },
  {
    group: 'Synth Pad',
    items: [
      ['pad_1_new_age', 'Pad 1 (new age)'],
      ['pad_2_warm', 'Pad 2 (warm)'],
      ['pad_3_polysynth', 'Pad 3 (polysynth)'],
      ['pad_4_choir', 'Pad 4 (choir)'],
      ['pad_5_bowed', 'Pad 5 (bowed)'],
      ['pad_6_metallic', 'Pad 6 (metallic)'],
      ['pad_7_halo', 'Pad 7 (halo)'],
      ['pad_8_sweep', 'Pad 8 (sweep)'],
    ],
  },
  {
    group: 'Synth Effects',
    items: [
      ['fx_1_rain', 'FX 1 (rain)'],
      ['fx_2_soundtrack', 'FX 2 (soundtrack)'],
      ['fx_3_crystal', 'FX 3 (crystal)'],
      ['fx_4_atmosphere', 'FX 4 (atmosphere)'],
      ['fx_5_brightness', 'FX 5 (brightness)'],
      ['fx_6_goblins', 'FX 6 (goblins)'],
      ['fx_7_echoes', 'FX 7 (echoes)'],
      ['fx_8_scifi', 'FX 8 (sci-fi)'],
    ],
  },
  {
    group: 'Ethnic',
    items: [
      ['sitar', 'Sitar'],
      ['banjo', 'Banjo'],
      ['shamisen', 'Shamisen'],
      ['koto', 'Koto'],
      ['kalimba', 'Kalimba'],
      ['bagpipe', 'Bagpipe'],
      ['fiddle', 'Fiddle'],
      ['shanai', 'Shanai'],
    ],
  },
  {
    group: 'Percussive',
    items: [
      ['tinkle_bell', 'Tinkle Bell'],
      ['agogo', 'Agogo'],
      ['steel_drums', 'Steel Drums'],
      ['woodblock', 'Woodblock'],
      ['taiko_drum', 'Taiko Drum'],
      ['melodic_tom', 'Melodic Tom'],
      ['synth_drum', 'Synth Drum'],
      ['reverse_cymbal', 'Reverse Cymbal'],
    ],
  },
  {
    group: 'Sound Effects',
    items: [
      ['guitar_fret_noise', 'Guitar Fret Noise'],
      ['breath_noise', 'Breath Noise'],
      ['seashore', 'Seashore'],
      ['bird_tweet', 'Bird Tweet'],
      ['telephone_ring', 'Telephone Ring'],
      ['helicopter', 'Helicopter'],
      ['applause', 'Applause'],
      ['gunshot', 'Gunshot'],
    ],
  },
];

export const INSTRUMENTS: GMInstrument[] = GROUPS.flatMap((g, gi) =>
  g.items.map(([name, label], i) => ({ name, label, group: g.group, gm: gi * 8 + i })),
);

const BY_NAME = new Map(INSTRUMENTS.map((i) => [i.name, i]));

/** Grouped for <optgroup> rendering. */
export const INSTRUMENT_GROUPS = GROUPS.map((g) => ({
  group: g.group,
  items: g.items.map(([name]) => BY_NAME.get(name)!),
}));

/** Legacy oscillator-era ids → GM names (backward compat with old saves). */
const LEGACY: Record<string, string> = {
  synth: 'lead_2_sawtooth',
  square: 'lead_1_square',
  piano: 'acoustic_grand_piano',
  ebass: 'electric_bass_finger',
  sbass: 'synth_bass_1',
  organ: 'rock_organ',
  strings: 'string_ensemble_1',
};

const DEFAULT = BY_NAME.get('acoustic_grand_piano')!;

export function getInstrument(idOrName?: string): GMInstrument {
  if (!idOrName) return DEFAULT;
  return BY_NAME.get(idOrName) ?? BY_NAME.get(LEGACY[idOrName] ?? '') ?? DEFAULT;
}

/** Oscillator approximation used as fallback until samples load. */
export function fallbackOsc(gm: number): OscParams {
  if (gm >= 32 && gm <= 39) return { osc: 'sine', attack: 0.004, release: 0.09, gain: 0.3 }; // bass
  if (gm >= 16 && gm <= 23) return { osc: 'square', attack: 0.01, release: 0.04, gain: 0.14 }; // organ
  if ((gm >= 40 && gm <= 55) || (gm >= 88 && gm <= 95))
    return { osc: 'sawtooth', attack: 0.05, release: 0.16, gain: 0.12 }; // strings/pads
  if (gm >= 56 && gm <= 87) return { osc: 'sawtooth', attack: 0.006, release: 0.06, gain: 0.14 }; // brass/reed/lead
  if (gm >= 72 && gm <= 79) return { osc: 'triangle', attack: 0.02, release: 0.08, gain: 0.16 }; // pipe
  if (gm >= 24 && gm <= 31) return { osc: 'sawtooth', attack: 0.004, release: 0.1, gain: 0.16 }; // guitar
  return { osc: 'triangle', attack: 0.002, release: 0.14, gain: 0.22 }; // piano/default
}
