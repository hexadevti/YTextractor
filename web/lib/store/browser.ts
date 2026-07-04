/**
 * 100% in-browser LibraryStore: metadata in IndexedDB, audio in OPFS.
 *
 * - IndexedDB (`prismaxim-lib`) holds small JSON records: source/project meta and
 *   arrangement manifests.
 * - OPFS (Origin Private File System) holds the large audio as WAV files under
 *   `sources/<id>/`, `projects/<id>/` and `arrangements/<id>/`. Deleting a record
 *   also removes its OPFS directory so nothing is orphaned.
 *
 * Requires a Chromium browser (OPFS + WebGPU/WASM). We ask for persistent
 * storage on first write to reduce the chance of eviction under pressure.
 */

import {
  STEM_NAMES,
  type ArrangementSummary,
  type ProgressUpdate,
  type ProjectMeta,
  type SourceMeta,
  type StemName,
  type StemSet,
} from '@prismaxim/shared';
import { decodeToModelAudio, stemSetFromChannels } from '../audio';
import { encodeWav } from '../mixer/export';
import {
  deserializeManifest,
  serialize,
  type ArrangementManifest,
} from '../editor/persist';
import { makeAudioBuffer, uid } from '../editor/model';
import type { LibraryStore } from './types';

/* ----------------------------- IndexedDB ----------------------------- */

const DB_NAME = 'prismaxim-lib';
const DB_VERSION = 1;
type StoreName = 'sources' | 'projects' | 'arrangements';

/** Stored wrapper for an arrangement (the manifest plus a creation stamp). */
interface ArrangementRecord {
  id: string;
  createdAt: string;
  manifest: ArrangementManifest;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['sources', 'projects', 'arrangements'] as const) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

async function idbPut<T>(store: StoreName, value: T): Promise<void> {
  const db = await openDb();
  await idbReq(db.transaction(store, 'readwrite').objectStore(store).put(value));
}

async function idbGet<T>(store: StoreName, id: string): Promise<T | undefined> {
  const db = await openDb();
  return idbReq<T>(db.transaction(store, 'readonly').objectStore(store).get(id));
}

async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return idbReq<T[]>(db.transaction(store, 'readonly').objectStore(store).getAll());
}

async function idbDelete(store: StoreName, id: string): Promise<void> {
  const db = await openDb();
  await idbReq(db.transaction(store, 'readwrite').objectStore(store).delete(id));
}

/* -------------------------------- OPFS -------------------------------- */

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) {
    // OPFS is available in Chrome/Edge and in modern mobile WebViews (iOS 16.4+,
    // Android Chromium 108+). Keep the message platform-neutral.
    throw new Error('This device has no local file storage (OPFS) available for the library.');
  }
  return navigator.storage.getDirectory();
}

/** Resolve a directory handle for `parts`, creating segments when `create`. */
async function dirHandle(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  let dir = await opfsRoot();
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return dir;
}

async function writeOpfs(path: string, data: ArrayBuffer | Blob): Promise<void> {
  const parts = path.split('/');
  const name = parts.pop()!;
  const dir = await dirHandle(parts, true);
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    await w.write(data);
  } finally {
    await w.close();
  }
}

async function readOpfsBlob(path: string): Promise<Blob> {
  const parts = path.split('/');
  const name = parts.pop()!;
  const dir = await dirHandle(parts, false);
  const fh = await dir.getFileHandle(name, { create: false });
  return fh.getFile();
}

async function readOpfs(path: string): Promise<ArrayBuffer> {
  return (await readOpfsBlob(path)).arrayBuffer();
}

/** Remove `dir/<id>` recursively; ignores an already-missing directory. */
async function removeOpfsDir(dir: string, id: string): Promise<void> {
  try {
    const parent = await dirHandle([dir], false);
    await parent.removeEntry(id, { recursive: true });
  } catch {
    /* nothing to remove */
  }
}

/* ------------------------------ helpers ------------------------------ */

let persistRequested = false;
/** Ask once for durable storage so the library survives storage pressure. */
async function requestPersistent(): Promise<void> {
  if (persistRequested) return;
  persistRequested = true;
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* best effort */
  }
}

function now(): string {
  return new Date().toISOString();
}

function extOf(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() || 'audio';
}

/* --------------------------- the store impl --------------------------- */

export const browserStore: LibraryStore = {
  /* ----- sources ----- */
  async listSources() {
    const all = await idbGetAll<SourceMeta>('sources');
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async saveSource(file) {
    await requestPersistent();
    const id = uid();
    const ext = extOf(file.name);
    await writeOpfs(`sources/${id}/audio.${ext}`, await file.arrayBuffer());
    const meta: SourceMeta = {
      id,
      title: file.name.replace(/\.[^.]+$/, ''),
      origin: 'file',
      createdAt: now(),
      ext,
      mimeType: file.type || 'application/octet-stream',
      bytes: file.size,
      hasThumb: false,
    };
    await idbPut('sources', meta);
    return meta;
  },

  async getSourceBytes(id) {
    const meta = await idbGet<SourceMeta>('sources', id);
    if (!meta) throw new Error('Source not found');
    return readOpfs(`sources/${id}/audio.${meta.ext}`);
  },

  async getSourceAudioUrl(id) {
    const meta = await idbGet<SourceMeta>('sources', id);
    if (!meta) throw new Error('Source not found');
    const blob = await readOpfsBlob(`sources/${id}/audio.${meta.ext}`);
    return URL.createObjectURL(blob);
  },

  async getSourceThumbUrl() {
    // Uploaded sources carry no thumbnail (no YouTube import in the web build).
    return null;
  },

  async deleteSource(id) {
    await idbDelete('sources', id);
    await removeOpfsDir('sources', id);
  },

  /* ----- projects ----- */
  async listProjects() {
    const all = await idbGetAll<ProjectMeta>('projects');
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async saveProject(set, meta, onProgress) {
    await requestPersistent();
    const id = uid();
    for (let i = 0; i < set.stems.length; i++) {
      const stem = set.stems[i]!;
      onProgress?.({
        phase: 'separating',
        percent: Math.round(((i + 1) / set.stems.length) * 100),
        message: `Saving ${stem.name}…`,
      });
      const wav = encodeWav(makeAudioBuffer(stem.channels, set.sampleRate));
      await writeOpfs(`projects/${id}/${stem.name}.wav`, await wav.arrayBuffer());
    }
    const project: ProjectMeta = {
      id,
      title: meta.title,
      sourceId: meta.sourceId,
      createdAt: now(),
      sampleRate: set.sampleRate,
      numChannels: set.numChannels,
      lengthSamples: set.length,
      stems: set.stems.map((s) => s.name),
      engine: meta.engine,
      separationMs: meta.separationMs,
    };
    await idbPut('projects', project);
    return project;
  },

  async loadProject(project, onProgress) {
    const names = project.stems.length ? project.stems : (STEM_NAMES as unknown as StemName[]);
    const perStemChannels: Float32Array[][] = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      onProgress?.({
        phase: 'loading-model',
        percent: Math.round(((i + 1) / names.length) * 100),
        message: `Loading ${name}…`,
      });
      const bytes = await readOpfs(`projects/${project.id}/${name}.wav`);
      const decoded = await decodeToModelAudio(bytes);
      perStemChannels.push(decoded.channels);
    }
    return stemSetFromChannels(perStemChannels, project.sampleRate);
  },

  async deleteProject(id) {
    await idbDelete('projects', id);
    await removeOpfsDir('projects', id);
  },

  /* ----- arrangements ----- */
  async listArrangements() {
    const all = await idbGetAll<ArrangementRecord>('arrangements');
    return all
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(
        (r): ArrangementSummary => ({
          id: r.id,
          title: r.manifest.title,
          createdAt: r.createdAt,
          trackCount: r.manifest.tracks.length,
        }),
      );
  },

  async saveArrangement(project, title, onProgress) {
    await requestPersistent();
    const id = uid();
    const { manifest, buffers } = serialize(project, title);
    for (let i = 0; i < buffers.length; i++) {
      const b = buffers[i]!;
      onProgress?.({
        phase: 'separating',
        percent: Math.round(((i + 1) / buffers.length) * 100),
        message: `Saving audio ${i + 1}/${buffers.length}`,
      });
      const wav = encodeWav(b.buffer);
      await writeOpfs(`arrangements/${id}/${b.id}.wav`, await wav.arrayBuffer());
    }
    const createdAt = now();
    const record: ArrangementRecord = { id, createdAt, manifest };
    await idbPut('arrangements', record);
    return { id, title, createdAt, trackCount: manifest.tracks.length };
  },

  async loadArrangement(id, onProgress) {
    const record = await idbGet<ArrangementRecord>('arrangements', id);
    if (!record) throw new Error('Arrangement not found');
    const { manifest } = record;

    const bufMap = new Map<string, AudioBuffer>();
    for (let i = 0; i < manifest.buffers.length; i++) {
      const bid = manifest.buffers[i]!;
      onProgress?.({
        phase: 'loading-model',
        percent: Math.round(((i + 1) / manifest.buffers.length) * 100),
        message: `Loading audio ${i + 1}/${manifest.buffers.length}`,
      });
      const bytes = await readOpfs(`arrangements/${id}/${bid}.wav`);
      const decoded = await decodeToModelAudio(bytes);
      bufMap.set(bid, makeAudioBuffer(decoded.channels, decoded.sampleRate));
    }
    return { project: deserializeManifest(manifest, bufMap), title: manifest.title };
  },

  async deleteArrangement(id) {
    await idbDelete('arrangements', id);
    await removeOpfsDir('arrangements', id);
  },

  /* ----- storage usage ----- */
  async estimate() {
    if (!navigator.storage?.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  },
};
