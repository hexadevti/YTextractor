/**
 * Browser YouTube extraction with youtubei.js.
 *
 * Browser use of youtubei.js REQUIRES a CORS proxy — the library and the media
 * CDN (googlevideo) both reject direct cross-origin browser requests. We route
 * every request through the backend's `/proxy` endpoint (or any configured
 * proxy). Without a reachable proxy this path cannot work; use backend
 * extraction or file upload instead.
 */

import { Innertube } from 'youtubei.js';
import type { ProgressUpdate } from '@ytx/shared';

export function parseVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1) || null;
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    // /shorts/<id> or /embed/<id>
    const m = u.pathname.match(/\/(shorts|embed|v)\/([^/?]+)/);
    if (m) return m[2] ?? null;
    return null;
  } catch {
    return null;
  }
}

export async function extractInBrowser(
  youtubeUrl: string,
  proxyBase: string,
  onProgress: (p: ProgressUpdate) => void,
): Promise<ArrayBuffer> {
  const videoId = parseVideoId(youtubeUrl);
  if (!videoId) throw new Error('Could not parse a YouTube video id from that URL.');

  onProgress({ phase: 'extracting', percent: 5, message: 'Connecting via proxy…' });

  const proxiedFetch: typeof fetch = (input, init) => {
    const target =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const proxied = `${proxyBase}/proxy?url=${encodeURIComponent(target)}`;
    return fetch(proxied, init);
  };

  const yt = await Innertube.create({
    fetch: proxiedFetch,
    generate_session_locally: true,
  });

  onProgress({ phase: 'extracting', percent: 20, message: 'Fetching stream…' });

  const stream = await yt.download(videoId, {
    type: 'audio',
    quality: 'best',
    format: 'any',
  });

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      // total size is unknown up front; report steady progress up to ~90%
      onProgress({
        phase: 'extracting',
        percent: Math.min(90, 20 + Math.round(received / 200000)),
        message: `Downloaded ${(received / 1_000_000).toFixed(1)} MB`,
      });
    }
  }
  const bytes = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  onProgress({ phase: 'extracting', percent: 100, message: 'Audio ready' });
  return bytes.buffer;
}
