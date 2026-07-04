/**
 * Job orchestrator: turns a JobConfig (+ optional uploaded file) into a StemSet,
 * and (re)separates a saved source.
 *
 * Two runtimes, chosen at build time (see lib/env.ts):
 *  - Web build: separation runs in the browser (onnxruntime-web, WebGPU/WASM via
 *    the separation worker); results persist to the in-browser store
 *    (IndexedDB/OPFS). Input is upload-only — YouTube import is desktop-only.
 *  - Desktop build: separation and YouTube import run on the bundled Node
 *    backend, which also persists to the filesystem library.
 */

import type { JobConfig, ProgressUpdate, SourceMeta, StemSet } from '@prismaxim/shared';
import { IS_DESKTOP, IS_MOBILE } from './env';
import { decodeToModelAudio } from './audio';
import { separateInBrowser } from './engines/separation.web';
import { separateOnCloud } from './engines/cloud';
import { getCloudToken, getCloudUrl } from './cloudConfig';
import { separateFromSource, separateUpload } from './engines/client';
import { importYouTube } from './library';
import { store } from './store';

export interface JobResult {
  set: StemSet;
  title: string;
  /** true if the result was persisted to the library */
  persisted: boolean;
}

/** Wrap onProgress to record the most recent compute engine reported. */
function engineTracker(onProgress: (p: ProgressUpdate) => void) {
  const state = { engine: 'webgpu' };
  const wrapped = (p: ProgressUpdate) => {
    if (p.engine) state.engine = p.engine;
    onProgress(p);
  };
  return { wrapped, state };
}

/** Separate decoded audio in the browser and persist source + project. */
async function separateAndPersistInBrowser(
  bytes: ArrayBuffer,
  title: string,
  sourceId: string | undefined,
  onProgress: (p: ProgressUpdate) => void,
): Promise<StemSet> {
  const audio = await decodeToModelAudio(bytes);
  const { wrapped, state } = engineTracker(onProgress);
  const t0 = performance.now();
  const set = await separateInBrowser(audio, wrapped);
  const separationMs = Math.round(performance.now() - t0);
  await store.saveProject(set, { title, sourceId, engine: state.engine, separationMs }, onProgress);
  return set;
}

/** Separate raw audio bytes on the cloud service and persist the project. */
async function cloudSeparateBytes(
  bytes: ArrayBuffer,
  title: string,
  sourceId: string | undefined,
  onProgress: (p: ProgressUpdate) => void,
): Promise<StemSet> {
  const set = await separateOnCloud(getCloudUrl(), getCloudToken(), bytes, onProgress);
  await store.saveProject(set, { title, sourceId, engine: 'cloud' }, onProgress);
  return set;
}

/** Separate an uploaded file on the cloud service, saving the source first. */
async function separateAndPersistOnCloud(
  file: File,
  title: string,
  onProgress: (p: ProgressUpdate) => void,
): Promise<StemSet> {
  const source = await store.saveSource(file);
  return cloudSeparateBytes(await file.arrayBuffer(), title, source.id, onProgress);
}

export async function runJob(
  config: JobConfig,
  file: File | null,
  onProgress: (p: ProgressUpdate) => void,
): Promise<JobResult> {
  const { input, backendBaseUrl } = config;

  /* ---------- Cloud (fast) — opt-in, works on both builds, upload only ---------- */
  if (config.separation === 'cloud') {
    if (input.kind !== 'file' || !file) {
      throw new Error('Cloud separation currently supports uploaded files.');
    }
    const title = file.name.replace(/\.[^.]+$/, '');
    const set = await separateAndPersistOnCloud(file, title, onProgress);
    return { set, title, persisted: true };
  }

  /* ---------- Web / mobile build: 100% browser, upload only ---------- */
  if (!IS_DESKTOP) {
    if (input.kind !== 'file' || !file) {
      throw new Error(
        IS_MOBILE
          ? 'The mobile app imports audio files only.'
          : 'The web version imports audio files only. YouTube import needs the desktop app.',
      );
    }
    const title = file.name.replace(/\.[^.]+$/, '');
    // Persist the original upload as a source (so it can be re-split later).
    const source = await store.saveSource(file);
    const set = await separateAndPersistInBrowser(await file.arrayBuffer(), title, source.id, onProgress);
    return { set, title, persisted: true };
  }

  /* ---------- Desktop build: native backend ---------- */
  if (input.kind === 'file') {
    if (!file) throw new Error('No file provided.');
    const title = file.name.replace(/\.[^.]+$/, '');
    const bytes = await file.arrayBuffer();
    const ext = file.name.split('.').pop()?.toLowerCase() || 'audio';
    const set = await separateUpload(backendBaseUrl, bytes, { title, ext }, onProgress);
    return { set, title, persisted: true };
  }

  // YouTube — extract (backend or browser-via-proxy), then separate on the backend.
  if (input.extraction === 'backend') {
    onProgress({ phase: 'extracting', percent: 20, message: 'Importing on backend…' });
    const source = await importYouTube(backendBaseUrl, input.url);
    onProgress({ phase: 'extracting', percent: 100, message: `Imported "${source.title}"` });
    const set = await separateFromSource(backendBaseUrl, source.id, onProgress);
    return { set, title: source.title, persisted: true };
  }

  // Lazy-load browser extraction (pulls youtubei.js) so it stays out of the web bundle.
  const { extractInBrowser } = await import('./engines/extract.web');
  const bytes = await extractInBrowser(input.url, backendBaseUrl, onProgress);
  const title = input.url;
  const set = await separateUpload(backendBaseUrl, bytes, { title, ext: 'webm' }, onProgress);
  return { set, title, persisted: true };
}

/** (Re)separate a source already saved in the library, optionally on the cloud. */
export async function splitSavedSource(
  source: SourceMeta,
  backendBaseUrl: string,
  onProgress: (p: ProgressUpdate) => void,
  useCloud = false,
): Promise<StemSet> {
  if (useCloud) {
    const bytes = await store.getSourceBytes(source.id);
    return cloudSeparateBytes(bytes, source.title, source.id, onProgress);
  }
  if (!IS_DESKTOP) {
    const bytes = await store.getSourceBytes(source.id);
    return separateAndPersistInBrowser(bytes, source.title, source.id, onProgress);
  }
  return separateFromSource(backendBaseUrl, source.id, onProgress);
}
