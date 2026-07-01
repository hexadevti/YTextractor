'use client';

import type { ProgressUpdate } from '@ytx/shared';

const PHASE_LABELS: Record<string, string> = {
  extracting: 'Fetching audio',
  'loading-model': 'Loading model',
  separating: 'Separating stems',
  ready: 'Ready',
  error: 'Error',
  idle: 'Idle',
};

export default function ProgressPanel({
  progress,
  onCancel,
}: {
  progress: ProgressUpdate;
  onCancel: () => void;
}) {
  const label = PHASE_LABELS[progress.phase] ?? progress.phase;
  const isSeparating = progress.phase === 'separating';
  return (
    <div className="panel">
      <div className="phase-label">
        <strong>{label}</strong>
        <span className="engine">{progress.engine ? `engine: ${progress.engine}` : ''}</span>
      </div>
      <div className="bar">
        <span style={{ width: `${Math.max(2, progress.percent)}%` }} />
      </div>
      <div className="progress-wrap hint">
        {progress.message ?? ''}
        {isSeparating && (
          <>
            {' '}
            — this can take several minutes; keep the tab open.
          </>
        )}
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
