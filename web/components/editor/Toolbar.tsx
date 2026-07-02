'use client';

export interface ToolbarProps {
  // edit
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSplit: () => void;
  onDelete: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  canPaste: boolean;
  hasSelection: boolean;
  // view
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onAddTrack: () => void;
  // analyze
  onDetectTempo: () => void;
  onDetectChords: () => void;
  onStats: () => void;
  analyzing: null | 'tempo' | 'chords' | 'midi' | 'stats';
  chordCount: number;
}

export default function Toolbar(p: ToolbarProps) {
  return (
    <div className="editor-toolbar">
      {/* Edit tools */}
      <div className="tool-group">
        <button className="btn secondary" onClick={p.onCut} disabled={!p.hasSelection} title="Cut (Ctrl+X)">
          ✂ Cut
        </button>
        <button className="btn secondary" onClick={p.onCopy} disabled={!p.hasSelection} title="Copy (Ctrl+C)">
          ⧉ Copy
        </button>
        <button className="btn secondary" onClick={p.onPaste} disabled={!p.canPaste} title="Paste (Ctrl+V)">
          📋 Paste
        </button>
        <button className="btn secondary" onClick={p.onSplit} title="Split at playhead (S)">
          ⎘ Split
        </button>
        <button className="btn secondary" onClick={p.onDelete} disabled={!p.hasSelection} title="Delete (Del)">
          🗑 Delete
        </button>
        <button className="btn ghost" onClick={p.onUndo} disabled={!p.canUndo} title="Undo (Ctrl+Z)">
          ↶
        </button>
        <button className="btn ghost" onClick={p.onRedo} disabled={!p.canRedo} title="Redo (Ctrl+Y)">
          ↷
        </button>
      </div>

      {/* View */}
      <div className="tool-group">
        <button className="btn ghost" onClick={p.onZoomOut} title="Zoom out">
          −
        </button>
        <button className="btn ghost" onClick={p.onFit} title="Fit all tracks to view">
          ⤢ Fit
        </button>
        <button className="btn ghost" onClick={p.onZoomIn} title="Zoom in">
          +
        </button>
        <button className="btn secondary" onClick={p.onAddTrack} title="Add an empty track">
          ＋ Track
        </button>
      </div>

      {/* Analysis */}
      <div className="tool-group">
        <button className="btn ghost" onClick={p.onDetectTempo} disabled={p.analyzing !== null}>
          {p.analyzing === 'tempo' ? 'Detecting…' : '⏱ Detect tempo'}
        </button>
        <button className="btn ghost" onClick={p.onDetectChords} disabled={p.analyzing !== null}>
          {p.analyzing === 'chords' ? 'Detecting…' : '🎼 Detect chords'}
        </button>
        <button className="btn ghost" onClick={p.onStats} disabled={p.analyzing !== null}>
          {p.analyzing === 'stats' ? 'Analyzing…' : '📊 Stats'}
        </button>
        {p.chordCount > 0 && <span className="hint">{p.chordCount} chords</span>}
      </div>
    </div>
  );
}
