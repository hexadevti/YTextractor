/// <reference lib="webworker" />
/**
 * Time-stretch Web Worker: runs the WSOLA pitch-preserving stretch off the main
 * thread so preparing "keep pitch" buffers (a few seconds of DSP per stem)
 * never freezes the UI. One job per message; the result is transferred back.
 */

import { timeStretch } from './timestretch';

export interface StretchIn {
  channels: Float32Array[];
  factor: number;
}
export interface StretchOut {
  channels: Float32Array[];
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<StretchIn>) => {
  const { channels, factor } = ev.data;
  try {
    const out = timeStretch(channels, factor);
    ctx.postMessage(
      { channels: out } satisfies StretchOut,
      out.map((c) => c.buffer),
    );
  } catch {
    // On failure return the input unchanged; the caller falls back to pitch-shift.
    ctx.postMessage({ channels: [] } satisfies StretchOut);
  }
};
