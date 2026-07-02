import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PORT = Number(process.env.PORT ?? 8787);

/** Bind address. Cloud: 0.0.0.0. Desktop sets 127.0.0.1 (local only). */
export const HOST = process.env.HOST ?? '0.0.0.0';

/** Where htdemucs_6s ONNX weights live on disk (downloaded on first use). */
export const MODEL_DIR = process.env.MODEL_DIR ?? join(__dirname, 'models');
export const MODEL_FILE = join(MODEL_DIR, 'htdemucs_6s.onnx');
export const MODEL_URL =
  process.env.MODEL_URL ??
  'https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s.onnx';

/** Scratch dir for decoding uploads and temporary downloads. */
export const TMP_DIR = process.env.TMP_DIR ?? join(__dirname, 'tmp');

/** Persistent library: imported source audio + saved separation projects. */
export const LIBRARY_DIR = process.env.LIBRARY_DIR ?? join(__dirname, 'library');

/** yt-dlp binary location (auto-downloaded on first use on Windows). */
export const YTDLP_DIR = process.env.YTDLP_DIR ?? join(__dirname, 'bin');
export const YTDLP_BIN =
  process.env.YTDLP_BIN ??
  join(YTDLP_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

/** Max upload size for /separate (bytes). */
export const BODY_LIMIT = Number(process.env.BODY_LIMIT ?? 300 * 1024 * 1024);

/**
 * Static web bundle to serve (the desktop/Electron build). When this directory
 * exists the backend also serves the UI on its own origin — a self-contained
 * monolith. The cloud backend leaves it unset and serves only the API.
 */
export const WEB_DIR = process.env.WEB_DIR ?? join(__dirname, '..', 'web', 'out');
