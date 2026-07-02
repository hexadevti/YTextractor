/**
 * Audio (de)coding for the backend using the npm-bundled ffmpeg binary
 * (`ffmpeg-static`) — no system ffmpeg install required.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { MODEL_CHANNELS, MODEL_SAMPLE_RATE } from '@ytx/shared';
import { TMP_DIR } from './config';

// In a packaged Electron app the binary is unpacked from the asar; ffmpeg-static
// still returns the in-asar path, so redirect it. No-op when not packaged.
const ffmpegPath = ((ffmpegStatic as unknown as string) || 'ffmpeg').replace(
  'app.asar',
  'app.asar.unpacked',
);

export interface DecodedPcm {
  channels: Float32Array[];
  sampleRate: number;
  length: number;
}

/** Decode arbitrary audio bytes to 44.1 kHz stereo Float32 channels. */
export async function decodePcm(bytes: Buffer): Promise<DecodedPcm> {
  await mkdir(TMP_DIR, { recursive: true });
  // MP4/M4A needs a seekable input, so stage the upload to a temp file.
  const inPath = join(TMP_DIR, `in_${process.pid}_${bytes.length}_${Date.now() % 1e9}`);
  await writeFile(inPath, bytes);

  try {
    const out = await runFfmpeg([
      '-i',
      inPath,
      '-f',
      'f32le',
      '-acodec',
      'pcm_f32le',
      '-ac',
      String(MODEL_CHANNELS),
      '-ar',
      String(MODEL_SAMPLE_RATE),
      'pipe:1',
    ]);

    const interleaved = new Float32Array(
      out.buffer,
      out.byteOffset,
      Math.floor(out.byteLength / 4),
    );
    const frames = Math.floor(interleaved.length / MODEL_CHANNELS);
    const channels: Float32Array[] = [];
    for (let c = 0; c < MODEL_CHANNELS; c++) channels.push(new Float32Array(frames));
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < MODEL_CHANNELS; c++) {
        channels[c]![i] = interleaved[i * MODEL_CHANNELS + c]!;
      }
    }
    return { channels, sampleRate: MODEL_SAMPLE_RATE, length: frames };
  } finally {
    await rm(inPath, { force: true });
  }
}

function runFfmpeg(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args]);
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => errChunks.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(errChunks).toString()}`));
    });
    if (input) {
      proc.stdin.write(input);
      proc.stdin.end();
    }
  });
}

/** Encode Float32 channels to a 16-bit PCM WAV Buffer. */
export function encodeWav(channels: Float32Array[], sampleRate: number): Buffer {
  const numChannels = channels.length;
  const length = channels[0]?.length ?? 0;
  const blockAlign = numChannels * 2;
  const dataSize = length * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      let s = channels[c]![i]!;
      s = Math.max(-1, Math.min(1, s));
      buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, offset);
      offset += 2;
    }
  }
  return buf;
}
