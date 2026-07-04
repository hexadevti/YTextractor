'use client';

import { useEffect, useRef, useState } from 'react';
import { PRESETS, type StemSet } from '@prismaxim/shared';
import { MixerEngine } from '@/lib/mixer/engine';
import { downloadBlob, encodeMp3, encodeWav, renderMix } from '@/lib/mixer/export';
import { saveBrowserProject } from '@/lib/library';
import Track from './Track';

function fmtTime(s: number): string {
  if (!isFinite(s)) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function safeName(title: string): string {
  return title.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'mix';
}

export default function Mixer({
  set,
  title,
  onReset,
  persisted = false,
  backendUrl,
}: {
  set: StemSet;
  title: string;
  onReset: () => void;
  persisted?: boolean;
  backendUrl?: string;
}) {
  const [engine, setEngine] = useState<MixerEngine | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [exporting, setExporting] = useState<null | 'wav' | 'mp3'>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>(
    persisted ? 'saved' : 'idle',
  );
  const seekRef = useRef<HTMLInputElement>(null);

  async function saveToLibrary() {
    if (!backendUrl) return;
    setSaveState('saving');
    try {
      await saveBrowserProject(backendUrl, set, title);
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }

  // Own the AudioContext lifecycle in the effect so React StrictMode's
  // setup → cleanup → setup pairs each context with its own close(); otherwise
  // the cleanup closes a context that the remount then tries to reuse/resume.
  useEffect(() => {
    const e = new MixerEngine(set);
    setEngine(e);
    setPlaying(false);
    return () => {
      setEngine(null);
      void e.close();
    };
  }, [set]);

  // Clock: update time label + seek slider while playing.
  useEffect(() => {
    if (!engine) return;
    const id = setInterval(() => {
      const t = engine.currentTime();
      setTime(t);
      if (seekRef.current && document.activeElement !== seekRef.current) {
        seekRef.current.value = String(t);
      }
      if (playing && !engine.isPlaying) setPlaying(false);
    }, 150);
    return () => clearInterval(id);
  }, [engine, playing]);

  async function togglePlay() {
    if (!engine) return;
    if (engine.isPlaying) {
      engine.pause();
      setPlaying(false);
    } else {
      await engine.play();
      setPlaying(true);
    }
  }

  async function doExport(kind: 'wav' | 'mp3') {
    if (!engine) return;
    setExporting(kind);
    try {
      const buffer = await renderMix(engine);
      const blob = kind === 'wav' ? encodeWav(buffer) : encodeMp3(buffer, 192);
      downloadBlob(blob, `${safeName(title)}_mix.${kind}`);
    } finally {
      setExporting(null);
    }
  }

  if (!engine) {
    return <div className="panel">Preparing mixer…</div>;
  }

  return (
    <div className="panel">
      <div className="mixer-toolbar">
        <div className="transport">
          <button className="btn" onClick={togglePlay}>
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <button
            className="btn secondary"
            onClick={() => {
              engine.seek(0);
              setTime(0);
            }}
          >
            ⏮ Restart
          </button>
          <span className="time">
            {fmtTime(time)} / {fmtTime(engine.duration)}
          </span>
        </div>

        <input
          ref={seekRef}
          type="range"
          min={0}
          max={engine.duration}
          step={0.05}
          defaultValue={0}
          style={{ flex: 1, minWidth: 160 }}
          onChange={(e) => {
            const t = Number(e.target.value);
            engine.seek(t);
            setTime(t);
          }}
        />
      </div>

      <div className="mixer-toolbar">
        <span className="hint">Presets:</span>
        {/* Only show presets whose muted stems are actually present in this set. */}
        {PRESETS.filter((p) => p.muted.every((m) => set.stems.some((s) => s.name === m))).map((p) => (
          <button key={p.id} className="btn secondary" onClick={() => engine.applyPreset(p.muted)}>
            {p.label}
          </button>
        ))}
        <button className="btn ghost" onClick={() => engine.resetTracks()}>
          Reset
        </button>
        <span style={{ marginLeft: 'auto' }} />
        <button
          className="btn"
          disabled={exporting !== null}
          onClick={() => doExport('wav')}
        >
          {exporting === 'wav' ? 'Rendering…' : '⬇ Export WAV'}
        </button>
        <button
          className="btn"
          disabled={exporting !== null}
          onClick={() => doExport('mp3')}
        >
          {exporting === 'mp3' ? 'Rendering…' : '⬇ Export MP3'}
        </button>
      </div>

      {set.stems.map((stem) => (
        <Track key={stem.name} engine={engine} name={stem.name} playing={playing} />
      ))}

      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn ghost" onClick={onReset}>
          ← Start over
        </button>
        <span style={{ marginLeft: 'auto' }} />
        {saveState === 'saved' ? (
          <span className="hint">✓ Saved in library</span>
        ) : backendUrl ? (
          <button
            className="btn secondary"
            disabled={saveState === 'saving'}
            onClick={saveToLibrary}
          >
            {saveState === 'saving'
              ? 'Saving…'
              : saveState === 'error'
                ? '⚠ Retry save'
                : '💾 Save to library'}
          </button>
        ) : (
          <span className="hint">Start the backend to save this project.</span>
        )}
      </div>
    </div>
  );
}
