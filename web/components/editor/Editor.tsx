'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Circle,
  ClipboardPaste,
  Copy,
  Download,
  FolderInput,
  Gauge,
  Hand,
  ListPlus,
  Magnet,
  MoreHorizontal,
  Music,
  Music4,
  Play,
  Pause,
  Save,
  Scissors,
  SkipBack,
  SkipForward,
  Split,
  Square,
  Trash2,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
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
import { store } from '@/lib/store';
import {
  copyClips,
  copyRange,
  cutRange,
  deleteSelection,
  moveClips,
  paste,
  setClipFade,
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
import BeatStrip from './BeatStrip';
import Ruler from './Ruler';
import TimelineTrack, {
  FADE_BAND_PX,
  FADE_GRAB_PX,
  LANE_HEIGHT,
  SIDEBAR_WIDTH,
} from './TimelineTrack';
import Overview from './Overview';
import ToolsPanel from './tools/ToolsPanel';
import {
  loadTools,
  loadToolsOpen,
  saveTools,
  saveToolsOpen,
  type ToolInstance,
  type ToolKind,
} from '@/lib/editor/tools';
import { IS_MOBILE } from '@/lib/env';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const EDGE_PX = 6;

// Mobile: fixed, compact lane + side-header sizes (never resized by dragging —
// the handles are hidden on mobile). Kept in sync with the compact header CSS.
const MOBILE_LANE_HEIGHT = 64;
const MOBILE_SIDEBAR_WIDTH = 132;

/** Force a window-wide cursor for the active clip drag (or clear it when null). */
function setDragCursor(mode: DragState['mode'] | null) {
  const cls = document.body.classList;
  cls.remove('drag-move', 'drag-trim');
  if (mode === 'move') cls.add('drag-move');
  else if (mode && mode !== 'range') cls.add('drag-trim'); // trim + fade drag horizontally
}

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
      // Move one clip or a whole multi-selection together.
      mode: 'move';
      clipId: string;
      base: EditorProject;
      startClientX: number;
      /** track index of the grabbed clip at drag start (for the track delta). */
      origTrackIdx: number;
      /** all clip ids to move together (the grabbed clip, or the selection). */
      groupIds: string[];
    }
  | {
      mode: 'trim-start' | 'trim-end';
      clipId: string;
      base: EditorProject;
      startClientX: number;
      origStart: number;
    }
  | {
      mode: 'fade-in' | 'fade-out';
      clipId: string;
      base: EditorProject;
      startClientX: number;
      origFade: number;
    };

/** Default fade length (seconds) applied when inserting a fade from the menu. */
const DEFAULT_FADE_SEC = 1;

export default function Editor({
  initialProject,
  title,
  onSaved,
  onDirtyChange,
  onImport,
  pendingImport,
}: {
  initialProject: EditorProject;
  title: string;
  onSaved?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Open the import window (wired by the shell). Absent → no Import button. */
  onImport?: () => void;
  /** Tracks to append to the live project; `token` changes per import request. */
  pendingImport?: { tracks: EditorTrack[]; token: number } | null;
}) {
  const [engine, setEngine] = useState<EditorEngine | null>(null);
  const [project, setProject] = useState<EditorProject>(() => initialProject);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [dirty, setDirty] = useState(false);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [pxPerSec, setPxPerSec] = useState(20);
  const [scrollSec, setScrollSec] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  // Mobile lanes are compact and fixed: start from the mobile sizes and never
  // mutate them (the drag-resize handles are hidden on mobile — see globals.css).
  const [laneHeight, setLaneHeight] = useState(IS_MOBILE ? MOBILE_LANE_HEIGHT : LANE_HEIGHT);
  const [sidebarWidth, setSidebarWidth] = useState(
    IS_MOBILE ? MOBILE_SIDEBAR_WIDTH : SIDEBAR_WIDTH,
  );
  const viewportWidth = Math.max(0, containerWidth - sidebarWidth);
  const [playing, setPlaying] = useState(false);
  const [, setTimeSec] = useState(0);
  const [hasClipboard, setHasClipboard] = useState(false);
  const [exporting, setExporting] = useState<null | 'wav' | 'mp3'>(null);
  const [exportOpen, setExportOpen] = useState(false);
  // Mobile: the transport row keeps only play/new-track/save; everything else
  // lives in a collapsible "More…" row toggled by this flag.
  const [moreOpen, setMoreOpen] = useState(false);
  const [exportScope, setExportScope] = useState<'mix' | 'track'>('mix');
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
  const [bpmSnap, setBpmSnap] = useState(false);
  const [bpmOffsetSec, setBpmOffsetSec] = useState(0);
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

  // Output-audio visualizers in the right sidebar (view-only, persisted to localStorage).
  const [toolsOpen, setToolsOpen] = useState(() => loadToolsOpen());
  const [tools, setTools] = useState<ToolInstance[]>(() => loadTools());
  useEffect(() => saveTools(tools), [tools]);
  useEffect(() => saveToolsOpen(toolsOpen), [toolsOpen]);
  const addTool = (kind: ToolKind) =>
    setTools((ts) => [...ts, { id: uid(), kind, source: 'out' }]);
  const removeTool = (id: string) => setTools((ts) => ts.filter((t) => t.id !== id));
  const setToolSource = (id: string, source: string) =>
    setTools((ts) => ts.map((t) => (t.id === id ? { ...t, source } : t)));

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
  const bpmSnapRef = useRef(bpmSnap);
  const bpmOffsetSecRef = useRef(bpmOffsetSec);
  const rateRef = useRef(rate);
  const keepPitchRef = useRef(keepPitch);
  const monitorRef = useRef(monitor);

  const timelineRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef(false);
  // Mobile: true while a two-finger pinch-zoom is in progress, so the one-finger
  // pan drag stands down (see the wheel/gesture effect and onLanePointerDown).
  const pinchingRef = useRef(false);

  // Refs mirroring state for use inside window listeners.
  const projectRef = useRef(project);
  const selectionRef = useRef(selection);
  const pxRef = useRef(pxPerSec);
  const scrollRef = useRef(scrollSec);
  const engineRef = useRef<EditorEngine | null>(null);
  const laneHeightRef = useRef(laneHeight);
  const sidebarWidthRef = useRef(sidebarWidth);
  const viewportWidthRef = useRef(0);
  projectRef.current = project;
  selectionRef.current = selection;
  pxRef.current = pxPerSec;
  scrollRef.current = scrollSec;
  viewportWidthRef.current = viewportWidth;
  engineRef.current = engine;
  metroOnRef.current = metroOn;
  bpmRef.current = bpm;
  // Beat-snap is desktop-only; force it off on mobile so drag/trim/seek never snap.
  bpmSnapRef.current = bpmSnap && !IS_MOBILE;
  bpmOffsetSecRef.current = bpmOffsetSec;
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
  // Opening/closing the tools sidebar resizes the timeline (a sibling flex item),
  // but that doesn't reliably trigger its ResizeObserver — re-measure explicitly
  // so the lanes reflow and nothing (e.g. the per-track toggles) gets clipped.
  useEffect(() => {
    const el = timelineRef.current;
    if (el) setContainerWidth(el.clientWidth);
  }, [toolsOpen]);
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
      // Auto-follow: once the playhead passes 3/4 of the visible window, scroll
      // the view gradually so it stays pinned there and the track keeps moving
      // under it. (If it falls behind the view — e.g. a rewind — snap it back.)
      if (engine.isPlaying && viewportWidthRef.current > 0 && pxRef.current > 0) {
        const viewportSec = viewportWidthRef.current / pxRef.current;
        const anchor = viewportSec * 0.75;
        let next = scrollRef.current;
        if (t - scrollRef.current > anchor) next = t - anchor;
        else if (t < scrollRef.current) next = t;
        next = Math.max(0, next);
        // Update only on a visible (≥ ~0.5 px) change to avoid needless redraws.
        if (Math.abs(next - scrollRef.current) * pxRef.current >= 0.5) {
          scrollRef.current = next; // apply now so this frame draws in place
          setScrollSec(next);
        }
      }
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

  /* ---------- mobile two-finger pinch-to-zoom ---------- */
  useEffect(() => {
    if (!IS_MOBILE) return;
    const el = timelineRef.current;
    if (!el) return;
    const pts = new Map<number, { x: number; y: number }>();
    let startDist = 0;
    let startPx = 0;
    let anchorSec = 0;
    let midLocalX = 0;
    const dist = () => {
      const v = [...pts.values()];
      return Math.hypot(v[0]!.x - v[1]!.x, v[0]!.y - v[1]!.y);
    };
    const onDown = (e: PointerEvent) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        pinchingRef.current = true;
        dragRef.current = null; // cancel any in-progress one-finger pan/trim
        const v = [...pts.values()];
        const rect = el.getBoundingClientRect();
        midLocalX = (v[0]!.x + v[1]!.x) / 2 - rect.left - sidebarWidthRef.current;
        anchorSec = scrollRef.current + midLocalX / pxRef.current;
        startDist = dist();
        startPx = pxRef.current;
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!pinchingRef.current || pts.size !== 2 || startDist === 0) return;
      const nextPx = clamp(startPx * (dist() / startDist), 2, 500);
      setPxPerSec(nextPx);
      setScrollSec(Math.max(0, anchorSec - midLocalX / nextPx));
    };
    const onUp = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinchingRef.current = false;
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
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

  // Append imported tracks to the live project when the shell requests it (an
  // "Add to open project" import). The token guards against re-applying on a
  // StrictMode double-invoke or a remount that still sees the last request.
  const lastImportToken = useRef(pendingImport?.token ?? 0);
  useEffect(() => {
    const token = pendingImport?.token ?? 0;
    if (!pendingImport || token === lastImportToken.current) return;
    lastImportToken.current = token;
    if (!pendingImport.tracks.length) return;
    const next = cloneProject(projectRef.current);
    next.tracks.push(...pendingImport.tracks);
    commit(next);
  }, [pendingImport, commit]);

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
    const sel = selectionRef.current;
    const ids = sel.trackIds.length
      ? sel.trackIds
      : projectRef.current.tracks.map((tr) => tr.id);
    if (sel.endSec - sel.startSec > 1e-6) {
      // A region is selected: carve it out into its own new clip by splitting at
      // both edges, then select the carved clips so the new block is ready to use.
      const next = splitAt(splitAt(projectRef.current, sel.startSec, ids), sel.endSec, ids);
      commit(next);
      const carved: string[] = [];
      for (const track of next.tracks) {
        if (!ids.includes(track.id)) continue;
        for (const c of track.clips) {
          if (c.startSec >= sel.startSec - 1e-6 && clipEnd(c) <= sel.endSec + 1e-6) {
            carved.push(c.id);
          }
        }
      }
      setSelection({ startSec: 0, endSec: 0, trackIds: ids, clipIds: carved });
    } else {
      // No region: split every clip crossing the playhead.
      commit(splitAt(projectRef.current, playheadSec(), ids));
    }
  }, [commit]);

  // Insert (or reset to default) a fade-in/out on the selected clips; the fade
  // line is then draggable on the timeline to fine-tune its length.
  const insertFade = useCallback(
    (edge: 'in' | 'out') => {
      const ids = selectionRef.current.clipIds;
      if (!ids.length) return;
      commit(setClipFade(projectRef.current, ids, edge, DEFAULT_FADE_SEC));
    },
    [commit],
  );

  const clearFades = useCallback(() => {
    const ids = selectionRef.current.clipIds;
    if (!ids.length) return;
    commit(setClipFade(setClipFade(projectRef.current, ids, 'in', 0), ids, 'out', 0));
  }, [commit]);

  const doCopy = useCallback(() => {
    const sel = selectionRef.current;
    // Selected blocks copy exactly those clips; otherwise copy the time-range slab.
    const cb =
      sel.clipIds.length > 0
        ? copyClips(projectRef.current, sel.clipIds)
        : copyRange(projectRef.current, effSelection());
    clipboardRef.current = cb;
    setHasClipboard(!!cb);
  }, [effSelection]);

  const doCut = useCallback(() => {
    const sel = selectionRef.current;
    if (sel.clipIds.length > 0) {
      const cb = copyClips(projectRef.current, sel.clipIds);
      clipboardRef.current = cb;
      setHasClipboard(!!cb);
      commit(deleteSelection(projectRef.current, sel));
      setSelection(EMPTY_SELECTION);
      return;
    }
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
    setSaveState('saving');
    try {
      await store.saveArrangement(projectRef.current, title);
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
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && bpmSnapRef.current) {
        // With snap on, step the cursor one beat left/right.
        e.preventDefault();
        const beat = 60 / bpmRef.current;
        const off = bpmOffsetSecRef.current;
        const cur = engineRef.current?.currentTime() ?? 0;
        const idx = (cur - off) / beat;
        const nextIdx =
          e.key === 'ArrowRight' ? Math.floor(idx + 1e-6) + 1 : Math.ceil(idx - 1e-6) - 1;
        seekTo(Math.max(0, off + nextIdx * beat));
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

  // Round a time to the nearest BPM beat, aligned to the snap offset.
  const snapToBeat = (sec: number): number => {
    const beat = 60 / bpmRef.current;
    const off = bpmOffsetSecRef.current;
    return Math.max(0, Math.round((sec - off) / beat) * beat + off);
  };

  const seekTo = (sec: number) => {
    const eng = engineRef.current;
    if (!eng) return;
    const target = Math.max(0, sec);
    eng.seek(target);
    if (eng.isPlaying) {
      stopMetro();
      startMetro(eng.currentTime());
    }
    // Keep the playhead on screen: if the target is off the visible window
    // (e.g. rewinding to the start while zoomed in), scroll the view to it.
    const viewportSec = pxRef.current > 0 ? viewportWidthRef.current / pxRef.current : 0;
    if (viewportSec > 0 && (target < scrollRef.current || target > scrollRef.current + viewportSec)) {
      const next = Math.max(0, target - viewportSec * 0.1);
      scrollRef.current = next;
      setScrollSec(next);
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

  // A fade handle (the dot at a fade's end) under the pointer, if any. Only the
  // top band responds so it doesn't fight edge-trimming lower in the clip.
  const fadeHandleAt = (
    trackId: string,
    localX: number,
    localY: number,
  ): { clip: Clip; edge: 'in' | 'out' } | null => {
    if (localY > FADE_BAND_PX) return null;
    const track = projectRef.current.tracks.find((t) => t.id === trackId);
    if (!track) return null;
    const secToX = (s: number) => (s - scrollRef.current) * pxRef.current;
    for (let i = track.clips.length - 1; i >= 0; i--) {
      const c = track.clips[i]!;
      const x0 = secToX(c.startSec);
      const x1 = secToX(clipEnd(c));
      if (localX < x0 || localX > x1) continue;
      const fi = c.fadeInSec ?? 0;
      const fo = c.fadeOutSec ?? 0;
      if (fi > 0 && Math.abs(localX - secToX(c.startSec + fi)) <= FADE_GRAB_PX) {
        return { clip: c, edge: 'in' };
      }
      if (fo > 0 && Math.abs(localX - secToX(clipEnd(c) - fo)) <= FADE_GRAB_PX) {
        return { clip: c, edge: 'out' };
      }
      break; // only the topmost clip at this x can own a handle
    }
    return null;
  };

  // LMB = select only: a simple click (no drag) selects the clip under the cursor
  // (Shift/Ctrl-click toggles it in a multi-selection; repeated clicks cycle
  // overlaps); a drag selects a time region. LMB on a clip edge = trim.
  // MMB (middle) = move a clip / the whole selection. RMB = context menu.
  const onLanePointerDown = (
    e: React.PointerEvent,
    trackId: string,
    localX: number,
    localY: number,
  ) => {
    if (e.button === 2) return;
    setMenu(null);
    setSelectedTrackId(null);
    const track = projectRef.current.tracks.find((t) => t.id === trackId);
    if (!track) return;
    const sec = Math.max(0, scrollRef.current + localX / pxRef.current);
    const { hit, edge, all } = hitClipAt(trackId, localX);
    const fade = e.button === 0 ? fadeHandleAt(trackId, localX, localY) : null;

    if (e.button === 0 && fade) {
      // Drag a fade handle to adjust its length (checked before trim so the
      // handle wins in the top corner where they overlap).
      setSelection({ startSec: 0, endSec: 0, trackIds: [trackId], clipIds: [fade.clip.id] });
      dragRef.current = {
        mode: fade.edge === 'in' ? 'fade-in' : 'fade-out',
        clipId: fade.clip.id,
        base: projectRef.current,
        startClientX: e.clientX,
        origFade: (fade.edge === 'in' ? fade.clip.fadeInSec : fade.clip.fadeOutSec) ?? 0,
      };
    } else if (e.button === 1) {
      // middle-drag = move; if the grabbed clip is in a multi-selection, move the group.
      const selIds = selectionRef.current.clipIds;
      const chosen = all.find((a) => selIds.includes(a.clip.id))?.clip ?? hit;
      if (!chosen) return;
      e.preventDefault();
      const inMulti = selIds.length > 1 && selIds.includes(chosen.id);
      if (!inMulti) setSelection({ startSec: 0, endSec: 0, trackIds: [trackId], clipIds: [chosen.id] });
      dragRef.current = {
        mode: 'move',
        clipId: chosen.id,
        base: projectRef.current,
        startClientX: e.clientX,
        origTrackIdx: projectRef.current.tracks.findIndex((t) => t.id === trackId),
        groupIds: inMulti ? selIds : [chosen.id],
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
    } else if (e.button === 0 && IS_MOBILE) {
      // Mobile one-finger gestures on a lane:
      //  - press-and-hold on a clip (~350 ms, held still) grabs it → the clip
      //    follows the finger (horizontal = time, vertical = track) until release;
      //  - dragging before the hold fires pans the timeline instead;
      //  - a tap selects the clip under the finger.
      // Two-finger pinch-zoom is handled separately and stands this down (pinchingRef).
      const anchorSec = sec;
      const startClientX = e.clientX;
      const startClientY = e.clientY;
      const startScrollTop = rowsRef.current?.scrollTop ?? 0;
      const tapId = hit?.id ?? null;
      let moved = false;
      let mode: 'idle' | 'pan' | 'move' = 'idle';
      let base = projectRef.current;
      let groupIds: string[] = [];
      let origTrackIdx = 0;

      // Long-press → enter clip-move mode (unless the finger already moved/pinched).
      const enterMove = () => {
        if (mode !== 'idle' || moved || pinchingRef.current || !hit) return;
        mode = 'move';
        base = projectRef.current;
        const selIds = selectionRef.current.clipIds;
        const inMulti = selIds.length > 1 && selIds.includes(hit.id);
        groupIds = inMulti ? selIds : [hit.id];
        origTrackIdx = projectRef.current.tracks.findIndex((t) => t.id === trackId);
        if (!inMulti) setSelection({ startSec: 0, endSec: 0, trackIds: [trackId], clipIds: [hit.id] });
        setDragCursor('move');
        navigator.vibrate?.(12); // haptic tick to signal "drag mode"
      };
      const holdTimer = hit ? window.setTimeout(enterMove, 350) : 0;

      const onMove = (ev: PointerEvent) => {
        if (pinchingRef.current) {
          moved = true;
          window.clearTimeout(holdTimer);
          return;
        }
        const dx = ev.clientX - startClientX;
        const dy = ev.clientY - startClientY;
        if (mode === 'move') {
          // Grabbed clip follows the finger.
          const dxSec = dx / pxRef.current;
          const deltaIdx = trackIdxFromY(ev.clientY) - origTrackIdx;
          const next = moveClips(base, groupIds, dxSec, deltaIdx);
          projectRef.current = next;
          setProject(next);
          engineRef.current?.setProject(next);
          return;
        }
        if (!moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
          moved = true;
          mode = 'pan'; // early movement = pan; cancel the pending hold
          window.clearTimeout(holdTimer);
        }
        if (mode === 'pan') {
          const rect = timelineRef.current!.getBoundingClientRect();
          const lx = ev.clientX - rect.left - sidebarWidthRef.current;
          setScrollSec(Math.max(0, anchorSec - lx / pxRef.current));
          if (rowsRef.current) rowsRef.current.scrollTop = startScrollTop - dy;
        }
      };
      const onUp = () => {
        window.clearTimeout(holdTimer);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setDragCursor(null);
        if (mode === 'move') {
          if (projectRef.current !== base) {
            history.push(base);
            forceHistory((n) => n + 1);
            setDirty(true);
          }
          return;
        }
        if (!moved && !pinchingRef.current) {
          if (tapId) setSelection({ startSec: 0, endSec: 0, trackIds: [trackId], clipIds: [tapId] });
          else setSelection(EMPTY_SELECTION);
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      return;
    } else if (e.button === 0) {
      // LMB only SELECTS (never moves — move is the middle button). Shift/Ctrl-click
      // toggles a block in the multi-selection; a plain click selects the block under
      // the cursor (cycling overlaps); a drag rubber-bands a region and selects the
      // whole blocks it touches.
      if ((e.shiftKey || e.ctrlKey || e.metaKey) && hit) {
        const set = new Set(selectionRef.current.clipIds);
        if (set.has(hit.id)) set.delete(hit.id);
        else set.add(hit.id);
        setSelection({ startSec: 0, endSec: 0, trackIds: [trackId], clipIds: [...set] });
        return;
      }
      // click over overlapping clips cycles which one gets selected (applied on up)
      const ids = all.map((a) => a.clip.id);
      let target: string | null = null;
      if (ids.length) {
        const cur = selectionRef.current.clipIds.length === 1 ? selectionRef.current.clipIds[0] : null;
        const pos = cur ? ids.indexOf(cur) : -1;
        target = pos >= 0 ? ids[(pos + 1) % ids.length]! : ids[ids.length - 1]!;
      }
      const anchorIdx = trackIdxFromY(e.clientY);
      dragRef.current = { mode: 'range', anchorSec: sec, anchorTrackIdx: anchorIdx, hitClipId: target };
      setSelection({ startSec: sec, endSec: sec, trackIds: [trackId], clipIds: [] });
    } else {
      return;
    }

    // Lock the cursor for the whole window during move/trim drags.
    setDragCursor(dragRef.current?.mode ?? null);

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
        let dxSec = (ev.clientX - d.startClientX) / pxRef.current;
        // Snap the grabbed clip's start to the beat grid (hold Alt to bypass).
        if (bpmSnapRef.current && !ev.altKey) {
          const clip = d.base.tracks.flatMap((t) => t.clips).find((c) => c.id === d.clipId);
          if (clip) dxSec = snapToBeat(clip.startSec + dxSec) - clip.startSec;
        }
        const deltaIdx = trackIdxFromY(ev.clientY) - d.origTrackIdx;
        const next = moveClips(d.base, d.groupIds, dxSec, deltaIdx);
        projectRef.current = next;
        setProject(next);
        engineRef.current?.setProject(next);
      } else if (d.mode === 'fade-in' || d.mode === 'fade-out') {
        // fade-in grows dragging right; fade-out grows dragging left
        const dxSec = (ev.clientX - d.startClientX) / pxRef.current;
        const delta = d.mode === 'fade-in' ? dxSec : -dxSec;
        const next = setClipFade(
          d.base,
          [d.clipId],
          d.mode === 'fade-in' ? 'in' : 'out',
          d.origFade + delta,
        );
        projectRef.current = next;
        setProject(next);
        engineRef.current?.setProject(next);
      } else {
        let dxSec = (ev.clientX - d.startClientX) / pxRef.current;
        // Snap the dragged edge to the beat grid (hold Alt to bypass).
        if (bpmSnapRef.current && !ev.altKey) {
          if (d.mode === 'trim-start') {
            dxSec = snapToBeat(d.origStart + dxSec) - d.origStart;
          } else {
            const clip = d.base.tracks.flatMap((t) => t.clips).find((c) => c.id === d.clipId);
            if (clip) {
              const origEnd = clipEnd(clip);
              dxSec = snapToBeat(origEnd + dxSec) - origEnd;
            }
          }
        }
        const next = trimClipEdge(d.base, d.clipId, d.mode === 'trim-start' ? 'start' : 'end', dxSec);
        projectRef.current = next;
        setProject(next);
        engineRef.current?.setProject(next);
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDragCursor(null);
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      if (d.mode === 'range') {
        const s = selectionRef.current;
        const dragged = s.endSec - s.startSec >= 2 / pxRef.current;
        if (!dragged) {
          // a simple click (no drag) selects the block under the cursor, else clears
          if (d.hitClipId) setSelection({ startSec: 0, endSec: 0, trackIds: [trackId], clipIds: [d.hitClipId] });
          else setSelection(EMPTY_SELECTION);
        }
        // a drag keeps the region (time-range) selection set during the move
      } else if (projectRef.current !== d.base) {
        // Only record history if the drag actually changed something (a mere
        // click on an edge/handle leaves projectRef untouched).
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
      // Keep the multi-selection if right-clicking one of its blocks (so menu
      // actions apply to the whole group); otherwise select just the hit clip.
      if (hit && !sel.clipIds.includes(hit.id)) {
        setSelection({ startSec: 0, endSec: 0, trackIds: [trackId], clipIds: [hit.id] });
      }
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
      const a = bpmSnapRef.current ? snapToBeat(startSec) : startSec;
      const b = bpmSnapRef.current ? snapToBeat(cur) : cur;
      setSelection({
        startSec: Math.min(a, b),
        endSec: Math.max(a, b),
        trackIds: allIds,
        clipIds: [],
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!dragged) seekTo(bpmSnapRef.current ? snapToBeat(startSec) : startSec);
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

  // Desktop: enable the Audio I/O devices once the engine is ready (monitor stays
  // off by default, so nothing is routed until you turn it on). On mobile we skip
  // this so the editor doesn't prompt for the mic on open — recording requests
  // permission on demand (see toggleRecord), and the mic lives in Options.
  const autoEnabledRef = useRef(false);
  useEffect(() => {
    if (IS_MOBILE || !engine || autoEnabledRef.current) return;
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

  // Resolve a tool's source to an AnalyserNode: Audio In, Audio Out (master), or a track.
  const analyserForSource = (source: string): AnalyserNode | null => {
    if (source === 'in') return inputRef.current?.getAnalyser() ?? null;
    if (source === 'out') return engine?.getMasterAnalyser() ?? null;
    return engine?.getAnalyser(source) ?? null;
  };

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

  // Render either the selected track (scope='track', when it has audio clips) or
  // the full mix, then encode + download. Falls back to the mix when the chosen
  // track has no audio (e.g. a MIDI-only track, which exports via "Export MIDI").
  const doExport = async (kind: 'wav' | 'mp3', bitrate = 192, scope: 'mix' | 'track' = 'mix') => {
    setExportOpen(false);
    setExporting(kind);
    try {
      const trackId = selectedTrackRef.current;
      const chosen =
        scope === 'track' && trackId
          ? projectRef.current.tracks.find((t) => t.id === trackId)
          : undefined;
      const audioTrack = chosen && chosen.clips.length > 0 ? chosen : undefined;
      const buffer = audioTrack
        ? await renderTrack(projectRef.current, audioTrack.id)
        : await renderProject(projectRef.current);
      if (!buffer) return;
      const blob = kind === 'wav' ? encodeWav(buffer) : encodeMp3(buffer, bitrate);
      const part = audioTrack ? safeName(audioTrack.name) : 'mix';
      downloadBlob(blob, `${safeName(title)}_${part}.${kind}`);
    } finally {
      setExporting(null);
    }
  };

  const hasSelection =
    (selection.endSec - selection.startSec > 1e-6 && selection.trackIds.length > 0) ||
    selection.clipIds.length > 0;
  // A track is selected AND holds audio clips → the Export dialog offers a
  // track-vs-mix choice (MIDI-only tracks are excluded; they export as MIDI).
  const selectedTrack =
    (selectedTrackId && project.tracks.find((t) => t.id === selectedTrackId)) || null;
  const canExportTrack = !!selectedTrack && selectedTrack.clips.length > 0;
  const duration = totalDuration(project);
  const viewportSec = viewportWidth / pxPerSec || 0;

  // Transport-bar pieces — shared markup, arranged differently per platform:
  // desktop lays them all inline; mobile keeps a compact primary row (transport +
  // New track + Save) and moves the rest into a collapsible "More…" row.
  const transportGroup = (
    <div className="tp-group">
      <button className="btn secondary tp-btn" onClick={() => seekTo(0)} title="To start">
        <SkipBack size={16} />
      </button>
      <button
        className="btn tp-btn"
        onClick={togglePlay}
        disabled={!engine}
        title="Play / Pause (Space)"
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <button
        className={`btn tp-btn rec${recording ? ' on' : ''}`}
        onClick={toggleRecord}
        title={recording ? 'Stop recording' : 'Record (into armed track or a new take)'}
      >
        {recording ? <Square size={13} fill="currentColor" /> : <Circle size={13} fill="currentColor" />}
      </button>
      <button
        className="btn secondary tp-btn"
        onClick={() => seekTo(duration)}
        disabled={!engine || duration <= 0}
        title="To end"
      >
        <SkipForward size={16} />
      </button>
      <span className="time">
        {fmtTime(engineRef.current?.currentTime() ?? 0)} / {fmtTime(duration)}
      </span>
    </div>
  );

  const metronomeGroup = (
    <div className="tp-group">
      <label className="dev checkbox" title="Metronome">
        <input type="checkbox" checked={metroOn} onChange={(e) => setMetroOn(e.target.checked)} />
        <Music size={15} />
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
          <Hand size={14} /> Tap
        </button>
        <span className="hint">{bpm} BPM</span>
      </div>
      {/* Beat-snap + playback-speed controls are desktop-only. */}
      {!IS_MOBILE && (
      <>
      <span className="sep" />
      <label className="dev checkbox" title="Snap ao BPM: gruda cursor e clipes nas batidas">
        <input type="checkbox" checked={bpmSnap} onChange={(e) => setBpmSnap(e.target.checked)} />
        <Magnet size={15} />
      </label>
      {bpmSnap && (
        <div className="metro-group">
          <button
            className="btn ghost nudge"
            onClick={() => setBpmOffsetSec((s) => Math.max(-2, s - 0.005))}
            title="Offset −5 ms"
          >
            −
          </button>
          <input
            type="number"
            min={-2000}
            max={2000}
            step={5}
            value={Math.round(bpmOffsetSec * 1000)}
            onChange={(e) =>
              setBpmOffsetSec(Math.max(-2, Math.min(2, (Number(e.target.value) || 0) / 1000)))
            }
            title="Offset dos pontos de snap (ms)"
          />
          <button
            className="btn ghost nudge"
            onClick={() => setBpmOffsetSec((s) => Math.min(2, s + 0.005))}
            title="Offset +5 ms"
          >
            ＋
          </button>
          <span className="hint">offset ms</span>
        </div>
      )}
      <span className="sep" />
      <label className="dev" title="Playback speed">
        <Gauge size={14} />
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
      </>
      )}
    </div>
  );

  const importBtn = onImport ? (
    <button
      className="btn secondary"
      onClick={onImport}
      title="Import audio — as a new project or added to this one"
    >
      <FolderInput size={15} /> Import…
    </button>
  ) : null;

  const exportBtn = (
    <button
      className="btn"
      disabled={exporting !== null}
      onClick={() => {
        setExportScope(canExportTrack ? 'track' : 'mix');
        setExportOpen(true);
      }}
      title="Export the selected track or the full mix as an audio file"
    >
      {exporting ? 'Exporting…' : <><Download size={15} /> Export</>}
    </button>
  );

  const saveBtn = (
    <button
      className="btn secondary"
      onClick={saveProject}
      disabled={saveState === 'saving'}
      title="Save the editable project to the library"
    >
      {saveState === 'saving' ? (
        'Saving…'
      ) : saveState === 'saved' ? (
        <>
          <Check size={14} /> Saved
        </>
      ) : saveState === 'error' ? (
        <>
          <AlertTriangle size={14} /> Retry save
        </>
      ) : (
        <>
          <Save size={15} /> Save
        </>
      )}
    </button>
  );

  const newTrackBtn = (
    <button className="btn secondary" onClick={addTrack} title="Add an empty track">
      <ListPlus size={15} /> Track
    </button>
  );

  const toolbarNode = (
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
      toolsOpen={toolsOpen}
      onToggleTools={() => setToolsOpen((v) => !v)}
      hideAddTrack={IS_MOBILE}
    />
  );

  return (
    <div className="panel editor">
      {/* Transport bar. Desktop lays every control inline; mobile keeps a compact
          primary row (transport + New track + Save) and tucks the rest into a
          collapsible "More…" row. */}
      {IS_MOBILE ? (
        <>
          <div className="editor-transport">
            {transportGroup}
            <div className="tp-group tp-right">
              {newTrackBtn}
              {saveBtn}
              <button
                className={`btn ghost tp-more${moreOpen ? ' active' : ''}`}
                onClick={() => setMoreOpen((v) => !v)}
                title={moreOpen ? 'Hide extra tools' : 'Show extra tools'}
              >
                <MoreHorizontal size={16} /> {moreOpen ? 'Less' : 'More'}
              </button>
            </div>
          </div>
          {moreOpen && (
            <div className="editor-more">
              {metronomeGroup}
              <div className="tp-group">
                {importBtn}
                {exportBtn}
              </div>
              {toolbarNode}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="editor-transport">
            {transportGroup}
            {metronomeGroup}
            <div className="tp-group tp-right">
              {importBtn}
              {exportBtn}
              {saveBtn}
            </div>
          </div>
          {toolbarNode}
        </>
      )}

      {/* Audio I/O bar is desktop-only; on mobile the mic lives in Options and
          recording requests permission on demand. */}
      {!IS_MOBILE && (
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
      )}

      <div className="editor-workspace">
      <div className="editor-timeline" ref={timelineRef}>
        <Ruler
          pxPerSec={pxPerSec}
          scrollSec={scrollSec}
          viewportWidth={viewportWidth}
          sidebarWidth={sidebarWidth}
          onPointerDown={onRulerPointerDown}
        />
        {!IS_MOBILE && bpmSnap && (
          <BeatStrip
            bpm={bpm}
            offsetSec={bpmOffsetSec}
            pxPerSec={pxPerSec}
            scrollSec={scrollSec}
            viewportWidth={viewportWidth}
            sidebarWidth={sidebarWidth}
          />
        )}
        {!IS_MOBILE && chords.length > 0 && (
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
        {!IS_MOBILE && toolsOpen && (
          <ToolsPanel
            items={tools}
            sources={[
              { value: 'in', label: 'Audio In' },
              { value: 'out', label: 'Audio Out' },
              ...project.tracks.map((t) => ({ value: t.id, label: t.name })),
            ]}
            getAnalyser={analyserForSource}
            playing={playing}
            onAdd={addTool}
            onRemove={removeTool}
            onSetSource={setToolSource}
            onClose={() => setToolsOpen(false)}
          />
        )}
      </div>

      {/* Overview minimap replaces the horizontal scrollbar — desktop only; on
          mobile the timeline is panned/zoomed by touch gestures instead. */}
      {!IS_MOBILE && (
        <Overview
          project={project}
          scrollSec={scrollSec}
          viewportSec={viewportSec}
          viewportWidth={viewportWidth}
          onScroll={setScrollSec}
          onZoom={setPxPerSec}
        />
      )}

      {!IS_MOBILE && stats && <StatsPanel stats={stats} onClose={() => setStats(null)} />}

      {midiProgress && (
        <div className="midi-overlay">
          <div className="midi-progress-card">
            <div className="phase-label">
              <strong className="mp-title">
                <Music4 size={16} /> Converting “{midiProgress.name}” to MIDI…
              </strong>
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
                <X size={16} />
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
                <X size={16} />
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
              <span>Export {exportScope === 'track' && canExportTrack ? 'track' : 'mix'}</span>
              <button className="modal-close" onClick={() => setExportOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <div className="panel">
                {canExportTrack && (
                  <div className="field">
                    <label>What to export</label>
                    <div className="seg">
                      <button
                        className={exportScope === 'track' ? 'active' : ''}
                        onClick={() => setExportScope('track')}
                        title={`Export only the “${selectedTrack!.name}” track`}
                      >
                        Track: {selectedTrack!.name}
                      </button>
                      <button
                        className={exportScope === 'mix' ? 'active' : ''}
                        onClick={() => setExportScope('mix')}
                        title="Export the full mix of all tracks"
                      >
                        Full mix
                      </button>
                    </div>
                  </div>
                )}
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
                    onClick={() => doExport(exportParams.format, exportParams.bitrate, exportScope)}
                  >
                    {exporting ? 'Exporting…' : <><Download size={15} /> Export</>}
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
              <Scissors size={14} /> Cut
            </button>
            <button onClick={() => { doCopy(); setMenu(null); }} disabled={!hasSelection}>
              <Copy size={14} /> Copy
            </button>
            <button onClick={() => { doPaste(); setMenu(null); }} disabled={!hasClipboard}>
              <ClipboardPaste size={14} /> Paste
            </button>
            <button onClick={() => { doSplit(); setMenu(null); }}>
              <Split size={14} />{' '}
              {selection.endSec - selection.startSec > 1e-6
                ? 'Split selection to new clip'
                : 'Split at playhead'}
            </button>
            {selection.clipIds.length > 0 && (
              <>
                <div className="ctx-sep" />
                <button onClick={() => { insertFade('in'); setMenu(null); }}>
                  <TrendingUp size={14} /> Fade in
                </button>
                <button onClick={() => { insertFade('out'); setMenu(null); }}>
                  <TrendingDown size={14} /> Fade out
                </button>
                {(() => {
                  const hasFade = project.tracks.some((t) =>
                    t.clips.some(
                      (c) =>
                        selection.clipIds.includes(c.id) &&
                        ((c.fadeInSec ?? 0) > 0 || (c.fadeOutSec ?? 0) > 0),
                    ),
                  );
                  return hasFade ? (
                    <button onClick={() => { clearFades(); setMenu(null); }}>
                      <X size={14} /> Remove fades
                    </button>
                  ) : null;
                })()}
              </>
            )}
            <div className="ctx-sep" />
            <button onClick={() => { doDelete(); setMenu(null); }} disabled={!hasSelection}>
              <Trash2 size={14} /> Delete selection
            </button>
            <button onClick={() => deleteTrack(menu.trackId)}>
              <Trash2 size={14} /> Delete track
            </button>
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
                    <Download size={14} /> Export MIDI (.mid)
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
