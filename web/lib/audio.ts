/**
 * Browser audio helpers: decode arbitrary audio bytes and normalise them to the
 * 44.1 kHz stereo layout the Demucs model expects.
 */

import { MODEL_CHANNELS, MODEL_SAMPLE_RATE, type StemSet, STEM_NAMES } from '@ytx/shared';

export interface DecodedAudio {
  channels: Float32Array[]; // length MODEL_CHANNELS
  sampleRate: number; // MODEL_SAMPLE_RATE
  length: number;
}

/** Decode + resample to 44.1 kHz stereo Float32 channels. */
export async function decodeToModelAudio(bytes: ArrayBuffer): Promise<DecodedAudio> {
  const tmp = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await tmp.decodeAudioData(bytes.slice(0));
  } finally {
    void tmp.close();
  }

  const needsResample =
    decoded.sampleRate !== MODEL_SAMPLE_RATE || decoded.numberOfChannels !== MODEL_CHANNELS;

  let buffer = decoded;
  if (needsResample) {
    const frames = Math.ceil(decoded.duration * MODEL_SAMPLE_RATE);
    const offline = new OfflineAudioContext(MODEL_CHANNELS, frames, MODEL_SAMPLE_RATE);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0);
    buffer = await offline.startRendering();
  }

  const channels: Float32Array[] = [];
  for (let c = 0; c < MODEL_CHANNELS; c++) {
    const srcChannel = c < buffer.numberOfChannels ? c : 0;
    channels.push(Float32Array.from(buffer.getChannelData(srcChannel)));
  }
  return { channels, sampleRate: MODEL_SAMPLE_RATE, length: buffer.length };
}

/**
 * Build a StemSet from per-stem decoded audio (used when the backend returns
 * stems as separate audio files). `order` follows STEM_NAMES.
 */
export function stemSetFromChannels(
  perStemChannels: Float32Array[][],
  sampleRate: number,
): StemSet {
  const length = perStemChannels[0]?.[0]?.length ?? 0;
  const numChannels = perStemChannels[0]?.length ?? MODEL_CHANNELS;
  return {
    sampleRate,
    length,
    numChannels,
    stems: STEM_NAMES.map((name, i) => ({
      name,
      channels: perStemChannels[i] ?? [],
    })),
  };
}
