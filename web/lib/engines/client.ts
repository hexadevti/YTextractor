/**
 * Core backend client: health, and starting/following native separation jobs
 * (upload bytes or reference a saved source), returning a StemSet.
 */

import {
  STEM_NAMES,
  type ProgressUpdate,
  type SeparateEvent,
  type SeparateStartResponse,
  type StemSet,
} from '@ytx/shared';
import { decodeToModelAudio, stemSetFromChannels } from '../audio';

export async function checkBackend(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

/** Follow an SSE job to completion, then download its stems into a StemSet. */
async function followJob(
  baseUrl: string,
  jobId: string,
  onProgress: (p: ProgressUpdate) => void,
): Promise<StemSet> {
  const ready = await new Promise<SeparateEvent>((resolve, reject) => {
    const es = new EventSource(`${baseUrl}/separate/${jobId}/events`);
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data) as SeparateEvent;
      if (data.phase === 'error') {
        es.close();
        reject(new Error(data.error ?? 'Backend separation error'));
        return;
      }
      onProgress({
        phase: data.phase,
        percent: data.percent,
        message: data.message,
        engine: data.engine,
      });
      if (data.phase === 'ready') {
        es.close();
        resolve(data);
      }
    };
    es.onerror = () => {
      es.close();
      reject(new Error('Lost connection to backend during separation'));
    };
  });

  const sampleRate = ready.sampleRate ?? 44100;
  const perStemChannels: Float32Array[][] = [];
  for (const name of STEM_NAMES) {
    const res = await fetch(`${baseUrl}/separate/${jobId}/stems/${name}`);
    if (!res.ok) throw new Error(`Failed to download stem "${name}" (${res.status})`);
    const decoded = await decodeToModelAudio(await res.arrayBuffer());
    perStemChannels.push(decoded.channels);
  }
  const set = stemSetFromChannels(perStemChannels, sampleRate);
  return set;
}

/** Separate uploaded audio bytes (also persisted as a source on the backend). */
export async function separateUpload(
  baseUrl: string,
  audioBytes: ArrayBuffer,
  meta: { title: string; ext: string },
  onProgress: (p: ProgressUpdate) => void,
): Promise<StemSet> {
  const startRes = await fetch(`${baseUrl}/separate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Title': encodeURIComponent(meta.title),
      'X-Ext': meta.ext,
    },
    body: audioBytes,
  });
  if (!startRes.ok) throw new Error(`Backend separation failed to start (${startRes.status})`);
  const { jobId } = (await startRes.json()) as SeparateStartResponse;
  return followJob(baseUrl, jobId, onProgress);
}

/** Separate a previously-saved source by id. */
export async function separateFromSource(
  baseUrl: string,
  sourceId: string,
  onProgress: (p: ProgressUpdate) => void,
): Promise<StemSet> {
  const startRes = await fetch(`${baseUrl}/separate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId }),
  });
  if (!startRes.ok) throw new Error(`Backend separation failed to start (${startRes.status})`);
  const { jobId } = (await startRes.json()) as SeparateStartResponse;
  return followJob(baseUrl, jobId, onProgress);
}
