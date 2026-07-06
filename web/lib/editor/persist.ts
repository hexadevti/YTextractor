/**
 * Save/load an editable arrangement (clip layout + referenced audio) to the
 * backend library. Unique AudioBuffers are encoded once (deduped by identity)
 * and referenced by id from each clip, so splits/copies don't duplicate audio.
 */

import type { ArrangementSummary, ProgressUpdate, SelectableStem } from '@prismaxim/shared';
import { decodeToModelAudio } from '../audio';
import { encodeWav } from '../mixer/export';
import { makeAudioBuffer, uid, type EditorProject, type MidiNote } from './model';

interface PersistClip {
  bufferId: string;
  startSec: number;
  offsetSec: number;
  durationSec: number;
  fadeInSec?: number;
  fadeOutSec?: number;
}
interface PersistTrack {
  id: string;
  name: string;
  color: string;
  stem?: SelectableStem;
  muted: boolean;
  soloed: boolean;
  volume: number;
  clips: PersistClip[];
  midi?: MidiNote[];
  instrument?: string;
}
export interface ArrangementManifest {
  version: 1;
  title: string;
  sampleRate: number;
  numChannels: number;
  buffers: string[];
  tracks: PersistTrack[];
}

export function serialize(
  project: EditorProject,
  title: string,
): { manifest: ArrangementManifest; buffers: { id: string; buffer: AudioBuffer }[] } {
  const map = new Map<AudioBuffer, string>();
  const buffers: { id: string; buffer: AudioBuffer }[] = [];
  const tracks: PersistTrack[] = project.tracks.map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color,
    stem: t.stem,
    muted: t.muted,
    soloed: t.soloed,
    volume: t.volume,
    midi: t.midi,
    instrument: t.instrument,
    clips: t.clips.map((c) => {
      let id = map.get(c.buffer);
      if (!id) {
        id = `b${buffers.length}`;
        map.set(c.buffer, id);
        buffers.push({ id, buffer: c.buffer });
      }
      return {
        bufferId: id,
        startSec: c.startSec,
        offsetSec: c.offsetSec,
        durationSec: c.durationSec,
        fadeInSec: c.fadeInSec,
        fadeOutSec: c.fadeOutSec,
      };
    }),
  }));
  return {
    manifest: {
      version: 1,
      title,
      sampleRate: project.sampleRate,
      numChannels: project.numChannels,
      buffers: buffers.map((b) => b.id),
      tracks,
    },
    buffers,
  };
}

export async function saveArrangement(
  baseUrl: string,
  project: EditorProject,
  title: string,
  onProgress?: (p: ProgressUpdate) => void,
): Promise<ArrangementSummary> {
  const { manifest, buffers } = serialize(project, title);
  const res = await fetch(`${baseUrl}/library/arrangements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  if (!res.ok) throw new Error(`Save failed (${res.status})`);
  const { id } = (await res.json()) as { id: string };

  for (let i = 0; i < buffers.length; i++) {
    const b = buffers[i]!;
    onProgress?.({
      phase: 'separating',
      percent: Math.round(((i + 1) / buffers.length) * 100),
      message: `Saving audio ${i + 1}/${buffers.length}`,
    });
    const wav = encodeWav(b.buffer);
    const put = await fetch(`${baseUrl}/library/arrangements/${id}/buffers/${b.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'audio/wav' },
      body: await wav.arrayBuffer(),
    });
    if (!put.ok) throw new Error(`Saving audio ${b.id} failed (${put.status})`);
  }
  return { id, title, createdAt: new Date().toISOString(), trackCount: manifest.tracks.length };
}

/** Rebuild an editor project from a manifest + already-decoded audio buffers. */
export function deserializeManifest(
  manifest: ArrangementManifest,
  bufMap: Map<string, AudioBuffer>,
): EditorProject {
  return {
    sampleRate: manifest.sampleRate,
    numChannels: manifest.numChannels,
    tracks: manifest.tracks.map((t) => ({
      id: t.id || uid(),
      name: t.name,
      color: t.color,
      stem: t.stem,
      muted: t.muted,
      soloed: t.soloed,
      volume: t.volume,
      armed: false,
      midi: t.midi,
      instrument: t.instrument,
      clips: t.clips
        .filter((pc) => bufMap.has(pc.bufferId))
        .map((pc) => ({
          id: uid(),
          buffer: bufMap.get(pc.bufferId)!,
          startSec: pc.startSec,
          offsetSec: pc.offsetSec,
          durationSec: pc.durationSec,
          fadeInSec: pc.fadeInSec,
          fadeOutSec: pc.fadeOutSec,
        })),
    })),
  };
}

export async function loadArrangement(
  baseUrl: string,
  id: string,
  onProgress?: (p: ProgressUpdate) => void,
): Promise<{ project: EditorProject; title: string }> {
  const res = await fetch(`${baseUrl}/library/arrangements/${id}`);
  if (!res.ok) throw new Error(`Failed to load arrangement (${res.status})`);
  const manifest = (await res.json()) as ArrangementManifest;

  const bufMap = new Map<string, AudioBuffer>();
  for (let i = 0; i < manifest.buffers.length; i++) {
    const bid = manifest.buffers[i]!;
    onProgress?.({
      phase: 'loading-model',
      percent: Math.round(((i + 1) / manifest.buffers.length) * 100),
      message: `Loading audio ${i + 1}/${manifest.buffers.length}`,
    });
    const r = await fetch(`${baseUrl}/library/arrangements/${id}/buffers/${bid}`);
    if (!r.ok) throw new Error(`Failed to load audio ${bid} (${r.status})`);
    const decoded = await decodeToModelAudio(await r.arrayBuffer());
    bufMap.set(bid, makeAudioBuffer(decoded.channels, decoded.sampleRate));
  }

  return { project: deserializeManifest(manifest, bufMap), title: manifest.title };
}
