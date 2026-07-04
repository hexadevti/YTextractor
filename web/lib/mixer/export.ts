/**
 * Render the current mixer state to an audio file, entirely client-side.
 *
 * The audible mix (mute/solo/remove/volume applied) is rendered with an
 * OfflineAudioContext, then encoded to WAV (PCM) or MP3 (lamejs).
 */

import { Mp3Encoder } from '@breezystack/lamejs';
import type { MixerEngine } from './engine';
import { saveOrShare } from '../platform/save';

/** Render the audible channels down to a single AudioBuffer. */
export async function renderMix(engine: MixerEngine): Promise<AudioBuffer> {
  const plan = engine.getMixPlan();
  const numChannels = engine.numChannels;
  const length = engine.lengthSamples;
  const sampleRate = engine.sampleRate;

  const offline = new OfflineAudioContext(numChannels, Math.max(1, length), sampleRate);
  const master = offline.createGain();
  master.connect(offline.destination);

  for (const p of plan) {
    const src = offline.createBufferSource();
    src.buffer = p.buffer;
    const gain = offline.createGain();
    gain.gain.value = p.gain;
    src.connect(gain);
    gain.connect(master);
    src.start(0);
  }
  return offline.startRendering();
}

function floatToPcm16(sample: number): number {
  const s = Math.max(-1, Math.min(1, sample));
  return s < 0 ? s * 0x8000 : s * 0x7fff;
}

/**
 * Encode raw Float32 channels to a 16-bit PCM WAV Blob, without an intermediate
 * AudioBuffer. Saving a fresh split calls this once per stem, so avoiding the
 * extra full-length copy matters on memory-constrained mobile devices.
 */
export function encodeWavFromChannels(channels: Float32Array[], sampleRate: number): Blob {
  const numChannels = Math.max(1, channels.length);
  const length = channels[0]?.length ?? 0;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = length * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      view.setInt16(offset, floatToPcm16(channels[c]![i]!), true);
      offset += 2;
    }
  }
  return new Blob([out], { type: 'audio/wav' });
}

/** Encode an AudioBuffer to a 16-bit PCM WAV Blob. */
export function encodeWav(buffer: AudioBuffer): Blob {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return encodeWavFromChannels(channels, buffer.sampleRate);
}

/** Encode an AudioBuffer to MP3 using lamejs. */
export function encodeMp3(buffer: AudioBuffer, kbps = 192): Blob {
  const numChannels = Math.min(2, buffer.numberOfChannels);
  const sampleRate = buffer.sampleRate;
  const encoder = new Mp3Encoder(numChannels, sampleRate, kbps);
  const left = buffer.getChannelData(0);
  const right = numChannels > 1 ? buffer.getChannelData(1) : left;

  const blockSize = 1152;
  const chunks: Uint8Array[] = [];
  const l16 = new Int16Array(blockSize);
  const r16 = new Int16Array(blockSize);

  for (let i = 0; i < buffer.length; i += blockSize) {
    const n = Math.min(blockSize, buffer.length - i);
    for (let j = 0; j < n; j++) {
      l16[j] = floatToPcm16(left[i + j]!);
      r16[j] = floatToPcm16(right[i + j]!);
    }
    const mp3 =
      numChannels > 1
        ? encoder.encodeBuffer(l16.subarray(0, n), r16.subarray(0, n))
        : encoder.encodeBuffer(l16.subarray(0, n));
    if (mp3.length > 0) chunks.push(new Uint8Array(mp3));
  }
  const end = encoder.flush();
  if (end.length > 0) chunks.push(new Uint8Array(end));
  return new Blob(chunks as BlobPart[], { type: 'audio/mpeg' });
}

/**
 * Save a Blob to the device. Browser download on web/desktop; native share sheet
 * on mobile (see lib/platform/save.ts). Kept as a `void` helper so all existing
 * export/download call sites stay unchanged; failures are logged, not thrown.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  void saveOrShare(blob, filename).catch((err) => {
    console.error('Save/share failed:', err);
  });
}
