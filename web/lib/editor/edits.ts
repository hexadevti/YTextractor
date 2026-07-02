/**
 * Pure, non-destructive editing operations. Each returns a NEW EditorProject
 * (clip/track metadata cloned, AudioBuffers shared) so the history stack can
 * snapshot cheaply. No AudioBuffer data is ever mutated.
 */

import {
  clipEnd,
  cloneProject,
  uid,
  type Clip,
  type EditorProject,
  type EditorTrack,
  type Selection,
} from './model';

export interface ClipboardFragment {
  buffer: AudioBuffer;
  offsetSec: number;
  durationSec: number;
  /** start relative to the copied range start */
  startSecRel: number;
}

export interface ClipboardTrack {
  trackId: string;
  fragments: ClipboardFragment[];
}

export interface Clipboard {
  durationSec: number;
  tracks: ClipboardTrack[];
}

const EPS = 1e-6;

function sortClips(track: EditorTrack) {
  track.clips.sort((a, b) => a.startSec - b.startSec);
}

/** Portion of `clip` covering the timeline range [fromSec, toSec), or null. */
function sliceClip(clip: Clip, fromSec: number, toSec: number): Clip | null {
  const s = Math.max(clip.startSec, fromSec);
  const e = Math.min(clipEnd(clip), toSec);
  if (e - s <= EPS) return null;
  return {
    id: uid(),
    buffer: clip.buffer,
    startSec: s,
    offsetSec: clip.offsetSec + (s - clip.startSec),
    durationSec: e - s,
  };
}

/** Split every clip crossing `timeSec` on the given tracks. */
export function splitAt(
  project: EditorProject,
  timeSec: number,
  trackIds: string[],
): EditorProject {
  const next = cloneProject(project);
  for (const track of next.tracks) {
    if (!trackIds.includes(track.id)) continue;
    const out: Clip[] = [];
    for (const clip of track.clips) {
      if (timeSec > clip.startSec + EPS && timeSec < clipEnd(clip) - EPS) {
        const left = sliceClip(clip, clip.startSec, timeSec);
        const right = sliceClip(clip, timeSec, clipEnd(clip));
        if (left) out.push(left);
        if (right) out.push(right);
      } else {
        out.push(clip);
      }
    }
    track.clips = out;
    sortClips(track);
  }
  return next;
}

/** Copy the selected time range across the selected tracks. */
export function copyRange(project: EditorProject, sel: Selection): Clipboard | null {
  if (sel.endSec - sel.startSec <= EPS || sel.trackIds.length === 0) return null;
  const tracks: ClipboardTrack[] = [];
  for (const track of project.tracks) {
    if (!sel.trackIds.includes(track.id)) continue;
    const fragments: ClipboardFragment[] = [];
    for (const clip of track.clips) {
      const frag = sliceClip(clip, sel.startSec, sel.endSec);
      if (frag) {
        fragments.push({
          buffer: frag.buffer,
          offsetSec: frag.offsetSec,
          durationSec: frag.durationSec,
          startSecRel: frag.startSec - sel.startSec,
        });
      }
    }
    tracks.push({ trackId: track.id, fragments });
  }
  return { durationSec: sel.endSec - sel.startSec, tracks };
}

/** Remove a time range on the given tracks (leaves a gap; non-ripple). */
export function removeRange(
  project: EditorProject,
  trackIds: string[],
  startSec: number,
  endSec: number,
): EditorProject {
  const next = cloneProject(project);
  for (const track of next.tracks) {
    if (!trackIds.includes(track.id)) continue;
    const out: Clip[] = [];
    for (const clip of track.clips) {
      if (clipEnd(clip) <= startSec + EPS || clip.startSec >= endSec - EPS) {
        out.push(clip);
        continue;
      }
      const left = sliceClip(clip, clip.startSec, startSec);
      const right = sliceClip(clip, endSec, clipEnd(clip));
      if (left) out.push(left);
      if (right) out.push(right);
    }
    track.clips = out;
    sortClips(track);
  }
  return next;
}

/** Cut = copy the range then remove it. */
export function cutRange(
  project: EditorProject,
  sel: Selection,
): { project: EditorProject; clipboard: Clipboard | null } {
  const clipboard = copyRange(project, sel);
  const project2 = removeRange(project, sel.trackIds, sel.startSec, sel.endSec);
  return { project: project2, clipboard };
}

/** Paste clipboard fragments at `atSec` onto their original tracks (or the first). */
export function paste(
  project: EditorProject,
  clipboard: Clipboard,
  atSec: number,
): EditorProject {
  const next = cloneProject(project);
  for (const ct of clipboard.tracks) {
    const target = next.tracks.find((t) => t.id === ct.trackId) ?? next.tracks[0];
    if (!target) continue;
    for (const frag of ct.fragments) {
      target.clips.push({
        id: uid(),
        buffer: frag.buffer,
        offsetSec: frag.offsetSec,
        durationSec: frag.durationSec,
        startSec: Math.max(0, atSec + frag.startSecRel),
      });
    }
    sortClips(target);
  }
  return next;
}

/** Delete selected clips, or (if a range is selected) clear the range. */
export function deleteSelection(project: EditorProject, sel: Selection): EditorProject {
  if (sel.clipIds.length > 0) {
    const next = cloneProject(project);
    for (const track of next.tracks) {
      track.clips = track.clips.filter((c) => !sel.clipIds.includes(c.id));
    }
    return next;
  }
  if (sel.endSec - sel.startSec > EPS && sel.trackIds.length > 0) {
    return removeRange(project, sel.trackIds, sel.startSec, sel.endSec);
  }
  return project;
}

/** Move a clip in time and/or to another track. */
export function moveClip(
  project: EditorProject,
  clipId: string,
  newStartSec: number,
  newTrackId: string,
): EditorProject {
  const next = cloneProject(project);
  let moving: Clip | undefined;
  for (const track of next.tracks) {
    const idx = track.clips.findIndex((c) => c.id === clipId);
    if (idx >= 0) {
      moving = track.clips[idx];
      track.clips.splice(idx, 1);
      break;
    }
  }
  if (!moving) return project;
  moving.startSec = Math.max(0, newStartSec);
  const target = next.tracks.find((t) => t.id === newTrackId) ?? next.tracks[0];
  if (!target) return project;
  target.clips.push(moving);
  sortClips(target);
  return next;
}

/** Trim a clip edge non-destructively (bounded by the buffer and > 0 length). */
export function trimClipEdge(
  project: EditorProject,
  clipId: string,
  edge: 'start' | 'end',
  deltaSec: number,
): EditorProject {
  const next = cloneProject(project);
  for (const track of next.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (!clip) continue;
    const bufDur = clip.buffer.duration;
    if (edge === 'start') {
      // Move the left edge: change startSec + offsetSec together.
      let delta = deltaSec;
      delta = Math.max(delta, -clip.offsetSec); // can't offset before 0
      delta = Math.min(delta, clip.durationSec - 0.02); // keep some length
      clip.startSec += delta;
      clip.offsetSec += delta;
      clip.durationSec -= delta;
    } else {
      let dur = clip.durationSec + deltaSec;
      dur = Math.max(0.02, Math.min(dur, bufDur - clip.offsetSec));
      clip.durationSec = dur;
    }
    sortClips(track);
    break;
  }
  return next;
}
