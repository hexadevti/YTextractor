'use client';

import { STEM_META } from '@ytx/shared';
import type { MusicStats } from '@/lib/editor/musicStats';

function fmtDur(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function Tile({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export default function StatsPanel({ stats, onClose }: { stats: MusicStats; onClose: () => void }) {
  return (
    <div className="stats-panel">
      <div className="stats-head">
        <span>Music stats</span>
        <button className="btn ghost" onClick={onClose}>
          ✕ Hide
        </button>
      </div>
      <div className="stats-row">
        <Tile label="Key" value={stats.key} sub={stats.scale} />
        <Tile label="BPM" value={String(stats.bpm)} color="#f59e0b" />
        <Tile label="LUFS" value={stats.lufs.toFixed(1)} sub={`Peak ${stats.peakDb.toFixed(1)} dB`} />
        <Tile label="Duration" value={fmtDur(stats.durationSec)} />
        <Tile label="Scale" value={stats.scale} />
        <Tile label="Dynamic range" value={stats.dynamicRange.toFixed(1)} sub={stats.dynamicLabel} />
        <Tile
          label="Tempo stability"
          value={`${stats.tempoStability}%`}
          sub={stats.stabilityLabel}
          color="var(--ok)"
        />
      </div>
      {stats.stems.length > 0 && (
        <div className="stats-row">
          {stats.stems.map((s) => (
            <Tile
              key={s.name}
              label={`${STEM_META[s.name].label} presence`}
              value={`${s.presence}%`}
              color={STEM_META[s.name].color}
            />
          ))}
        </div>
      )}
    </div>
  );
}
