/**
 * On-disk library: persisted source audio (imported/uploaded) and saved
 * separation projects (6 stem WAVs + metadata). Simple file-based store — one
 * folder per item with a meta.json.
 *
 *   library/
 *     sources/<id>/{audio.<ext>, meta.json}
 *     projects/<id>/{<stem>.wav ..., meta.json}
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectMeta, SourceMeta, StemName, StemSet } from '@ytx/shared';
import { STEM_NAMES } from '@ytx/shared';
import { LIBRARY_DIR } from './config';
import { encodeWav } from './decode';

const SOURCES_DIR = join(LIBRARY_DIR, 'sources');
const PROJECTS_DIR = join(LIBRARY_DIR, 'projects');
const ARRANGE_DIR = join(LIBRARY_DIR, 'arrangements');

async function ensureDirs() {
  await mkdir(SOURCES_DIR, { recursive: true });
  await mkdir(PROJECTS_DIR, { recursive: true });
  await mkdir(ARRANGE_DIR, { recursive: true });
}

async function readMeta<T>(dir: string, id: string): Promise<T | null> {
  try {
    const raw = await readFile(join(dir, id, 'meta.json'), 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/* ---------- sources ---------- */

export interface SaveSourceInput {
  bytes: Buffer;
  title: string;
  origin: 'youtube' | 'file';
  url?: string;
  durationSeconds?: number;
  ext: string;
  mimeType: string;
  /** JPEG thumbnail bytes (YouTube imports). */
  thumb?: Buffer;
  uploader?: string;
  viewCount?: number;
  likeCount?: number;
  uploadDate?: string;
}

export async function saveSource(input: SaveSourceInput): Promise<SourceMeta> {
  await ensureDirs();
  const id = randomUUID();
  const dir = join(SOURCES_DIR, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `audio.${input.ext}`), input.bytes);
  const hasThumb = !!input.thumb && input.thumb.length > 0;
  if (hasThumb) await writeFile(join(dir, 'thumb.jpg'), input.thumb!);
  const meta: SourceMeta = {
    id,
    title: input.title,
    origin: input.origin,
    url: input.url,
    createdAt: new Date().toISOString(),
    durationSeconds: input.durationSeconds,
    ext: input.ext,
    mimeType: input.mimeType,
    bytes: input.bytes.length,
    hasThumb,
    uploader: input.uploader,
    viewCount: input.viewCount,
    likeCount: input.likeCount,
    uploadDate: input.uploadDate,
  };
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

/** Absolute path to a source's stored thumbnail, or null if none saved. */
export async function getSourceThumbPath(id: string): Promise<string | null> {
  const path = join(SOURCES_DIR, id, 'thumb.jpg');
  try {
    await stat(path);
    return path;
  } catch {
    return null;
  }
}

export async function listSources(): Promise<SourceMeta[]> {
  await ensureDirs();
  const ids = await readdir(SOURCES_DIR).catch(() => []);
  const metas = await Promise.all(ids.map((id) => readMeta<SourceMeta>(SOURCES_DIR, id)));
  return metas
    .filter((m): m is SourceMeta => m !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getSource(
  id: string,
): Promise<{ meta: SourceMeta; audioPath: string } | null> {
  const meta = await readMeta<SourceMeta>(SOURCES_DIR, id);
  if (!meta) return null;
  return { meta, audioPath: join(SOURCES_DIR, id, `audio.${meta.ext}`) };
}

export async function readSourceBytes(id: string): Promise<Buffer | null> {
  const s = await getSource(id);
  if (!s) return null;
  return readFile(s.audioPath);
}

export async function deleteSource(id: string): Promise<void> {
  await rm(join(SOURCES_DIR, id), { recursive: true, force: true });
}

/* ---------- projects ---------- */

export async function saveProject(
  set: StemSet,
  meta: { title: string; sourceId?: string; engine: string },
): Promise<ProjectMeta> {
  await ensureDirs();
  const id = randomUUID();
  const dir = join(PROJECTS_DIR, id);
  await mkdir(dir, { recursive: true });
  for (const stem of set.stems) {
    const wav = encodeWav(stem.channels, set.sampleRate);
    await writeFile(join(dir, `${stem.name}.wav`), wav);
  }
  const projectMeta: ProjectMeta = {
    id,
    title: meta.title,
    sourceId: meta.sourceId,
    createdAt: new Date().toISOString(),
    sampleRate: set.sampleRate,
    numChannels: set.numChannels,
    lengthSamples: set.length,
    stems: set.stems.map((s) => s.name),
    engine: meta.engine,
  };
  await writeFile(join(dir, 'meta.json'), JSON.stringify(projectMeta, null, 2));
  return projectMeta;
}

/** Persist a project from raw per-stem WAV files (browser-separated uploads). */
export async function saveProjectFromWavs(
  stems: { name: StemName; wav: Buffer }[],
  meta: { title: string; engine: string; sampleRate: number; numChannels: number; lengthSamples: number },
): Promise<ProjectMeta> {
  await ensureDirs();
  const id = randomUUID();
  const dir = join(PROJECTS_DIR, id);
  await mkdir(dir, { recursive: true });
  for (const s of stems) await writeFile(join(dir, `${s.name}.wav`), s.wav);
  const projectMeta: ProjectMeta = {
    id,
    title: meta.title,
    createdAt: new Date().toISOString(),
    sampleRate: meta.sampleRate,
    numChannels: meta.numChannels,
    lengthSamples: meta.lengthSamples,
    stems: stems.map((s) => s.name).filter((n): n is StemName => STEM_NAMES.includes(n)),
    engine: meta.engine,
  };
  await writeFile(join(dir, 'meta.json'), JSON.stringify(projectMeta, null, 2));
  return projectMeta;
}

/** Create a project folder + meta up-front; stems are uploaded separately. */
export async function createProjectShell(meta: {
  title: string;
  engine: string;
  sampleRate: number;
  numChannels: number;
  lengthSamples: number;
  stems: StemName[];
}): Promise<ProjectMeta> {
  await ensureDirs();
  const id = randomUUID();
  const dir = join(PROJECTS_DIR, id);
  await mkdir(dir, { recursive: true });
  const projectMeta: ProjectMeta = {
    id,
    title: meta.title,
    createdAt: new Date().toISOString(),
    sampleRate: meta.sampleRate,
    numChannels: meta.numChannels,
    lengthSamples: meta.lengthSamples,
    stems: meta.stems,
    engine: meta.engine,
  };
  await writeFile(join(dir, 'meta.json'), JSON.stringify(projectMeta, null, 2));
  return projectMeta;
}

export async function writeProjectStemWav(id: string, name: string, wav: Buffer): Promise<boolean> {
  const dir = join(PROJECTS_DIR, id);
  try {
    await stat(join(dir, 'meta.json'));
  } catch {
    return false;
  }
  await writeFile(join(dir, `${name}.wav`), wav);
  return true;
}

export async function listProjects(): Promise<ProjectMeta[]> {
  await ensureDirs();
  const ids = await readdir(PROJECTS_DIR).catch(() => []);
  const metas = await Promise.all(ids.map((id) => readMeta<ProjectMeta>(PROJECTS_DIR, id)));
  return metas
    .filter((m): m is ProjectMeta => m !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getProjectStemPath(id: string, name: string): Promise<string | null> {
  const path = join(PROJECTS_DIR, id, `${name}.wav`);
  try {
    await stat(path);
    return path;
  } catch {
    return null;
  }
}

export async function getProjectMeta(id: string): Promise<ProjectMeta | null> {
  return readMeta<ProjectMeta>(PROJECTS_DIR, id);
}

export async function deleteProject(id: string): Promise<void> {
  await rm(join(PROJECTS_DIR, id), { recursive: true, force: true });
}

/* ---------- arrangements (editable clip layouts) ---------- */

/** manifest.json is a client-defined layout; we add id/createdAt and read a few fields. */
interface ArrangementManifest {
  id?: string;
  createdAt?: string;
  title?: string;
  tracks?: unknown[];
  [k: string]: unknown;
}

const BUF_ID_RE = /^[a-zA-Z0-9_]+$/;

export async function createArrangement(
  manifest: ArrangementManifest,
): Promise<{ id: string; createdAt: string }> {
  await ensureDirs();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const dir = join(ARRANGE_DIR, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, id, createdAt }, null, 2));
  return { id, createdAt };
}

export async function writeArrangementBuffer(
  id: string,
  bufferId: string,
  wav: Buffer,
): Promise<boolean> {
  if (!BUF_ID_RE.test(bufferId)) return false;
  const dir = join(ARRANGE_DIR, id);
  try {
    await stat(join(dir, 'manifest.json'));
  } catch {
    return false;
  }
  await writeFile(join(dir, `buf_${bufferId}.wav`), wav);
  return true;
}

export async function getArrangementManifest(id: string): Promise<ArrangementManifest | null> {
  try {
    return JSON.parse(await readFile(join(ARRANGE_DIR, id, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

export async function getArrangementBufferPath(
  id: string,
  bufferId: string,
): Promise<string | null> {
  if (!BUF_ID_RE.test(bufferId)) return null;
  const path = join(ARRANGE_DIR, id, `buf_${bufferId}.wav`);
  try {
    await stat(path);
    return path;
  } catch {
    return null;
  }
}

export async function listArrangements(): Promise<
  { id: string; title: string; createdAt: string; trackCount: number }[]
> {
  await ensureDirs();
  const ids = await readdir(ARRANGE_DIR).catch(() => []);
  const out = await Promise.all(
    ids.map(async (id) => {
      const m = await getArrangementManifest(id);
      if (!m) return null;
      return {
        id,
        title: (m.title as string) ?? 'Untitled',
        createdAt: (m.createdAt as string) ?? '',
        trackCount: Array.isArray(m.tracks) ? m.tracks.length : 0,
      };
    }),
  );
  return out
    .filter((x): x is { id: string; title: string; createdAt: string; trackCount: number } => x !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteArrangement(id: string): Promise<void> {
  await rm(join(ARRANGE_DIR, id), { recursive: true, force: true });
}
