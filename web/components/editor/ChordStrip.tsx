'use client';

import { useEffect, useRef } from 'react';
import type { ChordSegment } from '@/lib/editor/analyze';

export const CHORD_STRIP_HEIGHT = 24;

export default function ChordStrip({
  chords,
  pxPerSec,
  scrollSec,
  viewportWidth,
  sidebarWidth,
}: {
  chords: ChordSegment[];
  pxPerSec: number;
  scrollSec: number;
  viewportWidth: number;
  sidebarWidth: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewportWidth <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = viewportWidth;
    const h = CHORD_STRIP_HEIGHT;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px ui-sans-serif, system-ui';
    ctx.textBaseline = 'middle';

    const secToX = (s: number) => (s - scrollSec) * pxPerSec;
    for (let i = 0; i < chords.length; i++) {
      const seg = chords[i]!;
      const x0 = secToX(seg.startSec);
      const x1 = secToX(seg.endSec);
      if (x1 < 0 || x0 > w) continue;
      const vx0 = Math.max(0, x0);
      const vx1 = Math.min(w, x1);
      ctx.fillStyle = i % 2 ? 'rgba(99,102,241,0.20)' : 'rgba(34,211,238,0.18)';
      ctx.fillRect(vx0, 0, vx1 - vx0, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.strokeRect(vx0 + 0.5, 0.5, vx1 - vx0 - 1, h - 1);
      if (vx1 - vx0 > 22) {
        ctx.fillStyle = '#e6e9ef';
        ctx.fillText(seg.label, vx0 + 4, h / 2);
      }
    }
  }, [chords, pxPerSec, scrollSec, viewportWidth]);

  return (
    <div className="chord-strip-row">
      <div className="chord-strip-gutter" style={{ width: sidebarWidth }}>
        chords
      </div>
      <canvas ref={canvasRef} className="chord-strip-canvas" style={{ width: viewportWidth, height: CHORD_STRIP_HEIGHT }} />
    </div>
  );
}
