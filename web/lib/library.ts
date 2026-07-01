/**
 * Web client for the backend library: import/list sources, open/load saved
 * projects into the mixer, and save browser-separated projects.
 */

import {
  STEM_NAMES,
  type ProgressUpdate,
  type ProjectMeta,
  type SourceMeta,
  type StemName,
  type StemSet,
} from '@ytx/shared';
import { decodeToModelAudio, stemSetFromChannels } from './audio';
import { encodeWav } from './mixer/export';

export async function listSources(baseUrl: string): Promise<SourceMeta[]> {
  const res = await fetch(`${baseUrl}/library/sources`);
  if (!res.ok) throw new Error(`Failed to list sources (${res.status})`);
  return res.json();
}

export async function listProjects(baseUrl: string): Promise<ProjectMeta[]> {
  const res = await fetch(`${baseUrl}/library/projects`);
  if (!res.ok) throw new Error(`Failed to list projects (${res.status})`);
  return res.json();
}

export async function importYouTube(baseUrl: string, url: string): Promise<SourceMeta> {
  const res = await fetch(`${baseUrl}/library/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Import failed (${res.status}). ${detail}`);
  }
  return res.json();
}

export async function uploadSource(baseUrl: string, file: File): Promise<SourceMeta> {
  const ext = file.name.split('.').pop()?.toLowerCase() || 'audio';
  const res = await fetch(`${baseUrl}/library/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Title': encodeURIComponent(file.name.replace(/\.[^.]+$/, '')),
      'X-Ext': ext,
    },
    body: await file.arrayBuffer(),
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  return res.json();
}

/** Direct URL to open/play/download a saved source's audio. */
export function sourceAudioUrl(baseUrl: string, id: string): string {
  return `${baseUrl}/library/sources/${id}/audio`;
}

export async function getSourceAudioBytes(baseUrl: string, id: string): Promise<ArrayBuffer> {
  const res = await fetch(sourceAudioUrl(baseUrl, id));
  if (!res.ok) throw new Error(`Failed to load source audio (${res.status})`);
  return res.arrayBuffer();
}

/** Load a saved project's stems into a StemSet for the mixer. */
export async function loadProject(
  baseUrl: string,
  project: ProjectMeta,
  onProgress?: (p: ProgressUpdate) => void,
): Promise<StemSet> {
  const names = project.stems.length ? project.stems : (STEM_NAMES as unknown as StemName[]);
  const perStemChannels: Float32Array[][] = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    onProgress?.({
      phase: 'loading-model',
      percent: Math.round(((i + 1) / names.length) * 100),
      message: `Loading ${name}…`,
    });
    const res = await fetch(`${baseUrl}/library/projects/${project.id}/stems/${name}`);
    if (!res.ok) throw new Error(`Failed to load stem "${name}" (${res.status})`);
    const decoded = await decodeToModelAudio(await res.arrayBuffer());
    perStemChannels.push(decoded.channels);
  }
  return stemSetFromChannels(perStemChannels, project.sampleRate);
}

/** Persist a browser-separated StemSet to the backend library. */
export async function saveBrowserProject(
  baseUrl: string,
  set: StemSet,
  title: string,
  onProgress?: (p: ProgressUpdate) => void,
): Promise<ProjectMeta> {
  const shellRes = await fetch(`${baseUrl}/library/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      engine: 'browser',
      sampleRate: set.sampleRate,
      numChannels: set.numChannels,
      lengthSamples: set.length,
      stems: set.stems.map((s) => s.name),
    }),
  });
  if (!shellRes.ok) throw new Error(`Failed to create project (${shellRes.status})`);
  const project = (await shellRes.json()) as ProjectMeta;

  for (let i = 0; i < set.stems.length; i++) {
    const stem = set.stems[i]!;
    onProgress?.({
      phase: 'separating',
      percent: Math.round(((i + 1) / set.stems.length) * 100),
      message: `Saving ${stem.name}…`,
    });
    const wav = encodeWav(stemToAudioBuffer(stem.channels, set.sampleRate));
    const putRes = await fetch(`${baseUrl}/library/projects/${project.id}/stems/${stem.name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'audio/wav' },
      body: await wav.arrayBuffer(),
    });
    if (!putRes.ok) throw new Error(`Failed to save stem "${stem.name}" (${putRes.status})`);
  }
  return project;
}

export async function deleteSource(baseUrl: string, id: string): Promise<void> {
  await fetch(`${baseUrl}/library/sources/${id}`, { method: 'DELETE' });
}

export async function deleteProject(baseUrl: string, id: string): Promise<void> {
  await fetch(`${baseUrl}/library/projects/${id}`, { method: 'DELETE' });
}

/** Wrap raw channels in a minimal AudioBuffer-like object for encodeWav. */
function stemToAudioBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  const ctx = new OfflineAudioContext(channels.length, channels[0]?.length ?? 1, sampleRate);
  const buffer = ctx.createBuffer(channels.length, channels[0]?.length ?? 1, sampleRate);
  for (let c = 0; c < channels.length; c++) {
    buffer.copyToChannel(channels[c]! as Float32Array<ArrayBuffer>, c);
  }
  return buffer;
}
