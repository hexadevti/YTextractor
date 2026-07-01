/**
 * Runtime abstraction over an ONNX inference session.
 *
 * The Demucs pipeline in `demucs.ts` is written once against this interface and
 * runs identically in the browser (onnxruntime-web) and on the backend
 * (onnxruntime-node). Each environment provides a concrete `SeparationRuntime`
 * that wraps its own ORT `Tensor`/`InferenceSession` types.
 */

export interface OrtValue {
  /** flat row-major data */
  data: Float32Array;
  /** tensor shape, e.g. [1, 2, 343980] in, [1, 6, 2, 343980] out */
  dims: number[];
}

export interface SeparationSession {
  /**
   * Run one segment through the model.
   * @param input stereo waveform segment, shape [1, channels, samples]
   * @returns stems, shape [1, sources, channels, samples]
   */
  run(input: OrtValue): Promise<OrtValue>;
  dispose(): void;
}

export interface SeparationRuntime {
  /** Human name of the compute backend that was selected, e.g. 'webgpu' | 'cpu'. */
  readonly engine: string;
  /** Create a session from raw ONNX model bytes (browser) or a file path (node). */
  createSession(model: ArrayBuffer | Uint8Array | string): Promise<SeparationSession>;
}
