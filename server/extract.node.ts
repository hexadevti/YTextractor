/**
 * Backend YouTube extraction.
 *
 * Primary path is yt-dlp (reliable, keeps up with YouTube). youtubei.js is kept
 * as a secondary fallback, but on networks that enforce PoToken it fails with
 * "No valid URL to decipher" — hence yt-dlp is tried first.
 */

import { Innertube } from 'youtubei.js';
import type { ExtractInfo } from '@ytx/shared';
import { extractWithYtDlp } from './ytdlp';

let innertube: Promise<Innertube> | null = null;
function getInnertube(): Promise<Innertube> {
  // Default settings retrieve the player (with the signature-decipher algorithm)
  // from YouTube, which is required to resolve stream URLs. Do NOT set
  // generate_session_locally here — that skips fetching a usable session/player.
  if (!innertube) innertube = Innertube.create();
  return innertube;
}

/**
 * Clients to try, in order. The mobile clients (iOS/ANDROID) usually return
 * direct, pre-deciphered stream URLs and avoid the "No valid URL to decipher"
 * and PoToken walls the WEB client hits. We fall back through the list.
 */
const CLIENTS = ['iOS', 'ANDROID', 'MWEB', 'WEB'] as const;

export function parseVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1) || null;
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const m = u.pathname.match(/\/(shorts|embed|v)\/([^/?]+)/);
    if (m) return m[2] ?? null;
    return null;
  } catch {
    return null;
  }
}

export interface ExtractResult {
  bytes: Buffer;
  info: ExtractInfo;
  /** actual container extension of the audio bytes, e.g. 'm4a' | 'webm' */
  ext: string;
}

/** youtubei.js fallback (used only if yt-dlp is unavailable/fails). */
async function extractWithInnertube(url: string): Promise<ExtractResult> {
  const videoId = parseVideoId(url);
  if (!videoId) throw new Error('Could not parse a YouTube video id from that URL.');

  const yt = await getInnertube();
  const errors: string[] = [];

  for (const client of CLIENTS) {
    try {
      const info = await yt.getInfo(videoId, client as never);
      const title = info.basic_info.title ?? videoId;
      const duration = info.basic_info.duration ?? undefined;

      const stream = await info.download({ type: 'audio', quality: 'best', format: 'any' });
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      if (bytes.length === 0) throw new Error('empty stream');

      return {
        bytes,
        ext: 'webm',
        info: { title, durationSeconds: duration, mimeType: 'audio/webm' },
      };
    } catch (err) {
      errors.push(`${client}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`youtubei.js failed for all clients (${errors.join(' | ')})`);
}

export async function extractAudio(url: string): Promise<ExtractResult> {
  if (!parseVideoId(url)) throw new Error('Could not parse a YouTube video id from that URL.');
  try {
    return await extractWithYtDlp(url);
  } catch (ytdlpErr) {
    const a = ytdlpErr instanceof Error ? ytdlpErr.message : String(ytdlpErr);
    try {
      return await extractWithInnertube(url);
    } catch (innErr) {
      const b = innErr instanceof Error ? innErr.message : String(innErr);
      throw new Error(
        `Extraction failed. yt-dlp → ${a}. youtubei.js → ${b}. ` +
          `Try the file-upload path if YouTube keeps blocking this network.`,
      );
    }
  }
}
