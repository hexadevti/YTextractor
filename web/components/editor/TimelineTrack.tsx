'use client';

import { useEffect, useRef, useState } from 'react';
import { clipEnd, type EditorTrack, type MidiNote, type Selection } from '@/lib/editor/model';
import { computeClipPeaks } from '@/lib/editor/peaks';
import { drawSpectrum, freqBuffer } from '@/lib/mixer/spectrum';
import { INSTRUMENT_GROUPS, getInstrument } from '@/lib/editor/instruments';

export const LANE_HEIGHT = 88;
export const SIDEBAR_WIDTH = 158;

const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

/** Draw a time-aligned piano-roll (for MIDI tracks) into the lane canvas. */
function drawPianoRoll(
  ctx: CanvasRenderingContext2D,
  notes: MidiNote[],
  secToX: (s: number) => number,
  w: number,
  h: number,
) {
  let minP = 127;
  let maxP = 0;
  for (const n of notes) {
    if (n.pitch < minP) minP = n.pitch;
    if (n.pitch > maxP) maxP = n.pitch;
  }
  if (notes.length === 0) {
    minP = 48;
    maxP = 72;
  }
  minP = Math.max(0, minP - 2);
  maxP = Math.min(127, maxP + 2);
  const range = Math.max(1, maxP - minP + 1);
  const rowH = h / range;

  // black-key row shading + C-octave labels for pitch reference
  for (let p = minP; p <= maxP; p++) {
    if (BLACK_KEYS.has(((p % 12) + 12) % 12)) {
      ctx.fillStyle = 'rgba(255,255,255,0.035)';
      ctx.fillRect(0, (maxP - p) * rowH, w, rowH);
    }
  }
  ctx.font = '9px ui-sans-serif, system-ui';
  ctx.textBaseline = 'middle';
  for (let p = minP; p <= maxP; p++) {
    if (((p % 12) + 12) % 12 === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.fillText(`C${Math.floor(p / 12) - 1}`, 3, (maxP - p) * rowH + rowH / 2);
    }
  }
  for (const n of notes) {
    const x0 = secToX(n.startSec);
    const x1 = secToX(n.startSec + n.durationSec);
    if (x1 < 0 || x0 > w) continue;
    const y = (maxP - n.pitch) * rowH;
    const a = 0.4 + 0.5 * (n.velocity / 127);
    const vx0 = Math.max(0, x0);
    ctx.fillStyle = `rgba(34,211,238,${a})`;
    ctx.fillRect(vx0, y + 0.5, Math.max(1.5, x1 - vx0), Math.max(1.5, rowH - 1));
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.strokeRect(vx0 + 0.5, y + 0.5, Math.max(1, x1 - vx0 - 1), Math.max(1, rowH - 1));
  }
}

export interface TimelineTrackProps {
  track: EditorTrack;
  pxPerSec: number;
  scrollSec: number;
  viewportWidth: number;
  laneHeight: number;
  sidebarWidth: number;
  selection: Selection;
  armed: boolean;
  selected: boolean;
  playing: boolean;
  analyser: AnalyserNode | null;
  onPointerDown: (e: React.PointerEvent, trackId: string, localX: number) => void;
  onContextMenu: (e: React.MouseEvent, trackId: string, localX: number) => void;
  onSelectTrack: (id: string) => void;
  onDeleteTrack: (id: string) => void;
  onTranscribe: (id: string) => void;
  midiBusy: boolean;
  midiLoading: boolean;
  onSetInstrument: (id: string, instrument: string) => void;
  onOpenClean: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onStartSidebarResize: (e: React.PointerEvent) => void;
  onStartLaneResize: (e: React.PointerEvent) => void;
  onSetMuted: (id: string, v: boolean) => void;
  onSetSoloed: (id: string, v: boolean) => void;
  onSetVolume: (id: string, v: number) => void;
  onToggleArm: (id: string) => void;
  /** true while this track is the active recording target. */
  recording?: boolean;
  /** live peaks + placement for the growing recording waveform. */
  getRecordPeaks?: () => { peaks: number[]; startSec: number; bucketSec: number } | null;
}

export default function TimelineTrack({
  track,
  pxPerSec,
  scrollSec,
  viewportWidth,
  laneHeight,
  sidebarWidth,
  selection,
  armed,
  selected,
  playing,
  analyser,
  onPointerDown,
  onContextMenu,
  onSelectTrack,
  onDeleteTrack,
  onTranscribe,
  midiBusy,
  midiLoading,
  onSetInstrument,
  onOpenClean,
  onRename,
  onStartSidebarResize,
  onStartLaneResize,
  onSetMuted,
  onSetSoloed,
  onSetVolume,
  onToggleArm,
  recording,
  getRecordPeaks,
}: TimelineTrackProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const specRef = useRef<HTMLCanvasElement>(null);
  const recRef = useRef<HTMLCanvasElement>(null);
  const getRecRef = useRef(getRecordPeaks);
  getRecRef.current = getRecordPeaks;
  const [editing, setEditing] = useState(false);
  const [nameVal, setNameVal] = useState(track.name);
  const isMidi = !!track.midi && track.clips.length === 0;

  // Live spectrum overlay on the lane background (while playing).
  useEffect(() => {
    const spec = specRef.current;
    if (!spec) return;
    if (!analyser || !playing) {
      const c = spec.getContext('2d');
      c?.clearRect(0, 0, spec.width, spec.height);
      return;
    }
    const data = freqBuffer(analyser);
    let raf = 0;
    const tick = () => {
      drawSpectrum(spec, analyser, data, track.color);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [analyser, playing, track.color]);

  // Live recording waveform: a growing overlay drawn each frame while this track
  // is the recording target (the real clip only lands on stop).
  useEffect(() => {
    const cv = recRef.current;
    if (!cv) return;
    const clear = () => cv.getContext('2d')?.clearRect(0, 0, cv.width, cv.height);
    if (!recording || viewportWidth <= 0) {
      clear();
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const w = viewportWidth;
    const h = laneHeight;
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr;
      cv.height = h * dpr;
    }
    const ctx = cv.getContext('2d')!;
    let raf = 0;
    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const info = getRecRef.current?.();
      if (info && info.peaks.length) {
        const { peaks, startSec, bucketSec } = info;
        const secToX = (s: number) => (s - scrollSec) * pxPerSec;
        const mid = h / 2;
        const scale = (h - 16) / 2;
        const bw = Math.max(1, bucketSec * pxPerSec);
        const x0 = secToX(startSec);
        const x1 = secToX(startSec + peaks.length * bucketSec);
        // recording clip body tint
        const bx0 = Math.max(0, x0);
        const bx1 = Math.min(w, x1);
        if (bx1 > bx0) {
          ctx.fillStyle = 'rgba(239, 68, 68, 0.10)';
          ctx.fillRect(bx0, 4, bx1 - bx0, h - 8);
        }
        ctx.fillStyle = track.color;
        for (let b = 0; b < peaks.length; b++) {
          const x = secToX(startSec + b * bucketSec);
          if (x + bw < 0 || x > w) continue;
          const p = peaks[b]!;
          ctx.fillRect(x, mid - p * scale, bw, Math.max(1, 2 * p * scale));
        }
        // leading edge marker
        if (x1 >= 0 && x1 <= w) {
          ctx.fillStyle = 'rgba(239, 68, 68, 0.9)';
          ctx.fillRect(x1 - 1, 4, 2, h - 8);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      clear();
    };
  }, [recording, pxPerSec, scrollSec, viewportWidth, laneHeight, track.color]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewportWidth <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = viewportWidth;
    const h = laneHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const secToX = (sec: number) => (sec - scrollSec) * pxPerSec;
    const mid = h / 2;

    // selection overlay for this track
    const selActive =
      selection.trackIds.includes(track.id) && selection.endSec - selection.startSec > 1e-6;
    if (selActive) {
      const sx0 = Math.max(0, secToX(selection.startSec));
      const sx1 = Math.min(w, secToX(selection.endSec));
      if (sx1 > sx0) {
        ctx.fillStyle = 'rgba(99, 102, 241, 0.18)';
        ctx.fillRect(sx0, 0, sx1 - sx0, h);
      }
    }

    if (isMidi) {
      drawPianoRoll(ctx, track.midi ?? [], secToX, w, h);
    } else {
      for (const clip of track.clips) {
        const x0 = secToX(clip.startSec);
        const x1 = secToX(clipEnd(clip));
        if (x1 < 0 || x0 > w) continue;
        const vx0 = Math.max(0, x0);
        const vx1 = Math.min(w, x1);
        const selected = selection.clipIds.includes(clip.id);

        // clip body
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.fillRect(vx0, 4, vx1 - vx0, h - 8);

        // waveform
        const peaks = computeClipPeaks(clip, pxPerSec);
        ctx.fillStyle = track.color;
        ctx.globalAlpha = 0.9;
        const scale = (h - 16) / 2;
        for (let b = 0; b < peaks.buckets; b++) {
          const x = x0 + b;
          if (x < 0 || x > w) continue;
          const top = mid - peaks.max[b]! * scale;
          const bottom = mid - peaks.min[b]! * scale;
          ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
        }
        ctx.globalAlpha = 1;

        // clip border
        ctx.strokeStyle = selected ? '#22d3ee' : 'rgba(255,255,255,0.18)';
        ctx.lineWidth = selected ? 2 : 1;
        ctx.strokeRect(vx0 + 0.5, 4.5, vx1 - vx0 - 1, h - 9);
      }
    }
  }, [track, pxPerSec, scrollSec, viewportWidth, laneHeight, selection, isMidi]);

  return (
    <div className={`lane-row${selected ? ' selected' : ''}`} style={{ height: laneHeight }}>
      <div
        className="lane-sidebar"
        style={{ width: sidebarWidth }}
        onPointerDown={() => onSelectTrack(track.id)}
      >
        <div className="lane-name">
          <span className="swatch" style={{ background: track.color }} />
          {editing ? (
            <input
              className="lane-title-input"
              autoFocus
              value={nameVal}
              onChange={(e) => setNameVal(e.target.value)}
              onBlur={() => {
                setEditing(false);
                onRename(track.id, nameVal);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setEditing(false);
                  onRename(track.id, nameVal);
                } else if (e.key === 'Escape') {
                  setEditing(false);
                  setNameVal(track.name);
                }
              }}
            />
          ) : (
            <span
              className="lane-title"
              title="Double-click to rename"
              onDoubleClick={() => {
                setNameVal(track.name);
                setEditing(true);
              }}
            >
              {track.name}
            </span>
          )}
        </div>
        <div className="lane-controls" onPointerDown={(e) => e.stopPropagation()}>
          <button
            className={`mini${track.muted ? ' on-mute' : ''}`}
            title="Mute"
            onClick={() => onSetMuted(track.id, !track.muted)}
          >
            M
          </button>
          <button
            className={`mini${track.soloed ? ' on-solo' : ''}`}
            title="Solo"
            onClick={() => onSetSoloed(track.id, !track.soloed)}
          >
            S
          </button>
          <button
            className={`mini${armed ? ' on-rec' : ''}`}
            title="Arm for recording"
            onClick={() => onToggleArm(track.id)}
          >
            ●
          </button>
          <button className="mini" title="Delete track (undoable)" onClick={() => onDeleteTrack(track.id)}>
            🗑
          </button>
          {track.clips.length > 0 && (
            <button
              className="mini"
              title="Convert this track's audio to MIDI"
              disabled={midiBusy}
              onClick={() => onTranscribe(track.id)}
            >
              🎹
            </button>
          )}
        </div>
        <div className="lane-volume" onPointerDown={(e) => e.stopPropagation()}>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.01}
            value={track.volume}
            title={`Volume ${(track.volume * 100).toFixed(0)}%`}
            onChange={(e) => onSetVolume(track.id, Number(e.target.value))}
          />
        </div>
        <div
          className="sidebar-resize"
          title="Drag to resize the track controls"
          onPointerDown={(e) => {
            e.stopPropagation();
            onStartSidebarResize(e);
          }}
        />
      </div>
      <div className="lane-visual" style={{ width: viewportWidth, height: laneHeight }}>
        <canvas
          ref={canvasRef}
          className="lane-canvas"
          style={{ width: viewportWidth, height: laneHeight }}
          onPointerDown={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onPointerDown(e, track.id, e.clientX - rect.left);
          }}
          onContextMenu={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onContextMenu(e, track.id, e.clientX - rect.left);
          }}
        />
        <canvas
          ref={specRef}
          className="lane-spectrum"
          style={{ width: viewportWidth, height: laneHeight }}
        />
        <canvas
          ref={recRef}
          className="lane-rec"
          style={{ width: viewportWidth, height: laneHeight }}
        />
        {isMidi && (
          <div className="lane-midi-controls">
            <select
              className="midi-inst"
              value={getInstrument(track.instrument).name}
              onChange={(e) => onSetInstrument(track.id, e.target.value)}
              title="Instrument (synth sound + exported MIDI program)"
            >
              {INSTRUMENT_GROUPS.map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.items.map((i) => (
                    <option key={i.name} value={i.name}>
                      {i.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {midiLoading && <span className="midi-loading">loading…</span>}
            <button
              className="midi-btn"
              title="Clean up MIDI notes (noise removal, monophonic/bass)…"
              onClick={() => onOpenClean(track.id)}
            >
              🧹 Clean…
            </button>
          </div>
        )}
      </div>
      <div
        className="lane-resize"
        title="Drag to resize the track height"
        onPointerDown={(e) => {
          e.stopPropagation();
          onStartLaneResize(e);
        }}
      />
    </div>
  );
}
