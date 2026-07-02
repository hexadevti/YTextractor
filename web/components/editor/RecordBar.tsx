'use client';

import { useEffect, useRef } from 'react';
import type { DeviceOption } from '@/lib/editor/devices';

export interface RecordBarProps {
  inputs: DeviceOption[];
  outputs: DeviceOption[];
  inputId: string;
  outputId: string;
  onInput: (id: string) => void;
  onOutput: (id: string) => void;
  monitor: boolean;
  onMonitor: (v: boolean) => void;
  onEnableDevices: () => void;
  devicesReady: boolean;
  outputSupported: boolean;
  getLevel: () => number;
}

/** Audio I/O routing bar (device selectors + input meter + monitor). */
export default function RecordBar(p: RecordBarProps) {
  const meterRef = useRef<HTMLDivElement>(null);
  const getLevelRef = useRef(p.getLevel);
  getLevelRef.current = p.getLevel;

  useEffect(() => {
    if (!p.devicesReady) return;
    let raf = 0;
    const tick = () => {
      const lvl = getLevelRef.current();
      if (meterRef.current) {
        meterRef.current.style.width = `${Math.min(100, lvl * 100)}%`;
        meterRef.current.style.background = lvl > 0.9 ? 'var(--danger)' : 'var(--ok)';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [p.devicesReady]);

  return (
    <div className="record-bar">
      <span className="io-label">Audio I/O</span>
      {!p.devicesReady ? (
        <button className="btn secondary" onClick={p.onEnableDevices}>
          🎙 Enable input devices
        </button>
      ) : (
        <>
          <label className="dev">
            In
            <select value={p.inputId} onChange={(e) => p.onInput(e.target.value)}>
              {p.inputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>

          <div className="input-meter" title="Input level">
            <div ref={meterRef} className="input-meter-fill" />
          </div>

          <label className="dev">
            Out
            <select
              value={p.outputId}
              onChange={(e) => p.onOutput(e.target.value)}
              disabled={!p.outputSupported}
              title={p.outputSupported ? '' : 'Output selection needs Chrome/Edge'}
            >
              {p.outputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>

          <label className="dev checkbox">
            <input type="checkbox" checked={p.monitor} onChange={(e) => p.onMonitor(e.target.checked)} />
            Monitor
          </label>
        </>
      )}
    </div>
  );
}
