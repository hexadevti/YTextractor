'use client';

import { useEffect, useRef } from 'react';

const NICE = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

function niceStep(secPerLabel: number): number {
  for (const n of NICE) if (n >= secPerLabel) return n;
  return NICE[NICE.length - 1]!;
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const ss = Number.isInteger(s) ? String(s).padStart(2, '0') : s.toFixed(1).padStart(4, '0');
  return `${m}:${ss}`;
}

export default function Ruler({
  pxPerSec,
  scrollSec,
  viewportWidth,
  sidebarWidth,
  onPointerDown,
}: {
  pxPerSec: number;
  scrollSec: number;
  viewportWidth: number;
  sidebarWidth: number;
  onPointerDown: (localX: number, clientX: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewportWidth <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = viewportWidth;
    const h = 26;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const step = niceStep(80 / pxPerSec);
    const minor = step / 5;
    const firstSec = Math.floor(scrollSec / minor) * minor;
    ctx.fillStyle = '#8b94a7';
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.font = '10px ui-sans-serif, system-ui';
    ctx.textBaseline = 'top';

    for (let sec = firstSec; ; sec += minor) {
      const x = (sec - scrollSec) * pxPerSec;
      if (x > w) break;
      if (x < 0) continue;
      const isMajor = Math.abs(sec / step - Math.round(sec / step)) < 1e-6;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, isMajor ? 8 : 16);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
      if (isMajor) ctx.fillText(fmt(Math.round(sec / minor) * minor), x + 3, 2);
    }
  }, [pxPerSec, scrollSec, viewportWidth]);

  return (
    <div className="ruler-row">
      <div className="ruler-gutter" style={{ width: sidebarWidth }} />
      <canvas
        ref={canvasRef}
        className="ruler-canvas"
        style={{ width: viewportWidth, height: 26 }}
        onPointerDown={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onPointerDown(e.clientX - rect.left, e.clientX);
        }}
      />
    </div>
  );
}
