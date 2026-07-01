/**
 * Job orchestrator: turns a JobConfig (+ optional uploaded file) into a StemSet,
 * choosing browser/backend engines for extraction and separation as configured.
 *
 * Backend paths persist to the library: YouTube imports become saved sources,
 * and backend separations become saved projects.
 */

import type { JobConfig, ProgressUpdate, StemSet } from '@ytx/shared';
import { decodeToModelAudio } from './audio';
import { separateFromSource, separateUpload } from './engines/client';
import { extractInBrowser } from './engines/extract.web';
import { separateInBrowser } from './engines/separation.web';
import { getSourceAudioBytes, importYouTube } from './library';

export interface JobResult {
  set: StemSet;
  title: string;
  /** true if the project was saved to the backend library */
  persisted: boolean;
}

export async function runJob(
  config: JobConfig,
  file: File | null,
  onProgress: (p: ProgressUpdate) => void,
): Promise<JobResult> {
  const { input, separation, backendBaseUrl } = config;
  const backendSep = separation === 'backend';

  const browserSeparate = async (bytes: ArrayBuffer): Promise<StemSet> => {
    onProgress({ phase: 'loading-model', percent: 0, message: 'Preparing model…' });
    const audio = await decodeToModelAudio(bytes);
    return separateInBrowser(audio, onProgress);
  };

  if (input.kind === 'file') {
    if (!file) throw new Error('No file provided.');
    const title = file.name.replace(/\.[^.]+$/, '');
    const bytes = await file.arrayBuffer();
    if (backendSep) {
      const ext = file.name.split('.').pop()?.toLowerCase() || 'audio';
      const set = await separateUpload(backendBaseUrl, bytes, { title, ext }, onProgress);
      return { set, title, persisted: true };
    }
    return { set: await browserSeparate(bytes), title, persisted: false };
  }

  // YouTube
  if (input.extraction === 'backend') {
    onProgress({ phase: 'extracting', percent: 20, message: 'Importing on backend…' });
    const source = await importYouTube(backendBaseUrl, input.url);
    onProgress({ phase: 'extracting', percent: 100, message: `Imported "${source.title}"` });
    if (backendSep) {
      const set = await separateFromSource(backendBaseUrl, source.id, onProgress);
      return { set, title: source.title, persisted: true };
    }
    const bytes = await getSourceAudioBytes(backendBaseUrl, source.id);
    return { set: await browserSeparate(bytes), title: source.title, persisted: false };
  }

  // Browser extraction (through the backend proxy)
  const bytes = await extractInBrowser(input.url, backendBaseUrl, onProgress);
  const title = input.url;
  if (backendSep) {
    const set = await separateUpload(backendBaseUrl, bytes, { title, ext: 'webm' }, onProgress);
    return { set, title, persisted: true };
  }
  return { set: await browserSeparate(bytes), title, persisted: false };
}
