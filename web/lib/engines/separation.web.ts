/**
 * Main-thread wrapper around the separation Web Worker. Spawns the worker,
 * feeds it decoded audio, relays progress, and resolves with a StemSet.
 */

import type { ProgressUpdate, SelectableStem, StemSet } from '@prismaxim/shared';
import type { DecodedAudio } from '../audio';
import { MODEL_CACHE, MODEL_URL } from '../config';
import type { RunMessage, WorkerOut } from './separation.worker';

export function separateInBrowser(
  audio: DecodedAudio,
  onProgress: (p: ProgressUpdate) => void,
  stems?: SelectableStem[],
): Promise<StemSet> {
  return new Promise<StemSet>((resolve, reject) => {
    const worker = new Worker(new URL('./separation.worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
      const m = ev.data;
      if (m.type === 'phase') {
        onProgress({ phase: m.phase, percent: m.percent, engine: m.engine || undefined });
      } else if (m.type === 'done') {
        worker.terminate();
        resolve({
          sampleRate: m.sampleRate,
          length: m.length,
          numChannels: m.numChannels,
          stems: m.stems.map((s) => ({
            name: s.name as StemSet['stems'][number]['name'],
            channels: s.channels,
          })),
        });
      } else if (m.type === 'error') {
        worker.terminate();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Separation worker crashed'));
    };

    const channels = audio.channels;
    const msg: RunMessage = {
      type: 'run',
      channels,
      modelUrl: MODEL_URL,
      cacheName: MODEL_CACHE,
      overlap: 0.25,
      stems,
    };
    // Transfer the PCM buffers to avoid a copy.
    worker.postMessage(msg, channels.map((c) => c.buffer));
  });
}
