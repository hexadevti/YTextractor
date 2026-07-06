/** Client configuration (overridable via NEXT_PUBLIC_* env vars). */

/**
 * URL of the exported htdemucs_6s ONNX model. Must be served with a CORS/CORP
 * policy compatible with cross-origin isolation (see next.config.ts).
 *
 * Verify the exact file path against the chosen export before shipping — e.g.
 * the Hugging Face repo `StemSplitio/htdemucs-6s-onnx`.
 */
export const MODEL_URL =
  process.env.NEXT_PUBLIC_MODEL_URL ??
  'https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s.onnx';

/** Default base URL for the optional Node backend. */
export const DEFAULT_BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:8787';

/** Cache Storage bucket for the downloaded model weights. */
export const MODEL_CACHE = 'prismaxim-models-v1';

/**
 * Base URL onnxruntime-web loads its WASM runtime from (ort.env.wasm.wasmPaths).
 * The JSEP/WebGPU wasm binary is ~26 MB — over Cloudflare's 25 MiB per-file
 * asset limit — so it is fetched from a CDN at runtime instead of being bundled
 * and uploaded with the static site (the bundled copy is dropped from the upload
 * via web/public/.assetsignore). CORS + `credentialless` COEP make the
 * cross-origin fetch work, same as smplr's samples.
 *
 * The version MUST match the installed onnxruntime-web (web/package.json) or the
 * wasm and JS API will mismatch at runtime. Bump both together. Override with
 * NEXT_PUBLIC_ORT_WASM_BASE to self-host (e.g. Cloudflare R2) — must end in `/`.
 */
export const ORT_WASM_BASE_URL =
  process.env.NEXT_PUBLIC_ORT_WASM_BASE ??
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/';

/** Basic Pitch (audio→MIDI) TF.js model, self-hosted under public/ (same-origin). */
export const BASIC_PITCH_MODEL_URL =
  process.env.NEXT_PUBLIC_BASIC_PITCH_MODEL_URL ?? '/models/basic-pitch/model.json';

/**
 * Optional cloud separation endpoint (see /cloud). When set, the app offers an
 * opt-in "Cloud (fast)" separation mode. Both are also editable at runtime in
 * Options. Empty string = no cloud option shown.
 */
export const DEFAULT_CLOUD_URL = process.env.NEXT_PUBLIC_CLOUD_SEPARATE_URL ?? '';
export const DEFAULT_CLOUD_TOKEN = process.env.NEXT_PUBLIC_CLOUD_TOKEN ?? '';
