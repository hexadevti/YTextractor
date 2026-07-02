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
export const MODEL_CACHE = 'ytx-models-v1';

/** Basic Pitch (audio→MIDI) TF.js model, self-hosted under public/ (same-origin). */
export const BASIC_PITCH_MODEL_URL =
  process.env.NEXT_PUBLIC_BASIC_PITCH_MODEL_URL ?? '/models/basic-pitch/model.json';
