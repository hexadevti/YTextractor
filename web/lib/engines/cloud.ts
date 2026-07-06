/**
 * Client for the optional cloud separation service (see /cloud). POSTs audio to
 * `${baseUrl}/separate`, streams back the framed FLAC body, decodes each stem in
 * the browser, and returns a StemSet. The service is stateless — persistence is
 * the caller's job (see pipeline.ts → store.saveProject).
 *
 * Framed body:  repeat N×  [nameLen u32le][name utf8][dataLen u32le][flac bytes]
 */

import type { ProgressUpdate, SelectableStem, StemSet } from '@prismaxim/shared';
import { decodeToModelAudio } from '../audio';

export async function checkCloud(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

interface FramedStem {
  name: string;
  flac: ArrayBuffer;
}

/** Read the response body with coarse download progress, into one ArrayBuffer. */
async function readBodyWithProgress(
  res: Response,
  onProgress: (p: ProgressUpdate) => void,
): Promise<ArrayBuffer> {
  const total = Number(res.headers.get('Content-Length') ?? 0);
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      onProgress({
        phase: 'loading-model',
        percent: total > 0 ? Math.round((received / total) * 100) : Math.min(95, received / 1e6),
        message: `Downloading stems ${(received / 1e6).toFixed(1)} MB`,
        engine: 'cloud',
      });
    }
  }
  const bytes = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  return bytes.buffer;
}

/** Split a framed body into its per-stem FLAC blobs. */
function parseFramed(buf: ArrayBuffer): FramedStem[] {
  const view = new DataView(buf);
  const dec = new TextDecoder();
  const stems: FramedStem[] = [];
  let off = 0;
  while (off + 4 <= buf.byteLength) {
    const nameLen = view.getUint32(off, true);
    off += 4;
    const name = dec.decode(new Uint8Array(buf, off, nameLen));
    off += nameLen;
    const dataLen = view.getUint32(off, true);
    off += 4;
    const flac = buf.slice(off, off + dataLen);
    off += dataLen;
    stems.push({ name, flac });
  }
  return stems;
}

export async function separateOnCloud(
  baseUrl: string,
  token: string,
  audioBytes: ArrayBuffer,
  onProgress: (p: ProgressUpdate) => void,
  include?: SelectableStem[],
): Promise<StemSet> {
  const url = `${baseUrl.replace(/\/$/, '')}/separate`;
  onProgress({ phase: 'separating', percent: 0, message: 'Separating on cloud…', engine: 'cloud' });

  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // Ask the service to encode/return only these stems (saves FLAC encode + bandwidth).
  if (include && include.length) headers['X-Stems'] = include.join(',');

  const res = await fetch(url, { method: 'POST', headers, body: audioBytes });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Cloud separation failed (${res.status}). ${detail}`);
  }

  const sampleRate = Number(res.headers.get('X-Sample-Rate') ?? 44100);
  const body = await readBodyWithProgress(res, onProgress);
  const framed = parseFramed(body);
  if (framed.length === 0) throw new Error('Cloud returned no stems.');

  const stems = [];
  for (let i = 0; i < framed.length; i++) {
    const f = framed[i]!;
    onProgress({
      phase: 'separating',
      percent: Math.round(((i + 1) / framed.length) * 100),
      message: `Decoding ${f.name}…`,
      engine: 'cloud',
    });
    const decoded = await decodeToModelAudio(f.flac);
    stems.push({ name: f.name as SelectableStem, channels: decoded.channels });
  }

  const first = stems[0]!;
  return {
    sampleRate,
    length: first.channels[0]?.length ?? 0,
    numChannels: first.channels.length,
    stems,
  };
}
