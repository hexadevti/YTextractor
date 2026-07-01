'use client';

import { useEffect, useRef, useState } from 'react';
import { STEM_META, type StemName } from '@ytx/shared';
import type { MixerEngine } from '@/lib/mixer/engine';
import { computePeaks, drawWaveform, type Peaks } from '@/lib/mixer/waveform';
import { drawSpectrum, freqBuffer } from '@/lib/mixer/spectrum';

export default function Track({
  engine,
  name,
  playing,
}: {
  engine: MixerEngine;
  name: StemName;
  playing: boolean;
}) {
  const meta = STEM_META[name];
  const waveRef = useRef<HTMLCanvasElement>(null);
  const specRef = useRef<HTMLCanvasElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const peaksRef = useRef<Peaks | null>(null);

  const initial = engine.getTracks().find((t) => t.name === name)!;
  const [muted, setMuted] = useState(initial.muted);
  const [soloed, setSoloed] = useState(initial.soloed);
  const [removed, setRemoved] = useState(initial.removed);
  const [volume, setVolume] = useState(initial.volume);

  // Sync local button state from the engine (e.g. when a preset is applied).
  useEffect(() => {
    const id = setInterval(() => {
      const t = engine.getTracks().find((x) => x.name === name);
      if (!t) return;
      setMuted(t.muted);
      setSoloed(t.soloed);
      setRemoved(t.removed);
      setVolume(t.volume);
    }, 250);
    return () => clearInterval(id);
  }, [engine, name]);

  // Draw the static waveform once.
  useEffect(() => {
    const canvas = waveRef.current;
    const buffer = engine.getChannelBuffer(name);
    if (!canvas || !buffer) return;
    const buckets = Math.max(200, Math.floor(canvas.clientWidth || 600));
    peaksRef.current = computePeaks(buffer, buckets);
    drawWaveform(canvas, peaksRef.current, meta.color);
    const onResize = () => {
      if (peaksRef.current) drawWaveform(canvas, peaksRef.current, meta.color);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [engine, name, meta.color]);

  // Animate spectrum + playhead while playing.
  useEffect(() => {
    const spec = specRef.current;
    const head = headRef.current;
    const analyser = engine.getAnalyser(name);
    if (!spec || !analyser) return;
    const data = freqBuffer(analyser);
    let raf = 0;
    const tick = () => {
      drawSpectrum(spec, analyser, data, meta.color);
      if (head) {
        const frac = engine.duration ? engine.currentTime() / engine.duration : 0;
        head.style.left = `${Math.min(100, frac * 100)}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    if (playing) raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, name, meta.color, playing]);

  return (
    <div className={`track${removed ? ' removed' : ''}`}>
      <div className="name">
        <span className="swatch" style={{ background: meta.color }} />
        {meta.label}
        <div className="controls" style={{ marginLeft: 'auto' }}>
          <button
            className={`mute${muted ? ' on' : ''}`}
            title="Mute"
            onClick={() => {
              const v = !muted;
              setMuted(v);
              engine.setMuted(name, v);
            }}
          >
            M
          </button>
          <button
            className={`solo${soloed ? ' on' : ''}`}
            title="Solo"
            onClick={() => {
              const v = !soloed;
              setSoloed(v);
              engine.setSoloed(name, v);
            }}
          >
            S
          </button>
          <button
            title="Remove from mix"
            onClick={() => {
              const v = !removed;
              setRemoved(v);
              engine.setRemoved(name, v);
            }}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="visuals">
        <canvas ref={waveRef} />
        <canvas ref={specRef} style={{ opacity: 0.55 }} />
        <div ref={headRef} className="playhead" style={{ left: '0%' }} />
      </div>

      <input
        type="range"
        min={0}
        max={1.5}
        step={0.01}
        value={volume}
        onChange={(e) => {
          const v = Number(e.target.value);
          setVolume(v);
          engine.setVolume(name, v);
        }}
        title={`Volume ${(volume * 100).toFixed(0)}%`}
      />
    </div>
  );
}
