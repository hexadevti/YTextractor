/**
 * Clip-aware offline render of the whole arrangement, reusing the mixer's
 * WAV/MP3 encoders and download helper.
 */

import { clipEnd, effectiveTrackGain, totalDuration, type EditorProject } from './model';
import { encodeMp3, encodeWav, downloadBlob } from '../mixer/export';

export { encodeMp3, encodeWav, downloadBlob };

/** Render a single track (unmuted, full gain) to an AudioBuffer — for transcription. */
export async function renderTrack(
  project: EditorProject,
  trackId: string,
): Promise<AudioBuffer | null> {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return null;
  return renderProject({
    sampleRate: project.sampleRate,
    numChannels: project.numChannels,
    tracks: [{ ...track, muted: false, soloed: false, volume: 1 }],
  });
}

/** Decoded audio in the layout the Demucs model expects (44.1 kHz stereo). */
export interface ModelAudio {
  channels: Float32Array[];
  sampleRate: number;
  length: number;
}

/**
 * Render a time region [startSec, endSec] of the given audio tracks into a
 * 44.1 kHz stereo mixdown — the exact input the stem-separation model expects.
 * Used by the editor's "separate selection into stems" action: the region is
 * sliced out and resampled in one offline pass (the picked tracks are mixed at
 * unity gain, ignoring their mute/solo/volume, so the selection separates
 * whatever audio it covers). MIDI tracks carry no audio and are skipped.
 */
export async function renderRegionToModelAudio(
  project: EditorProject,
  trackIds: string[],
  startSec: number,
  endSec: number,
): Promise<ModelAudio> {
  const SR = 44100;
  const CH = 2;
  const dur = Math.max(1 / SR, endSec - startSec);
  const frames = Math.max(1, Math.ceil(dur * SR));
  const offline = new OfflineAudioContext(CH, frames, SR);
  const master = offline.createGain();
  master.connect(offline.destination);

  const include = new Set(trackIds);
  for (const track of project.tracks) {
    if (!include.has(track.id) || track.midi) continue;
    for (const clip of track.clips) {
      const cs = clip.startSec;
      const ce = clipEnd(clip);
      if (ce <= startSec || cs >= endSec) continue; // no overlap with the region
      // Clamp the clip to the region and shift it so the region begins at t=0.
      const playStart = Math.max(cs, startSec);
      const playEnd = Math.min(ce, endSec);
      const when = playStart - startSec;
      const offsetIntoBuffer = clip.offsetSec + (playStart - cs);
      const playDur = playEnd - playStart;
      const src = offline.createBufferSource();
      src.buffer = clip.buffer;
      src.connect(master);
      try {
        src.start(when, offsetIntoBuffer, playDur);
      } catch {
        /* out-of-range clip; skip */
      }
    }
  }

  const buf = await offline.startRendering();
  const channels: Float32Array[] = [];
  for (let c = 0; c < CH; c++) {
    const srcCh = c < buf.numberOfChannels ? c : 0;
    channels.push(Float32Array.from(buf.getChannelData(srcCh)));
  }
  return { channels, sampleRate: SR, length: buf.length };
}

/** Peak absolute sample across channels — used to detect a silent region. */
export function peakLevel(channels: Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]!);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/** Render the arrangement (clip positions, trims, gains) to a single buffer. */
export async function renderProject(project: EditorProject): Promise<AudioBuffer> {
  const sr = project.sampleRate;
  const dur = Math.max(totalDuration(project), 1 / sr);
  const frames = Math.max(1, Math.ceil(dur * sr));
  const offline = new OfflineAudioContext(project.numChannels, frames, sr);
  const master = offline.createGain();
  master.connect(offline.destination);

  for (const track of project.tracks) {
    const g = effectiveTrackGain(project, track);
    if (g <= 0) continue;
    const trackGain = offline.createGain();
    trackGain.gain.value = g;
    trackGain.connect(master);
    for (const clip of track.clips) {
      const src = offline.createBufferSource();
      src.buffer = clip.buffer;
      const fadeIn = clip.fadeInSec ?? 0;
      const fadeOut = clip.fadeOutSec ?? 0;
      if (fadeIn > 1e-4 || fadeOut > 1e-4) {
        const cg = offline.createGain();
        src.connect(cg);
        cg.connect(trackGain);
        const g = cg.gain;
        const s = clip.startSec;
        const e = clipEnd(clip);
        g.setValueAtTime(fadeIn > 1e-4 ? 0 : 1, s);
        if (fadeIn > 1e-4) g.linearRampToValueAtTime(1, s + fadeIn);
        if (fadeOut > 1e-4) {
          g.setValueAtTime(1, Math.max(s + fadeIn, e - fadeOut));
          g.linearRampToValueAtTime(0, e);
        }
      } else {
        src.connect(trackGain);
      }
      try {
        src.start(clip.startSec, clip.offsetSec, clip.durationSec);
      } catch {
        /* out-of-range clip; skip */
      }
    }
  }
  return offline.startRendering();
}
