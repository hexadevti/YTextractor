/**
 * yt-dlp based YouTube extraction — the reliable path.
 *
 * yt-dlp keeps up with YouTube's signature/PoToken changes far better than
 * pure-JS libraries. We use the standalone binary (no Python), the running
 * Node as its JS runtime (for nsig/signature deciphering), and the bundled
 * ffmpeg from ffmpeg-static.
 */

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import type { ExtractInfo } from '@ytx/shared';
import { TMP_DIR, YTDLP_BIN, YTDLP_DIR } from './config';

// In a packaged Electron app the binary is unpacked from the asar; ffmpeg-static
// still returns the in-asar path, so redirect it. No-op when not packaged.
const ffmpegPath = ((ffmpegStatic as unknown as string) || 'ffmpeg').replace(
  'app.asar',
  'app.asar.unpacked',
);

const YTDLP_URLS: Record<string, string> = {
  win32: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  linux: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
  darwin: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Return a usable yt-dlp binary path, downloading it if necessary. */
export async function ensureYtDlp(onLog?: (m: string) => void): Promise<string> {
  if (await fileExists(YTDLP_BIN)) return YTDLP_BIN;
  const url = YTDLP_URLS[process.platform];
  if (!url) {
    // Unknown platform: rely on a system-installed yt-dlp on PATH.
    return 'yt-dlp';
  }
  await mkdir(YTDLP_DIR, { recursive: true });
  onLog?.(`Downloading yt-dlp from ${url} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`yt-dlp download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(YTDLP_BIN, buf, { mode: 0o755 });
  onLog?.(`yt-dlp saved to ${YTDLP_BIN}`);
  return YTDLP_BIN;
}

function run(
  bin: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    // When the backend runs inside Electron, `process.execPath` is the Electron
    // binary — which yt-dlp is told to use as its JS runtime (for nsig
    // deciphering). ELECTRON_RUN_AS_NODE makes that binary behave like plain
    // Node when yt-dlp invokes it. Harmless under a normal Node process.
    const proc = spawn(bin, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

const SEP = '\x1f'; // unit separator, unlikely to appear in a title

export async function extractWithYtDlp(
  url: string,
): Promise<{ bytes: Buffer; info: ExtractInfo; ext: string; thumb?: Buffer }> {
  const bin = await ensureYtDlp((m) => console.log(m));
  await mkdir(TMP_DIR, { recursive: true });
  const uid = `yt_${process.pid}_${Date.now() % 1e9}`;
  const outTmpl = join(TMP_DIR, `${uid}.%(ext)s`);

  const { stdout, stderr, code } = await run(bin, [
    '-f',
    'bestaudio/best',
    '--no-playlist',
    '--no-part',
    '--no-progress',
    '--write-thumbnail',
    '--convert-thumbnails',
    'jpg',
    '--js-runtimes',
    `node:${process.execPath}`,
    '--ffmpeg-location',
    ffmpegPath,
    '-o',
    outTmpl,
    '--print',
    `after_move:%(title)s${SEP}%(duration)s${SEP}%(filepath)s${SEP}%(uploader)s${SEP}%(view_count)s${SEP}%(like_count)s${SEP}%(upload_date)s`,
    url,
  ]);

  if (code !== 0) {
    throw new Error(`yt-dlp exited ${code}: ${stderr.split('\n').slice(-4).join(' ').trim()}`);
  }

  // Parse the after_move print line (last non-empty stdout line).
  const line = stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const [title, durationStr, filepath, uploader, viewStr, likeStr, uploadDate] = line.split(SEP);

  // yt-dlp writes the converted thumbnail next to the audio as <uid>.jpg.
  const thumbPath = join(TMP_DIR, `${uid}.jpg`);
  let thumb: Buffer | undefined;
  try {
    if (await fileExists(thumbPath)) thumb = await readFile(thumbPath);
  } catch {
    thumb = undefined;
  } finally {
    await rm(thumbPath, { force: true });
  }

  const na = (v?: string) => (v && v !== 'NA' ? v : undefined);
  const num = (v?: string) => {
    const n = Number(na(v));
    return Number.isFinite(n) ? n : undefined;
  };

  let finalPath = filepath;
  if (!finalPath || !(await fileExists(finalPath))) {
    // Fallback: find the file we wrote by its uid prefix.
    const files = await readdir(TMP_DIR);
    const match = files.find((f) => f.startsWith(uid));
    if (!match) throw new Error('yt-dlp produced no output file');
    finalPath = join(TMP_DIR, match);
  }

  try {
    const bytes = await readFile(finalPath);
    const duration = durationStr ? Number(durationStr) : undefined;
    const ext = (finalPath.split('.').pop() || 'webm').toLowerCase();
    const mimeType =
      ext === 'm4a' || ext === 'mp4'
        ? 'audio/mp4'
        : ext === 'mp3'
          ? 'audio/mpeg'
          : ext === 'opus'
            ? 'audio/opus'
            : 'audio/webm';
    return {
      bytes,
      ext,
      thumb,
      info: {
        title: title || 'audio',
        durationSeconds: Number.isFinite(duration) ? duration : undefined,
        mimeType,
        uploader: na(uploader),
        viewCount: num(viewStr),
        likeCount: num(likeStr),
        uploadDate: na(uploadDate),
      },
    };
  } finally {
    await rm(finalPath, { force: true });
  }
}
