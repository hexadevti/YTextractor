/**
 * Backend separation runtime using onnxruntime-node (native).
 *
 * CPU execution by default; if a DirectML-enabled onnxruntime-node build is
 * installed (Windows), it can target the Intel Arc GPU — set ORT_EP=dml.
 */

import { access, mkdir, writeFile } from 'node:fs/promises';
import * as ort from 'onnxruntime-node';
import type { SeparationRuntime, SeparationSession } from '@ytx/shared';
import { MODEL_DIR, MODEL_FILE, MODEL_URL } from './config';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Ensure the ONNX model is on disk, downloading it from MODEL_URL if needed. */
export async function ensureModel(onLog?: (msg: string) => void): Promise<string> {
  if (await fileExists(MODEL_FILE)) return MODEL_FILE;
  await mkdir(MODEL_DIR, { recursive: true });
  onLog?.(`Downloading model from ${MODEL_URL} …`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Model download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(MODEL_FILE, buf);
  onLog?.(`Model saved to ${MODEL_FILE} (${(buf.length / 1e6).toFixed(0)} MB)`);
  return MODEL_FILE;
}

export function createNodeRuntime(): SeparationRuntime {
  const ep = (process.env.ORT_EP ?? 'cpu').toLowerCase();
  return {
    engine: ep,
    async createSession(model): Promise<SeparationSession> {
      const path = typeof model === 'string' ? model : MODEL_FILE;
      const session = await ort.InferenceSession.create(path, {
        executionProviders: [ep],
      });
      const inputName = session.inputNames[0]!;
      const outputName = session.outputNames[0]!;
      return {
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
    },
  };
}
