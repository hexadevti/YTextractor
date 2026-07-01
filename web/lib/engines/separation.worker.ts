/// <reference lib="webworker" />
/**
 * Separation Web Worker: runs htdemucs_6s with onnxruntime-web (WebGPU, WASM
 * fallback) off the main thread, driving the shared Demucs pipeline.
 */

import * as ort from 'onnxruntime-web';
import { separateMixture, type StemSet } from '@ytx/shared';
import type { SeparationSession } from '@ytx/shared';
import { loadModelBytes } from './model';

export interface RunMessage {
  type: 'run';
  channels: Float32Array[];
  modelUrl: string;
  cacheName: string;
  overlap?: number;
}

export type WorkerOut =
  | { type: 'phase'; phase: 'loading-model' | 'separating'; percent: number; engine: string }
  | {
      type: 'done';
      sampleRate: number;
      length: number;
      numChannels: number;
      stems: { name: string; channels: Float32Array[] }[];
    }
  | { type: 'error'; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

async function createSession(
  modelBytes: ArrayBuffer,
): Promise<{ session: SeparationSession; engine: string }> {
  // WebGPU keeps the ~258 MB weights in GPU memory (best browser option).
  // The WASM fallback disables the arena / mem-pattern / graph optimisation to
  // minimise peak heap use, since the model is large for the 32-bit WASM heap.
  const attempts: { ep: string; options: ort.InferenceSession.SessionOptions }[] = [];
  // @ts-expect-error navigator.gpu is not in older lib typings
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    attempts.push({ ep: 'webgpu', options: { executionProviders: ['webgpu'] } });
  }
  attempts.push({
    ep: 'wasm',
    options: {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'disabled',
      enableCpuMemArena: false,
      enableMemPattern: false,
    },
  });

  let ortSession: ort.InferenceSession | null = null;
  let engine = 'wasm';
  let lastErr: unknown = null;
  for (const attempt of attempts) {
    try {
      ortSession = await ort.InferenceSession.create(modelBytes, attempt.options);
      engine = attempt.ep;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!ortSession) {
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    if (/bad_alloc|out of memory|memory|allocation/i.test(msg)) {
      throw new Error(
        'Not enough memory to load the model in this browser (htdemucs_6s is large). ' +
          'Switch the separation engine to "Backend", or use a WebGPU-capable browser (Chrome/Edge).',
      );
    }
    throw new Error(`Failed to create ONNX session: ${msg}`);
  }
  const session = ortSession;

  const inputName = session.inputNames[0]!;
  const outputName = session.outputNames[0]!;

  const wrapped: SeparationSession = {
    async run(input) {
      const tensor = new ort.Tensor('float32', input.data, input.dims);
      const output = await session.run({ [inputName]: tensor });
      const out = output[outputName]!;
      return { data: out.data as Float32Array, dims: out.dims as number[] };
    },
    dispose() {
      void session.release();
    },
  };
  return { session: wrapped, engine };
}

ctx.onmessage = async (ev: MessageEvent<RunMessage>) => {
  const msg = ev.data;
  if (msg.type !== 'run') return;
  try {
    const post = (m: WorkerOut) => ctx.postMessage(m);

    const modelBytes = await loadModelBytes(msg.modelUrl, msg.cacheName, (f) =>
      post({ type: 'phase', phase: 'loading-model', percent: Math.round(f * 100), engine: '' }),
    );

    const { session, engine } = await createSession(modelBytes);
    post({ type: 'phase', phase: 'separating', percent: 0, engine });

    const set: StemSet = await separateMixture(msg.channels, session, {
      overlap: msg.overlap ?? 0.25,
      onProgress: (f) =>
        post({ type: 'phase', phase: 'separating', percent: Math.round(f * 100), engine }),
    });
    session.dispose();

    const transfer: Transferable[] = [];
    const stems = set.stems.map((s) => {
      for (const ch of s.channels) transfer.push(ch.buffer);
      return { name: s.name, channels: s.channels };
    });
    ctx.postMessage(
      {
        type: 'done',
        sampleRate: set.sampleRate,
        length: set.length,
        numChannels: set.numChannels,
        stems,
      } satisfies WorkerOut,
      transfer,
    );
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerOut);
  }
};
