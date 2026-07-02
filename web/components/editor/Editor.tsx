'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clipEnd,
  cloneProject,
  makeAudioBuffer,
  totalDuration,
  uid,
  EMPTY_SELECTION,
  type Clip,
  type EditorProject,
  type EditorTrack,
  type Selection,
} from '@/lib/editor/model';
import { saveArrangement } from '@/lib/editor/persist';
import {
  copyRange,
  cutRange,
  deleteSelection,
  moveClip,
  paste,
  splitAt,
  trimClipEdge,
  type Clipboard,
} from '@/lib/editor/edits';
import { History } from '@/lib/editor/history';
import { EditorEngine } from '@/lib/editor/engine';
import { InputController } from '@/lib/editor/record';
import { Metronome } from '@/lib/editor/metronome';
import { detectChords, detectTempo, type ChordSegment } from '@/lib/editor/analyze';
import {
  listDevices,
  requestPermission,
  supportsOutputSelection,
  type DeviceLists,
} from '@/lib/editor/devices';
import { downloadBlob, encodeMp3, encodeWav, renderProject, renderTrack } from '@/lib/editor/export';
import { transcribeAudioBuffer } from '@/lib/editor/transcribe';
import { notesToSmf } from '@/lib/editor/midi';
import { cleanNotes, toMonophonic } from '@/lib/editor/midiClean';
import { getInstrument } from '@/lib/editor/instruments';
import { computeMusicStats, type MusicStats } from '@/lib/editor/musicStats';
import StatsPanel from './StatsPanel';
import Toolbar from './Toolbar';
import RecordBar from './RecordBar';
import ChordStrip from './ChordStrip';
import Ruler from './Ruler';
import TimelineTrack, { LANE_HEIGHT, SIDEBAR_WIDTH } from './TimelineTrack';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const EDGE_PX = 6;

function fmtTime(s: number): string {
  if (!isFinite(s)) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
function safeName(t: string): string {
  return t.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'mix';
}

type DragState =
  | { mode: 'range'; anchorSec: number; anchorTrackIdx: number; hitClipId: string | null }
  | {
      mode: 'move' | 'trim-start' | 'trim-end';
      clipId: string;
      base: EditorProject;
      startClientX: number;
      origStart: number;
    };

export default function Editor({
  initialProject,
  title,
  backendUrl,
  onSaved,
  onDirtyChange,
}: {
  initialProject: EditorProject;
  title: string;
  backendUrl?: string;
  onSaved?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [engine, setEngine] = useState<EditorEngine | null>(null);
  const [project, setProject] = useState<EditorProject>(() => initialProject);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [dirty, setDirty] = useState(false);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [pxPerSec, setPxPerSec] = useState(20);
  const [scrollSec, setScrollSec] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const [laneHeight, setLaneHeight] = useState(LANE_HEIGHT);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_WIDTH);
  const viewportWidth = Math.max(0, containerWidth - sidebarWidth);
  const [playing, setPlaying] = useState(false);
  const [, setTimeSec] = useState(0);
  const [hasClipboard, setHasClipboard] = useState(false);
  const [exporting, setExporting] = useState<null | 'wav' | 'mp3'>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportParams, setExportParams] = useState({
    format: 'wav' as 'wav' | 'mp3',
    bitrate: 192,
  });

  const [devices, setDevices] = useState<DeviceLists>({ inputs: [], outputs: [] });
  const [devicesReady, setDevicesReady] = useState(false);
  const [inputId, setInputId] = useState('');
  const [outputId, setOutputId] = useState('');
  const [monitor, setMonitor] = useState(false);
  const [recording, setRecording] = useState(false);

  const [metroOn, setMetroOn] = useState(false);
  const [bpm, setBpm] = useState(120);
  const [rate, setRate] = useState(1);
  const [keepPitch, setKeepPitch] = useState(false);
  const [pitchBusy, setPitchBusy] = useState(false);
  const [stretchProg, setStretchProg] = useState<{ done: number; total: number } | null>(null);
  const [chords, setChords] = useState<ChordSegment[]>([]);
  const [analyzing, setAnalyzing] = useState<null | 'tempo' | 'chords' | 'midi' | 'stats'>(null);
  const [stats, setStats] = useState<MusicStats | null>(null);
  const [midiProgress, setMidiProgress] = useState<{ name: string; percent: number } | null>(null);
  const [cleanTrack, setCleanTrack] = useState<{ id: string; name: string } | null>(null);
  const [cleanParams, setCleanParams] = useState({
    minDurMs: 70,
    minVel: 8,
    mergeGapMs: 40,
    monophonic: false,
    keep: 'low' as 'low' | 'high',
  });
  const [transcribeTrack, setTranscribeTrack] = useState<{ id: string; name: string } | null>(null);
  const [transcribeParams, setTranscribeParams] = useState({
    sensitivity: 'balanced' as 'clean' | 'balanced' | 'detailed',
    minNoteLenMs: 130,
    range: 'full' as 'full' | 'bass' | 'lead',
    monophonic: false,
    keep: 'low' as 'low' | 'high',
  });
  const [menu, setMenu] = useState<{ x: number; y: number; trackId: string } | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);

  const history = useRef(new History()).current;
  const [, forceHistory] = useState(0);
  const inputRef = useRef<InputController | null>(null);
  const metroRef = useRef<Metronome | null>(null);
  const clipboardRef = useRef<Clipboard | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const recordStartRef = useRef(0);
  const recordTargetRef = useRef<string | null>(null);
  const tapsRef = useRef<number[]>([]);
  const selectedTrackRef = useRef<string | null>(selectedTrackId);
  selectedTrackRef.current = selectedTrackId;
  const metroOnRef = useRef(metroOn);
  const bpmRef = useRef(bpm);
  const rateRef = useRef(rate);
  const keepPitchRef = useRef(keepPitch);
  const monitorRef = useRef(monitor);

  const timelineRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef(false);

  // Refs mirroring state for use inside window listeners.
  const projectRef = useRef(project);
  const selectionRef = useRef(selection);
  const pxRef = useRef(pxPerSec);
  const scrollRef = useRef(scrollSec);
  const engineRef = useRef<EditorEngine | null>(null);
  const laneHeightRef = useRef(laneHeight);
  const sidebarWidthRef = useRef(sidebarWidth);
  projectRef.current = project;
  selectionRef.current = selection;
  pxRef.current = pxPerSec;
  scrollRef.current = scrollSec;
  engineRef.current = engine;
  metroOnRef.current = metroOn;
  bpmRef.current = bpm;
  rateRef.current = rate;
  keepPitchRef.current = keepPitch;
  monitorRef.current = monitor;
  laneHeightRef.current = laneHeight;
  sidebarWidthRef.current = sidebarWidth;

  /* ---------- engine lifecycle (StrictMode-safe) ---------- */
  useEffect(() => {
    const eng = new EditorEngine(projectRef.current);
    inputRef.current = new InputController(eng);
    metroRef.current = new Metronome(eng.ctx, eng.ctx.destination);
    eng.onMidiLoaded = () => {
      forceHistory((n) => n + 1);
      // seamlessly reschedule from the current position so the newly-loaded
      // instrument takes over without stopping playback.
      if (eng.isPlaying) eng.seek(eng.currentTime());
    };
    eng.onStretchProgress = (done, total) => setStretchProg({ done, total });
    eng.onStretchReady = () => {
      // pitch-preserved buffers are ready — reschedule so playback swaps from
      // the pitch-shift fallback to the time-stretched audio without stopping.
      setPitchBusy(false);
      setStretchProg(null);
      if (eng.isPlaying) eng.seek(eng.currentTime());
    };
    // Match a freshly-created engine to the current speed settings.
    eng.setRate(rateRef.current);
    eng.setKeepPitch(keepPitchRef.current);
    for (const t of projectRef.current.tracks) {
      if (t.midi) eng.ensureInstrument(t.id, t.instrument);
    }
    setEngine(eng);
    setPlaying(false);
    return () => {
      inputRef.current?.close();
      inputRef.current = null;
      metroRef.current?.stop();
      metroRef.current = null;
      setEngine(null);
      void eng.close();
    };
  }, [initialProject]);

  // Warn before closing the tab if there are unsaved edits.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // Report dirty state up so the shell can confirm before replacing the project.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Keep metronome settings in sync.
  useEffect(() => {
    if (metroRef.current) {
      metroRef.current.enabled = metroOn;
      metroRef.current.bpm = bpm;
    }
    if (!metroOn) metroRef.current?.stop();
  }, [metroOn, bpm]);

  /* ---------- viewport measure + fit ---------- */
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!fitRef.current && viewportWidth > 0) {
      const d = totalDuration(projectRef.current) || 1;
      setPxPerSec(clamp((viewportWidth / d) * 0.98, 2, 400));
      fitRef.current = true;
    }
  }, [viewportWidth]);

  /* ---------- clock + playhead ---------- */
  useEffect(() => {
    if (!engine) return;
    let raf = 0;
    const tick = () => {
      const t = engine.currentTime();
      if (playheadRef.current) {
        const x = sidebarWidthRef.current + (t - scrollRef.current) * pxRef.current;
        playheadRef.current.style.left = `${x}px`;
        playheadRef.current.style.display = x >= sidebarWidthRef.current ? 'block' : 'none';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const id = setInterval(() => {
      setTimeSec(engine.currentTime());
      if (engine.isPlaying && engine.currentTime() >= engine.duration) {
        engine.pause();
        setPlaying(false);
      }
    }, 150);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(id);
    };
  }, [engine]);

  /* ---------- wheel zoom/pan ---------- */
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left - sidebarWidthRef.current;
      if (e.ctrlKey || e.metaKey) {
        const anchorSec = scrollRef.current + x / pxRef.current;
        const nextPx = clamp(pxRef.current * (e.deltaY < 0 ? 1.15 : 0.87), 2, 500);
        setPxPerSec(nextPx);
        setScrollSec(Math.max(0, anchorSec - x / nextPx));
      } else {
        const delta = (e.deltaX !== 0 ? e.deltaX : e.deltaY) / pxRef.current;
        setScrollSec((s) => Math.max(0, s + delta));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /* ---------- edit commit + history ---------- */
  const commit = useCallback(
    (next: EditorProject) => {
      history.push(projectRef.current);
      forceHistory((n) => n + 1);
      projectRef.current = next;
      setProject(next);
      engineRef.current?.setProject(next);
      setSaveState('idle');
      setDirty(true);
    },
    [history],
  );

  const effSelection = useCallback((): Selection => {
    const sel = selectionRef.current;
    if (sel.endSec - sel.startSec > 1e-6 && sel.trackIds.length) return sel;
    if (sel.clipIds.length) {
      let start = Infinity;
      let end = 0;
      const tracks = new Set<string>();
      for (const t of projectRef.current.tracks) {
        for (const c of t.clips) {
          if (sel.clipIds.includes(c.id)) {
            start = Math.min(start, c.startSec);
            end = Math.max(end, clipEnd(c));
            tracks.add(t.id);
          }
        }
      }
      if (end > start) {
        return { startSec: start, endSec: end, trackIds: [...tracks], clipIds: sel.clipIds };
      }
    }
    return sel;
  }, []);

  const playheadSec = () => engineRef.current?.currentTime() ?? 0;

  const doSplit = useCallback(() => {
    const t = playheadSec();
    const ids = selectionRef.current.trackIds.length
      ? selectionRef.current.trackIds
      : projectRef.current.tracks.map((tr) => tr.id);
    commit(splitAt(projectRef.current, t, ids));
  }, [commit]);

  const doCopy = useCallback(() => {
    const cb = copyRange(projectRef.current, effSelection());
    clipboardRef.current = cb;
    setHasClipboard(!!cb);
  }, [effSelection]);

  const doCut = useCallback(() => {
    const { project: next, clipboard } = cutRange(projectRef.current, effSelection());
    clipboardRef.current = clipboard;
    setHasClipboard(!!clipboard);
    commit(next);
  }, [commit, effSelection]);

  const doPaste = useCallback(() => {
    if (!clipboardRef.current) return;
    commit(paste(projectRef.current, clipboardRef.current, playheadSec()));
  }, [commit]);

  const doDelete = useCallback(() => {
    commit(deleteSelection(projectRef.current, effSelection()));
    setSelection(EMPTY_SELECTION);
  }, [commit, effSelection]);

  const doUndo = useCallback(() => {
    const prev = history.undo(projectRef.current);
    if (prev) {
      projectRef.current = prev;
      setProject(prev);
      engineRef.current?.setProject(prev);
      forceHistory((n) => n + 1);
      setDirty(true);
    }
  }, [history]);
  const doRedo = useCallback(() => {
    const next = history.redo(projectRef.current);
    if (next) {
      projectRef.current = next;
      setProject(next);
      engineRef.current?.setProject(next);
      forceHistory((n) => n + 1);
      setDirty(true);
    }
  }, [history]);

  const zoomBy = (factor: number) => {
    const centerSec = scrollRef.current + viewportWidth / 2 / pxRef.current;
    const nextPx = clamp(pxRef.current * factor, 2, 500);
    setPxPerSec(nextPx);
    setScrollSec(Math.max(0, centerSec - viewportWidth / 2 / nextPx));
  };

  /** Fit the whole arrangement (begin → end of the last clip) into view. */
  const fitView = useCallback(() => {
    const d = totalDuration(projectRef.current) || 1;
    if (viewportWidth > 0) {
      setPxPerSec(clamp((viewportWidth / d) * 0.98, 2, 500));
      setScrollSec(0);
    }
  }, [viewportWidth]);

  const saveProject = async () => {
    if (!backendUrl) return;
    setSaveState('saving');
    try {
      await saveArrangement(backendUrl, projectRef.current, title);
      setSaveState('saved');
      setDirty(false);
      onSaved?.();
    } catch {
      setSaveState('error');
    }
  };

  /* ---------- keyboard shortcuts ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? doRedo() : doUndo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        doRedo();
      } else if (mod && e.key.toLowerCase() === 'x') {
        e.preventDefault();
        doCut();
      } else if (mod && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        doCopy();
      } else if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        doPaste();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const sel = selectionRef.current;
        const hasClipOrRange =
          sel.clipIds.length > 0 || (sel.endSec - sel.startSec > 1e-6 && sel.trackIds.length > 0);
        if (!hasClipOrRange && selectedTrackRef.current) deleteTrack(selectedTrackRef.current);
        else doDelete();
      } else if (e.key.toLowerCase() === 's' && !mod) {
        e.preventDefault();
        doSplit();
      } else if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doCut, doCopy, doPaste, doDelete, doSplit, doUndo, doRedo]);

  /* ---------- transport ---------- */
  const startMetro = (fromSec: number) => {
    const m = metroRef.current;
    if (m && metroOnRef.current) {
      m.enabled = true;
      m.bpm = bpmRef.current;
      m.start(fromSec, rateRef.current);
    }
  };
  const stopMetro = () => metroRef.current?.stop();

  const togglePlay = async () => {
    const eng = engineRef.current;
    if (!eng) return;
    if (eng.isPlaying) {
      eng.pause();
      stopMetro();
      setPlaying(false);
    } else {
      await eng.play();
      startMetro(eng.currentTime());
      setPlaying(true);
    }
  };

  const seekTo = (sec: number) => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.seek(Math.max(0, sec));
    if (eng.isPlaying) {
      stopMetro();
      startMetro(eng.currentTime());
    }
    setTimeSec(sec);
  };

  const changeRate = (r: number) => {
    rateRef.current = r;
    setRate(r);
    const eng = engineRef.current;
    if (!eng) return;
    eng.setRate(r);
    if (eng.isPlaying) {
      seekTo(eng.currentTime());
      if (keepPitch && r !== 1) setPitchBusy(true);
    } else if (keepPitch && r !== 1) {
      setPitchBusy(true);
      void eng.prepareStretch();
    }
  };

  const toggleKeepPitch = (on: boolean) => {
    setKeepPitch(on);
    const eng = engineRef.current;
    if (!eng) return;
    eng.setKeepPitch(on);
    if (!on) {
      setPitchBusy(false);
      setStretchProg(null);
      if (eng.isPlaying) seekTo(eng.currentTime()); // back to plain speed change
      return;
    }
    if (rate === 1) return;
    if (eng.isPlaying) {
      setPitchBusy(true);
      seekTo(eng.currentTime()); // plays pitch-shifted until buffers build, then swaps
    } else {
      setPitchBusy(true);
      void eng.prepareStretch();
    }
  };

  /* ---------- lane pointer interaction ---------- */
  const trackIdxFromY = (clientY: number): number => {
    const rows = rowsRef.current;
    if (!rows) return 0;
    const top = rows.getBoundingClientRect().top;
    return clamp(Math.floor((clientY - top) / laneHeightRef.current), 0, projectRef.current.tracks.length - 1);
  };

  // All clips overlapping localX on a track, in draw order (bottom → top).
  const clipsAt = (trackId: string, localX: number) => {
    const track = projectRef.current.tracks.find((t) => t.id === trackId);
    const secToX = (s: number) => (s - scrollRef.current) * pxRef.current;
    const res: { clip: Clip; edge: 'start' | 'end' | null }[] = [];
    for (const c of track?.clips ?? []) {
      const x0 = secToX(c.startSec);
      const x1 = secToX(clipEnd(c));
      if (localX >= x0 && localX <= x1) {
        let edge: 'start' | 'end' | null = null;
        if (Math.abs(localX - x0) <= EDGE_PX) edge = 'start';
        else if (Math.abs(localX - x1) <= EDGE_PX) edge = 'end';
        res.push({ clip: c, edge });
      }
    }
    return res;
  };
  const hitClipAt = (trackId: string, localX: number) => {
    const all = clipsAt(trackId, localX);
    const top = all[all.length - 1];
    return { hit: top?.clip ?? null, edge: top?.edge ?? null, all };
  };

  // LMB = select region (click a clip to select it; repeated clicks cycle through
  // overlapping clips) / trim clip edge. MMB (middle) = move clip. RMB = context menu.
  const onLanePointerDown = (e: React.PointerEvent, trackId: string, localX: number) => {
    if (e.button === 2) return;
    setMenu(null);
    setSelectedTrackId(null);
    const track = projectRef.current.tracks.find((t) => t.id === trackId);
    if (!track) return;
    const sec = Math.max(0, scrollRef.current + localX / pxRef.current);
    const { hit, edge, all } = hitClipAt(trackId, localX);

    if (e.button === 1) {
      // move: prefer the already-selected overlapping clip, else the topmost
      const selId = selectionRef.current.clipIds[0];
      const chosen = all.find((a) => a.clip.id === selId)?.clip ?? hit;
      if (!chosen) return;
      e.preventDefault();
      setSelection({ startSec: 0, endSec: 0, trackIds: [trackId], clipIds: [chosen.id] });
      dragRef.current = {
        mode: 'move',
        clipId: chosen.id,
        base: projectRef.current,
        startClientX: e.clientX,
        origStart: chosen.startSec,
      };
    } else if (e.button === 0 && hit && edge) {
      setSelection({ startSec: 0, endSec: 0, trackIds: [trackId], clipIds: [hit.id] });
      dragRef.current = {
        mode: edge === 'start' ? 'trim-start' : 'trim-end',
        clipId: hit.id,
        base: projectRef.current,
        startClientX: e.clientX,
        origStart: hit.startSec,
      };
    } else if (e.button === 0) {
      // click over overlapping clips cycles which one gets selected
      const ids = all.map((a) => a.clip.id);
      let target: string | null = null;
      if (ids.length) {
        const cur = selectionRef.current.clipIds[0];
        const pos = cur ? ids.indexOf(cur) : -1;
        target = pos >= 0 ? ids[(pos + 1) % ids.length]! : ids[ids.length - 1]!;
      }
      const anchorIdx = trackIdxFromY(e.clientY);
      dragRef.current = { mode: 'range', anchorSec: sec, anchorTrackIdx: anchorIdx, hitClipId: target };
      setSelection({ startSec: sec, endSec: sec, trackIds: [trackId], clipIds: [] });
    } else {
      return;
    }

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const rect = timelineRef.current!.getBoundingClientRect();
      const lx = ev.clientX - rect.left - sidebarWidthRef.current;
      const curSec = Math.max(0, scrollRef.current + lx / pxRef.current);
      if (d.mode === 'range') {
        const i0 = Math.min(d.anchorTrackIdx, trackIdxFromY(ev.clientY));
        const i1 = Math.max(d.anchorTrackIdx, trackIdxFromY(ev.clientY));
        const ids = projectRef.current.tracks.slice(i0, i1 + 1).map((t) => t.id);
        setSelection({
          startSec: Math.min(d.anchorSec, curSec),
          endSec: Math.max(d.anchorSec, curSec),
          trackIds: ids,
          clipIds: [],
        });
      } else if (d.mode === 'move') {
        const dxSec = (ev.clientX - d.startClientX) / pxRef.current;
        const targetTrack = projectRef.current.tracks[trackIdxFromY(ev.clientY)]!;
        const next = moveClip(d.base, d.clipId, d.origStart + dxSec, targetTrack.id);
        projectRef.current = next;
        setProject(next);
        engineRef.current?.setProject(next);
      } else {
        const dxSec = (ev.clientX - d.startClientX) / pxRef.current;
        const next = trimClipEdge(d.base, d.clipId, d.mode === 'trim-start' ? 'start' : 'end', dxSec);
        projectRef.current = next;
        setProject(next);
        engineRef.current?.setProject(next);
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      if (d.mode === 'range') {
        const s = selectionRef.current;
        // a click (no drag) over a clip selects that clip
        if (s.endSec - s.startSec < 2 / pxRef.current && d.hitClipId) {
          setSelection({ startSec: 0, endSec: 0, trackIds: [trackId], clipIds: [d.hitClipId] });
        }
      } else {
        history.push(d.base);
        forceHistory((n) => n + 1);
        setDirty(true);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // RMB on a lane: select the clip under the cursor (unless a range is active) and open the menu.
  const onLaneContextMenu = (e: React.MouseEvent, trackId: string, localX: number) => {
    e.preventDefault();
    const sel = selectionRef.current;
    const overRange =
      sel.endSec - sel.startSec > 1e-6 && sel.trackIds.includes(trackId);
    if (!overRange) {
      const { hit } = hitClipAt(trackId, localX);
      if (hit) setSelection({ startSec: 0, endSec: 0, trackIds: [trackId], clipIds: [hit.id] });
    }
    setMenu({ x: e.clientX, y: e.clientY, trackId });
  };

  // Drag on the ruler/header selects a region across ALL tracks; a click seeks.
  const onRulerPointerDown = (localX: number, clientX: number) => {
    setMenu(null);
    const startSec = Math.max(0, scrollRef.current + localX / pxRef.current);
    const allIds = projectRef.current.tracks.map((t) => t.id);
    let dragged = false;
    setSelection({ startSec, endSec: startSec, trackIds: allIds, clipIds: [] });
    const onMove = (ev: PointerEvent) => {
      const rect = timelineRef.current!.getBoundingClientRect();
      const lx = ev.clientX - rect.left - sidebarWidthRef.current;
      const cur = Math.max(0, scrollRef.current + lx / pxRef.current);
      if (Math.abs(ev.clientX - clientX) > 3) dragged = true;
      setSelection({
        startSec: Math.min(startSec, cur),
        endSec: Math.max(startSec, cur),
        trackIds: allIds,
        clipIds: [],
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!dragged) seekTo(startSec);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const renameTrack = (id: string, name: string) => {
    const next = cloneProject(projectRef.current);
    const t = next.tracks.find((x) => x.id === id);
    if (t) t.name = name.trim() || t.name;
    commit(next);
  };

  const selectTrack = (id: string) => {
    setSelectedTrackId(id);
    setSelection(EMPTY_SELECTION);
  };

  const deleteTrack = (id: string) => {
    setMenu(null);
    if (!window.confirm('Delete this track?')) return;
    const next = cloneProject(projectRef.current);
    next.tracks = next.tracks.filter((t) => t.id !== id);
    commit(next);
    if (selectedTrackRef.current === id) setSelectedTrackId(null);
  };

  // Drag the sidebar's right edge to resize all track control panels.
  const startSidebarResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const onMove = (ev: PointerEvent) => {
      const rect = timelineRef.current!.getBoundingClientRect();
      setSidebarWidth(clamp(ev.clientX - rect.left, 110, 420));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Drag a track's bottom edge to resize all lane heights.
  const startLaneResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = laneHeightRef.current;
    const onMove = (ev: PointerEvent) => {
      setLaneHeight(clamp(startH + (ev.clientY - startY), 48, 400));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /* ---------- track controls ---------- */
  const mutateTrack = (id: string, fn: (t: EditorProject['tracks'][number]) => void) => {
    const next = cloneProject(projectRef.current);
    const t = next.tracks.find((x) => x.id === id);
    if (t) fn(t);
    projectRef.current = next;
    setProject(next);
    engineRef.current?.setProject(next);
    setDirty(true);
  };

  /* ---------- devices + recording ---------- */
  const enableDevices = async () => {
    const stream = await requestPermission();
    stream?.getTracks().forEach((t) => t.stop());
    const lists = await listDevices();
    setDevices(lists);
    setDevicesReady(true);
    const inId = lists.inputs[0]?.deviceId ?? '';
    if (inId) setInputId(inId);
    if (lists.outputs[0]) setOutputId(lists.outputs[0].deviceId);
    try {
      await inputRef.current?.open(inId || null, monitorRef.current);
    } catch {
      /* mic open failed */
    }
  };

  // Always show the Audio I/O controls: enable devices once the engine is ready
  // (monitor stays off by default, so nothing is routed until you turn it on).
  const autoEnabledRef = useRef(false);
  useEffect(() => {
    if (!engine || autoEnabledRef.current) return;
    autoEnabledRef.current = true;
    void enableDevices().catch(() => {
      autoEnabledRef.current = false; // allow a retry (e.g. after a denied prompt)
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  const chooseInput = async (id: string) => {
    setInputId(id);
    try {
      await inputRef.current?.open(id, monitorRef.current);
    } catch {
      /* ignore */
    }
  };

  const chooseOutput = async (id: string) => {
    setOutputId(id);
    await engineRef.current?.setOutputDevice(id);
  };

  const setMonitorState = (v: boolean) => {
    setMonitor(v);
    inputRef.current?.setMonitor(v);
  };

  const getInputLevel = useCallback(() => inputRef.current?.getLevel() ?? 0, []);

  const armedTrack = () => projectRef.current.tracks.find((t) => t.armed);

  const addTrack = () => {
    const next = cloneProject(projectRef.current);
    // The new track becomes the sole record-armed track (disarm the others).
    for (const t of next.tracks) t.armed = false;
    next.tracks.push({
      id: uid(),
      name: `Track ${next.tracks.length + 1}`,
      color: '#eab308',
      clips: [],
      muted: false,
      soloed: false,
      volume: 1,
      armed: true,
    });
    commit(next);
  };

  const toggleRecord = async () => {
    const input = inputRef.current;
    const eng = engineRef.current;
    if (!input || !eng) return;

    if (input.isCapturing) {
      const result = input.stopCapture();
      eng.pause();
      stopMetro();
      setPlaying(false);
      setRecording(false);
      if (result) {
        const clip: Clip = {
          id: uid(),
          buffer: makeAudioBuffer(result.channels, result.sampleRate),
          startSec: recordStartRef.current,
          offsetSec: 0,
          durationSec: result.channels[0]!.length / result.sampleRate,
        };
        const next = cloneProject(projectRef.current);
        const target =
          next.tracks.find((t) => t.id === recordTargetRef.current) ??
          next.tracks[next.tracks.length - 1];
        target?.clips.push(clip);
        commit(next);
      }
      return;
    }

    if (!input.isOpen) {
      try {
        await input.open(inputId || null, monitorRef.current);
      } catch {
        return;
      }
    }
    // choose (or create + arm) the target track
    let targetId = armedTrack()?.id;
    if (!targetId) {
      const next = cloneProject(projectRef.current);
      const nt = {
        id: uid(),
        name: `Take ${next.tracks.length + 1}`,
        color: '#eab308',
        clips: [],
        muted: false,
        soloed: false,
        volume: 1,
        armed: true,
      };
      next.tracks.push(nt);
      commit(next);
      targetId = nt.id;
    }
    recordTargetRef.current = targetId;
    // Recording must run at normal speed — a time-scaled transport would make
    // the take a different length/speed than the tracks it plays against.
    // Pause FIRST (so the position is captured at the current speed), then force
    // 1× and (re)start, otherwise an already-playing track keeps running at its
    // old speed while the recording is captured in real time → they desync.
    if (eng.isPlaying) {
      eng.pause();
      stopMetro();
    }
    // Record at normal speed and keep it there — the take is captured in real
    // time, so playing the project back at any other speed would make it (and
    // every track) run fast/slow. Recording resets the transport to 1×.
    if (rateRef.current !== 1) {
      rateRef.current = 1;
      setRate(1);
      eng.setRate(1);
    }
    recordStartRef.current = eng.currentTime();
    input.startCapture();
    await eng.play();
    startMetro(eng.currentTime());
    setPlaying(true);
    setRecording(true);
  };

  /** Live recording waveform data for the track currently being recorded into. */
  const getRecordPeaks = (trackId: string) => {
    if (!recording || recordTargetRef.current !== trackId) return null;
    const info = inputRef.current?.livePeaks();
    if (!info) return null;
    return { peaks: info.peaks, startSec: recordStartRef.current, bucketSec: info.bucketSec };
  };

  /** Tap this in rhythm to set the tempo from the average tap interval. */
  const tapTempo = () => {
    const now = performance.now();
    const taps = tapsRef.current;
    if (taps.length && now - taps[taps.length - 1]! > 2000) taps.length = 0; // reset after a pause
    taps.push(now);
    if (taps.length > 8) taps.shift();
    if (taps.length >= 2) {
      let sum = 0;
      for (let i = 1; i < taps.length; i++) sum += taps[i]! - taps[i - 1]!;
      const b = Math.round(60000 / (sum / (taps.length - 1)));
      if (b >= 40 && b <= 260) setBpm(b);
    }
  };

  const doDetectTempo = async () => {
    setAnalyzing('tempo');
    try {
      const buf = await renderProject(projectRef.current);
      setBpm(detectTempo(buf));
    } finally {
      setAnalyzing(null);
    }
  };

  const doDetectChords = async () => {
    setAnalyzing('chords');
    try {
      const buf = await renderProject(projectRef.current);
      setChords(detectChords(buf));
    } finally {
      setAnalyzing(null);
    }
  };

  const doStats = async () => {
    setAnalyzing('stats');
    try {
      setStats(await computeMusicStats(projectRef.current));
    } finally {
      setAnalyzing(null);
    }
  };

  /* ---------- audio → MIDI ---------- */
  const doTranscribe = (trackId: string) => {
    const track = projectRef.current.tracks.find((t) => t.id === trackId);
    if (!track || track.clips.length === 0) {
      window.alert('That track has no audio to transcribe.');
      return;
    }
    setTranscribeTrack({ id: trackId, name: track.name });
  };

  const runTranscribe = async () => {
    const tt = transcribeTrack;
    if (!tt) return;
    setTranscribeTrack(null);
    const p = projectRef.current;
    const track = p.tracks.find((t) => t.id === tt.id);
    if (!track) return;
    const tp = transcribeParams;
    const SENS = {
      clean: { onsetThreshold: 0.6, frameThreshold: 0.4, minConfidence: 0.25 },
      balanced: { onsetThreshold: 0.5, frameThreshold: 0.3, minConfidence: 0.15 },
      detailed: { onsetThreshold: 0.4, frameThreshold: 0.25, minConfidence: 0.08 },
    } as const;
    const RANGE = {
      full: { minFreqHz: null, maxFreqHz: null },
      bass: { minFreqHz: 40, maxFreqHz: 500 },
      lead: { minFreqHz: 120, maxFreqHz: 2200 },
    } as const;
    setAnalyzing('midi');
    setMidiProgress({ name: track.name, percent: 0 });
    try {
      const buf = await renderTrack(p, tt.id);
      if (!buf) return;
      const notes = await transcribeAudioBuffer(
        buf,
        (pr) => setMidiProgress({ name: track.name, percent: Math.round(pr * 100) }),
        {
          ...SENS[tp.sensitivity],
          ...RANGE[tp.range],
          minNoteLenMs: tp.minNoteLenMs,
          monophonic: tp.monophonic ? tp.keep : false,
        },
      );
      const next = cloneProject(projectRef.current);
      const srcIdx = next.tracks.findIndex((x) => x.id === tt.id);
      const midiTrack: EditorTrack = {
        id: uid(),
        name: `${track.name} MIDI`,
        color: '#22d3ee',
        clips: [],
        muted: false,
        soloed: false,
        volume: 1,
        armed: false,
        midi: notes,
      };
      next.tracks.splice(srcIdx >= 0 ? srcIdx + 1 : next.tracks.length, 0, midiTrack);
      commit(next);
      engineRef.current?.ensureInstrument(midiTrack.id, midiTrack.instrument);
    } catch (e) {
      window.alert('Transcription failed: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setAnalyzing(null);
      setMidiProgress(null);
    }
  };

  const exportMidi = (track: EditorTrack) => {
    if (!track.midi?.length) return;
    const bytes = notesToSmf(track.midi, {
      name: track.name,
      bpm,
      program: getInstrument(track.instrument).gm,
    });
    downloadBlob(
      new Blob([bytes as BlobPart], { type: 'audio/midi' }),
      `${safeName(title)}_${safeName(track.name)}.mid`,
    );
  };

  const setInstrument = (id: string, inst: string) => {
    mutateTrack(id, (t) => (t.instrument = inst));
    engineRef.current?.ensureInstrument(id, inst);
  };

  const openClean = (id: string) => {
    const t = projectRef.current.tracks.find((x) => x.id === id);
    if (t?.midi) setCleanTrack({ id, name: t.name });
  };

  const applyClean = () => {
    const ct = cleanTrack;
    if (!ct) return;
    const next = cloneProject(projectRef.current);
    const t = next.tracks.find((x) => x.id === ct.id);
    if (t?.midi) {
      const opts = {
        minDur: cleanParams.minDurMs / 1000,
        minVel: cleanParams.minVel,
        mergeGap: cleanParams.mergeGapMs / 1000,
      };
      t.midi = cleanParams.monophonic
        ? toMonophonic(t.midi, cleanParams.keep, opts)
        : cleanNotes(t.midi, opts);
    }
    commit(next);
    setCleanTrack(null);
  };

  const doExport = async (kind: 'wav' | 'mp3', bitrate = 192) => {
    setExportOpen(false);
    setExporting(kind);
    try {
      const buffer = await renderProject(projectRef.current);
      const blob = kind === 'wav' ? encodeWav(buffer) : encodeMp3(buffer, bitrate);
      downloadBlob(blob, `${safeName(title)}_edit.${kind}`);
    } finally {
      setExporting(null);
    }
  };

  const hasSelection =
    (selection.endSec - selection.startSec > 1e-6 && selection.trackIds.length > 0) ||
    selection.clipIds.length > 0;
  const duration = totalDuration(project);
  const viewportSec = viewportWidth / pxPerSec || 0;
  const maxScroll = Math.max(0, duration - viewportSec * 0.5);

  return (
    <div className="panel editor">
      {/* Transport bar: jump-to-start, play, record, time, metronome, and file actions */}
      <div className="editor-transport">
        <div className="tp-group">
          <button className="btn secondary tp-btn" onClick={() => seekTo(0)} title="To start">
            ⏮
          </button>
          <button
            className="btn tp-btn"
            onClick={togglePlay}
            disabled={!engine}
            title="Play / Pause (Space)"
          >
            {playing ? '⏸' : '▶'}
          </button>
          <button
            className={`btn tp-btn rec${recording ? ' on' : ''}`}
            onClick={toggleRecord}
            title={recording ? 'Stop recording' : 'Record (into armed track or a new take)'}
          >
            {recording ? '⏹' : '●'}
          </button>
          <span className="time">
            {fmtTime(engineRef.current?.currentTime() ?? 0)} / {fmtTime(duration)}
          </span>
        </div>

        <div className="tp-group">
          <label className="dev checkbox" title="Metronome">
            <input type="checkbox" checked={metroOn} onChange={(e) => setMetroOn(e.target.checked)} />
            🎵
          </label>
          <div className="metro-group">
            <button className="btn ghost nudge" onClick={() => setBpm(Math.max(40, bpm - 1))} title="Slower">
              −
            </button>
            <input
              type="number"
              min={40}
              max={260}
              value={bpm}
              onChange={(e) => setBpm(Math.max(40, Math.min(260, Number(e.target.value) || 0)))}
              title="BPM"
            />
            <button className="btn ghost nudge" onClick={() => setBpm(Math.min(260, bpm + 1))} title="Faster">
              ＋
            </button>
            <button className="btn secondary" onClick={tapTempo} title="Tap in rhythm to set the tempo">
              👆 Tap
            </button>
            <span className="hint">{bpm} BPM</span>
          </div>
          <span className="sep" />
          <label className="dev" title="Playback speed">
            ⏩
            <select value={rate} onChange={(e) => changeRate(Number(e.target.value))}>
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </select>
          </label>
          <label className="keep-pitch" title="Preserve pitch when changing speed (time-stretch)">
            <input
              type="checkbox"
              checked={keepPitch}
              onChange={(e) => toggleKeepPitch(e.target.checked)}
            />
            Keep pitch
            {pitchBusy && rate !== 1 && keepPitch && (
              <span className="hint">
                {' '}
                building{stretchProg ? ` ${stretchProg.done}/${stretchProg.total}` : ''}…
              </span>
            )}
          </label>
        </div>

        <div className="tp-group tp-right">
          <button
            className="btn"
            disabled={exporting !== null}
            onClick={() => setExportOpen(true)}
            title="Export the mix as an audio file"
          >
            {exporting ? 'Exporting…' : '⬇ Export'}
          </button>
          {backendUrl && (
            <button
              className="btn secondary"
              onClick={saveProject}
              disabled={saveState === 'saving'}
              title="Save the editable project to the library"
            >
              {saveState === 'saving'
                ? 'Saving…'
                : saveState === 'saved'
                  ? '✓ Saved'
                  : saveState === 'error'
                    ? '⚠ Retry save'
                    : '💾 Save'}
            </button>
          )}
        </div>
      </div>

      <Toolbar
        onCut={doCut}
        onCopy={doCopy}
        onPaste={doPaste}
        onSplit={doSplit}
        onDelete={doDelete}
        onUndo={doUndo}
        onRedo={doRedo}
        canUndo={history.canUndo()}
        canRedo={history.canRedo()}
        canPaste={hasClipboard}
        hasSelection={hasSelection}
        onZoomIn={() => zoomBy(1.4)}
        onZoomOut={() => zoomBy(0.71)}
        onFit={fitView}
        onAddTrack={addTrack}
        onDetectTempo={doDetectTempo}
        onDetectChords={doDetectChords}
        onStats={doStats}
        analyzing={analyzing}
        chordCount={chords.length}
      />

      <RecordBar
        inputs={devices.inputs}
        outputs={devices.outputs}
        inputId={inputId}
        outputId={outputId}
        onInput={chooseInput}
        onOutput={chooseOutput}
        monitor={monitor}
        onMonitor={setMonitorState}
        onEnableDevices={enableDevices}
        devicesReady={devicesReady}
        outputSupported={supportsOutputSelection()}
        getLevel={getInputLevel}
      />

      <div className="editor-timeline" ref={timelineRef}>
        <Ruler
          pxPerSec={pxPerSec}
          scrollSec={scrollSec}
          viewportWidth={viewportWidth}
          sidebarWidth={sidebarWidth}
          onPointerDown={onRulerPointerDown}
        />
        {chords.length > 0 && (
          <ChordStrip
            chords={chords}
            pxPerSec={pxPerSec}
            scrollSec={scrollSec}
            viewportWidth={viewportWidth}
            sidebarWidth={sidebarWidth}
          />
        )}
        <div className="lanes" ref={rowsRef}>
          {project.tracks.map((t) => (
            <TimelineTrack
              key={t.id}
              track={t}
              pxPerSec={pxPerSec}
              scrollSec={scrollSec}
              viewportWidth={viewportWidth}
              laneHeight={laneHeight}
              sidebarWidth={sidebarWidth}
              selection={selection}
              armed={t.armed}
              selected={selectedTrackId === t.id}
              playing={playing}
              analyser={t.midi ? null : engine?.getAnalyser(t.id) ?? null}
              onPointerDown={onLanePointerDown}
              onContextMenu={onLaneContextMenu}
              onSelectTrack={selectTrack}
              onDeleteTrack={deleteTrack}
              onTranscribe={doTranscribe}
              midiBusy={analyzing === 'midi'}
              midiLoading={!!t.midi && !!engine && !engine.isMidiReady(t.id, t.instrument)}
              onSetInstrument={setInstrument}
              onOpenClean={openClean}
              onRename={renameTrack}
              onStartSidebarResize={startSidebarResize}
              onStartLaneResize={startLaneResize}
              onSetMuted={(id, v) => mutateTrack(id, (tr) => (tr.muted = v))}
              onSetSoloed={(id, v) => mutateTrack(id, (tr) => (tr.soloed = v))}
              onSetVolume={(id, v) => mutateTrack(id, (tr) => (tr.volume = v))}
              onToggleArm={(id) => mutateTrack(id, (tr) => (tr.armed = !tr.armed))}
              recording={recording && recordTargetRef.current === t.id}
              getRecordPeaks={() => getRecordPeaks(t.id)}
            />
          ))}
        </div>
        <div ref={playheadRef} className="editor-playhead" />
      </div>

      <input
        className="hscroll"
        type="range"
        min={0}
        max={Math.max(0.001, maxScroll)}
        step={0.01}
        value={Math.min(scrollSec, maxScroll)}
        onChange={(e) => setScrollSec(Number(e.target.value))}
      />

      {stats && <StatsPanel stats={stats} onClose={() => setStats(null)} />}

      {midiProgress && (
        <div className="midi-overlay">
          <div className="midi-progress-card">
            <div className="phase-label">
              <strong>🎹 Converting “{midiProgress.name}” to MIDI…</strong>
              <span className="engine">{midiProgress.percent}%</span>
            </div>
            <div className="bar">
              <span style={{ width: `${Math.max(4, midiProgress.percent)}%` }} />
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              {midiProgress.percent < 3 ? 'Loading the AI model…' : 'Analyzing audio…'} Keep this tab
              open.
            </p>
          </div>
        </div>
      )}

      {cleanTrack && (
        <div className="modal-backdrop">
          <div className="modal" style={{ maxWidth: 420 }} onPointerDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>Clean MIDI — {cleanTrack.name}</span>
              <button className="modal-close" onClick={() => setCleanTrack(null)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="panel">
                <div className="field">
                  <label>Minimum note length: {cleanParams.minDurMs} ms</label>
                  <input
                    type="range"
                    min={0}
                    max={300}
                    step={5}
                    value={cleanParams.minDurMs}
                    onChange={(e) => setCleanParams({ ...cleanParams, minDurMs: Number(e.target.value) })}
                  />
                </div>
                <div className="field">
                  <label>Minimum velocity: {cleanParams.minVel}</label>
                  <input
                    type="range"
                    min={0}
                    max={64}
                    step={1}
                    value={cleanParams.minVel}
                    onChange={(e) => setCleanParams({ ...cleanParams, minVel: Number(e.target.value) })}
                  />
                </div>
                <div className="field">
                  <label>Merge same-pitch gap: {cleanParams.mergeGapMs} ms</label>
                  <input
                    type="range"
                    min={0}
                    max={150}
                    step={5}
                    value={cleanParams.mergeGapMs}
                    onChange={(e) => setCleanParams({ ...cleanParams, mergeGapMs: Number(e.target.value) })}
                  />
                </div>
                <div className="field">
                  <label className="dev checkbox">
                    <input
                      type="checkbox"
                      checked={cleanParams.monophonic}
                      onChange={(e) => setCleanParams({ ...cleanParams, monophonic: e.target.checked })}
                    />
                    Monophonic — reduce to a single line (good for bass)
                  </label>
                </div>
                {cleanParams.monophonic && (
                  <div className="field">
                    <label>When notes overlap, keep:</label>
                    <div className="seg">
                      <button
                        className={cleanParams.keep === 'low' ? 'active' : ''}
                        onClick={() => setCleanParams({ ...cleanParams, keep: 'low' })}
                      >
                        Lowest (bass)
                      </button>
                      <button
                        className={cleanParams.keep === 'high' ? 'active' : ''}
                        onClick={() => setCleanParams({ ...cleanParams, keep: 'high' })}
                      >
                        Highest
                      </button>
                    </div>
                  </div>
                )}
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn" onClick={applyClean}>
                    Apply
                  </button>
                  <button className="btn ghost" onClick={() => setCleanTrack(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {transcribeTrack && (
        <div className="modal-backdrop">
          <div className="modal" style={{ maxWidth: 440 }} onPointerDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>Audio → MIDI — {transcribeTrack.name}</span>
              <button className="modal-close" onClick={() => setTranscribeTrack(null)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="panel">
                <p className="hint" style={{ marginTop: 0 }}>
                  The AI model runs in your browser. Fewer, cleaner notes come from a lower
                  sensitivity, a matching pitch range, and monophonic for single-line parts.
                </p>
                <div className="field">
                  <label>Sensitivity</label>
                  <div className="seg">
                    {(['clean', 'balanced', 'detailed'] as const).map((s) => (
                      <button
                        key={s}
                        className={transcribeParams.sensitivity === s ? 'active' : ''}
                        onClick={() => setTranscribeParams({ ...transcribeParams, sensitivity: s })}
                      >
                        {s === 'clean' ? 'Cleaner' : s === 'balanced' ? 'Balanced' : 'Detailed'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <label>Pitch range</label>
                  <div className="seg">
                    {(['full', 'bass', 'lead'] as const).map((r) => (
                      <button
                        key={r}
                        className={transcribeParams.range === r ? 'active' : ''}
                        onClick={() => setTranscribeParams({ ...transcribeParams, range: r })}
                      >
                        {r === 'full' ? 'Full' : r === 'bass' ? 'Bass' : 'Lead / Vocal'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <label>Minimum note length: {transcribeParams.minNoteLenMs} ms</label>
                  <input
                    type="range"
                    min={40}
                    max={400}
                    step={10}
                    value={transcribeParams.minNoteLenMs}
                    onChange={(e) =>
                      setTranscribeParams({ ...transcribeParams, minNoteLenMs: Number(e.target.value) })
                    }
                  />
                </div>
                <div className="field">
                  <label className="dev checkbox">
                    <input
                      type="checkbox"
                      checked={transcribeParams.monophonic}
                      onChange={(e) =>
                        setTranscribeParams({ ...transcribeParams, monophonic: e.target.checked })
                      }
                    />
                    Monophonic — one note at a time (best for bass / vocal / lead)
                  </label>
                </div>
                {transcribeParams.monophonic && (
                  <div className="field">
                    <label>When notes overlap, keep:</label>
                    <div className="seg">
                      <button
                        className={transcribeParams.keep === 'low' ? 'active' : ''}
                        onClick={() => setTranscribeParams({ ...transcribeParams, keep: 'low' })}
                      >
                        Lowest (bass)
                      </button>
                      <button
                        className={transcribeParams.keep === 'high' ? 'active' : ''}
                        onClick={() => setTranscribeParams({ ...transcribeParams, keep: 'high' })}
                      >
                        Highest
                      </button>
                    </div>
                  </div>
                )}
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn" onClick={runTranscribe}>
                    Convert
                  </button>
                  <button className="btn ghost" onClick={() => setTranscribeTrack(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {exportOpen && (
        <div className="modal-backdrop">
          <div className="modal" style={{ maxWidth: 400 }} onPointerDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>Export mix</span>
              <button className="modal-close" onClick={() => setExportOpen(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="panel">
                <div className="field">
                  <label>Format</label>
                  <div className="seg">
                    <button
                      className={exportParams.format === 'wav' ? 'active' : ''}
                      onClick={() => setExportParams({ ...exportParams, format: 'wav' })}
                    >
                      WAV (lossless)
                    </button>
                    <button
                      className={exportParams.format === 'mp3' ? 'active' : ''}
                      onClick={() => setExportParams({ ...exportParams, format: 'mp3' })}
                    >
                      MP3
                    </button>
                  </div>
                </div>
                {exportParams.format === 'mp3' && (
                  <div className="field">
                    <label>Quality</label>
                    <div className="seg">
                      {[128, 192, 320].map((b) => (
                        <button
                          key={b}
                          className={exportParams.bitrate === b ? 'active' : ''}
                          onClick={() => setExportParams({ ...exportParams, bitrate: b })}
                        >
                          {b} kbps
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="row" style={{ marginTop: 12 }}>
                  <button
                    className="btn"
                    disabled={exporting !== null}
                    onClick={() => doExport(exportParams.format, exportParams.bitrate)}
                  >
                    {exporting ? 'Exporting…' : '⬇ Export'}
                  </button>
                  <button className="btn ghost" onClick={() => setExportOpen(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {menu && (
        <>
          <div
            className="ctx-backdrop"
            onPointerDown={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
            <button onClick={() => { doCut(); setMenu(null); }} disabled={!hasSelection}>
              ✂ Cut
            </button>
            <button onClick={() => { doCopy(); setMenu(null); }} disabled={!hasSelection}>
              ⧉ Copy
            </button>
            <button onClick={() => { doPaste(); setMenu(null); }} disabled={!hasClipboard}>
              📋 Paste
            </button>
            <button onClick={() => { doSplit(); setMenu(null); }}>⎘ Split at playhead</button>
            <div className="ctx-sep" />
            <button onClick={() => { doDelete(); setMenu(null); }} disabled={!hasSelection}>
              🗑 Delete selection
            </button>
            <button onClick={() => deleteTrack(menu.trackId)}>🗑 Delete track</button>
            {(() => {
              const mt = project.tracks.find((t) => t.id === menu.trackId);
              return mt?.midi?.length ? (
                <>
                  <div className="ctx-sep" />
                  <button
                    onClick={() => {
                      exportMidi(mt);
                      setMenu(null);
                    }}
                  >
                    ⬇ Export MIDI (.mid)
                  </button>
                </>
              ) : null;
            })()}
          </div>
        </>
      )}
    </div>
  );
}
