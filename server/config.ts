import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PORT = Number(process.env.PORT ?? 8787);

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
