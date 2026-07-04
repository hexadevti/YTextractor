'use client';

import { useEffect, useRef, useState } from 'react';
import { AudioLines, AudioWaveform, Circle, Eraser, Music4, Trash2 } from 'lucide-react';
import { clipEnd, type EditorTrack, type MidiNote, type Selection } from '@/lib/editor/model';
import { computeClipPeaks } from '@/lib/editor/peaks';
import { drawSpectrum, freqBuffer } from '@/lib/mixer/spectrum';
import { meterFraction, rmsLevel, timeBuffer } from '@/lib/mixer/meter';
import { INSTRUMENT_GROUPS, getInstrument } from '@/lib/editor/instruments';
import { IS_MOBILE } from '@/lib/env';

export const LANE_HEIGHT = 88;
export const SIDEBAR_WIDTH = 158;

const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

/** Width of the draggable trim handles at each clip edge (mirrors Editor's EDGE_PX). */
const HANDLE_PX = 6;

/** Top band (px) in which a fade handle can be grabbed, and its horizontal tolerance. */
export const FADE_BAND_PX = 22;
export const FADE_GRAB_PX = 7;

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
  onPointerDown: (e: React.PointerEvent, trackId: string, localX: number, localY: number) => void;
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
  const vuRef = useRef<HTMLDivElement>(null);
  const getRecRef = useRef(getRecordPeaks);
  getRecRef.current = getRecordPeaks;
  const [editing, setEditing] = useState(false);
  const [nameVal, setNameVal] = useState(track.name);
  // Per-track view options (defaults: spectrum on, simplified waveform).
  const [spectrumOn, setSpectrumOn] = useState(true);
  const [waveFull, setWaveFull] = useState(false);
  const isMidi = !!track.midi && track.clips.length === 0;

  // Cursor hint for a point on the lane: pointer over a fade handle, ew-resize
  // over a clip edge (trim), default over a clip body, crosshair over empty lane.
  const laneCursorAt = (localX: number, localY: number): string => {
    if (isMidi) return 'crosshair';
    const secToX = (sec: number) => (sec - scrollSec) * pxPerSec;
    // Iterate topmost-first (last drawn wins), matching Editor's hit-testing.
    for (let i = track.clips.length - 1; i >= 0; i--) {
      const c = track.clips[i]!;
      const x0 = secToX(c.startSec);
      const x1 = secToX(clipEnd(c));
      if (localX < x0 || localX > x1) continue;
      if (localY <= FADE_BAND_PX) {
        const fi = c.fadeInSec ?? 0;
        const fo = c.fadeOutSec ?? 0;
        if (fi > 0 && Math.abs(localX - secToX(c.startSec + fi)) <= FADE_GRAB_PX) return 'pointer';
        if (fo > 0 && Math.abs(localX - secToX(clipEnd(c) - fo)) <= FADE_GRAB_PX) return 'pointer';
      }
      return localX - x0 <= HANDLE_PX || x1 - localX <= HANDLE_PX ? 'ew-resize' : 'default';
    }
    return 'crosshair';
  };

  // Live spectrum overlay on the lane background (while playing, when enabled).
  useEffect(() => {
    const spec = specRef.current;
    if (!spec) return;
    if (!analyser || !playing || !spectrumOn) {
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
  }, [analyser, playing, spectrumOn, track.color]);

  // Per-track VU meter in the lane sidebar (level of this track, while playing).
  useEffect(() => {
    const bar = vuRef.current;
    if (!bar) return;
    const reset = () => {
      bar.style.width = '0%';
    };
    if (!analyser || !playing) {
      reset();
      return;
    }
    const buf = timeBuffer(analyser);
    let raf = 0;
    const tick = () => {
      const frac = meterFraction(rmsLevel(analyser, buf));
      bar.style.width = `${frac * 100}%`;
      bar.style.background = frac > 0.92 ? 'var(--danger)' : 'var(--ok)';
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      reset();
    };
  }, [analyser, playing]);

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

        // waveform: full detail (min/max per px) or a simplified coarse envelope
        const peaks = computeClipPeaks(clip, pxPerSec);
        ctx.fillStyle = track.color;
        ctx.globalAlpha = 0.9;
        const scale = (h - 16) / 2;
        if (waveFull) {
          for (let b = 0; b < peaks.buckets; b++) {
            const x = x0 + b;
            if (x < 0 || x > w) continue;
            const top = mid - peaks.max[b]! * scale;
            const bottom = mid - peaks.min[b]! * scale;
            ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
          }
        } else {
          // coarse symmetric bars: fewer, wider blocks for a lighter look
          const STEP = 3;
          for (let b = 0; b < peaks.buckets; b += STEP) {
            const x = x0 + b;
            if (x + STEP < 0 || x > w) continue;
            let amp = 0;
            for (let k = b; k < b + STEP && k < peaks.buckets; k++) {
              const a = Math.max(Math.abs(peaks.max[k]!), Math.abs(peaks.min[k]!));
              if (a > amp) amp = a;
            }
            const barH = Math.max(1, amp * scale * 2);
            ctx.fillRect(x, mid - barH / 2, STEP - 1, barH);
          }
        }
        ctx.globalAlpha = 1;

        // clip border
        ctx.strokeStyle = selected ? '#22d3ee' : 'rgba(255,255,255,0.18)';
        ctx.lineWidth = selected ? 2 : 1;
        ctx.strokeRect(vx0 + 0.5, 4.5, vx1 - vx0 - 1, h - 9);

        // selected clip: draw wider grab handles on each edge to signal that the
        // sides can be dragged to trim (matches the ew-resize hover cursor).
        if (selected) {
          const drawHandle = (hx: number) => {
            ctx.fillStyle = 'rgba(34,211,238,0.9)';
            ctx.fillRect(hx, 4, HANDLE_PX, h - 8);
            ctx.fillStyle = 'rgba(0,0,0,0.45)';
            ctx.fillRect(hx + HANDLE_PX / 2 - 1.5, mid - 6, 1, 12);
            ctx.fillRect(hx + HANDLE_PX / 2 + 0.5, mid - 6, 1, 12);
          };
          if (x0 >= 0 && x0 <= w) drawHandle(x0);
          if (x1 >= 0 && x1 <= w) drawHandle(x1 - HANDLE_PX);
        }

        // fade envelopes: a line from the corner up to the fade end, the
        // attenuated area shaded, and a draggable handle dot at the top.
        const top = 5;
        const bottom = h - 5;
        const fadeIn = clip.fadeInSec ?? 0;
        const fadeOut = clip.fadeOutSec ?? 0;
        const drawFade = (cornerX: number, endX: number) => {
          ctx.fillStyle = 'rgba(0,0,0,0.32)';
          ctx.beginPath();
          ctx.moveTo(cornerX, top);
          ctx.lineTo(endX, top);
          ctx.lineTo(cornerX, bottom);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = 'rgba(250,204,21,0.95)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(cornerX, bottom);
          ctx.lineTo(endX, top);
          ctx.stroke();
          // handle dot at the top (fade end)
          ctx.fillStyle = 'rgba(250,204,21,1)';
          ctx.beginPath();
          ctx.arc(endX, top, 3.5, 0, Math.PI * 2);
          ctx.fill();
        };
        if (fadeIn > 1e-6) drawFade(x0, secToX(clip.startSec + fadeIn));
        if (fadeOut > 1e-6) drawFade(x1, secToX(clipEnd(clip) - fadeOut));
      }
    }
  }, [track, pxPerSec, scrollSec, viewportWidth, laneHeight, selection, isMidi, waveFull]);

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
            <Circle size={11} fill="currentColor" />
          </button>
          <button className="mini" title="Delete track (undoable)" onClick={() => onDeleteTrack(track.id)}>
            <Trash2 size={13} />
          </button>
          {!IS_MOBILE && track.clips.length > 0 && (
            <button
              className="mini"
              title="Convert this track's audio to MIDI"
              disabled={midiBusy}
              onClick={() => onTranscribe(track.id)}
            >
              <Music4 size={13} />
            </button>
          )}
        </div>
        {/* Combined fader: the volume slider overlaid on the track's VU meter. */}
        <div
          className="lane-fader"
          title={`Volume ${(track.volume * 100).toFixed(0)}% · track level`}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="lane-vu">
            <div ref={vuRef} className="lane-vu-fill" />
          </div>
          <input
            className="lane-fader-input"
            type="range"
            min={0}
            max={1.5}
            step={0.01}
            value={track.volume}
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
          // On mobile, take full control of touch (pan + pinch-zoom) so the
          // browser doesn't hijack the gestures; desktop keeps default behavior.
          style={{ width: viewportWidth, height: laneHeight, touchAction: IS_MOBILE ? 'none' : undefined }}
          onPointerDown={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onPointerDown(e, track.id, e.clientX - rect.left, e.clientY - rect.top);
          }}
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            e.currentTarget.style.cursor = laneCursorAt(e.clientX - rect.left, e.clientY - rect.top);
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
        {/* View toggles are desktop-only; on mobile spectrum stays on and the
            waveform stays simplified (the state defaults). */}
        {!isMidi && !IS_MOBILE && (
          <div className="lane-view-toggles" onPointerDown={(e) => e.stopPropagation()}>
            <button
              className={`view-toggle${spectrumOn ? ' on' : ''}`}
              title={`Spectrum analyzer: ${spectrumOn ? 'on' : 'off'}`}
              onClick={() => setSpectrumOn((v) => !v)}
            >
              <AudioLines size={12} />
            </button>
            <button
              className={`view-toggle${waveFull ? ' on' : ''}`}
              title={`Waveform: ${waveFull ? 'full detail' : 'simplified'}`}
              onClick={() => setWaveFull((v) => !v)}
            >
              <AudioWaveform size={12} />
            </button>
          </div>
        )}
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
              <Eraser size={13} /> Clean…
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
