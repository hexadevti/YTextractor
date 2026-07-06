'use client';

import {
  BarChart3,
  ClipboardPaste,
  Copy,
  ListPlus,
  Maximize2,
  Music2,
  PanelRight,
  Redo2,
  Scissors,
  Split,
  Timer,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { IS_MOBILE } from '@/lib/env';

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
  /** Hide the "Track" button — set on mobile, where it's promoted to the transport row. */
  hideAddTrack?: boolean;
  // analyze
  onDetectTempo: () => void;
  onDetectChords: () => void;
  onStats: () => void;
  analyzing: null | 'tempo' | 'chords' | 'midi' | 'stats';
  chordCount: number;
  // tools sidebar
  onToggleTools: () => void;
  toolsOpen: boolean;
}

export default function Toolbar(p: ToolbarProps) {
  return (
    <div className="editor-toolbar">
      {/* Edit tools */}
      <div className="tool-group">
        <button className="btn secondary" onClick={p.onCut} disabled={!p.hasSelection} title="Cut (Ctrl+X)">
          <Scissors size={14} /> Cut
        </button>
        <button className="btn secondary" onClick={p.onCopy} disabled={!p.hasSelection} title="Copy (Ctrl+C)">
          <Copy size={14} /> Copy
        </button>
        <button className="btn secondary" onClick={p.onPaste} disabled={!p.canPaste} title="Paste (Ctrl+V)">
          <ClipboardPaste size={14} /> Paste
        </button>
        <button
          className="btn secondary"
          onClick={p.onSplit}
          title="Split: carve the selected region into a new clip, or split at the playhead (S)"
        >
          <Split size={14} /> Split
        </button>
        <button className="btn secondary" onClick={p.onDelete} disabled={!p.hasSelection} title="Delete (Del)">
          <Trash2 size={14} /> Delete
        </button>
        <button className="btn ghost" onClick={p.onUndo} disabled={!p.canUndo} title="Undo (Ctrl+Z)">
          <Undo2 size={15} />
        </button>
        <button className="btn ghost" onClick={p.onRedo} disabled={!p.canRedo} title="Redo (Ctrl+Y)">
          <Redo2 size={15} />
        </button>
      </div>

      {/* View — on mobile, zoom/fit is gestural (pinch) and "Track" is promoted to
          the transport row, so this group can end up empty; skip it then. */}
      {(!IS_MOBILE || !p.hideAddTrack) && (
        <div className="tool-group">
          {!IS_MOBILE && (
            <>
              <button className="btn ghost" onClick={p.onZoomOut} title="Zoom out">
                <ZoomOut size={15} />
              </button>
              <button className="btn ghost" onClick={p.onFit} title="Fit all tracks to view">
                <Maximize2 size={14} /> Fit
              </button>
              <button className="btn ghost" onClick={p.onZoomIn} title="Zoom in">
                <ZoomIn size={15} />
              </button>
            </>
          )}
          {!p.hideAddTrack && (
            <button className="btn secondary" onClick={p.onAddTrack} title="Add an empty track">
              <ListPlus size={15} /> Track
            </button>
          )}
        </div>
      )}

      {/* Analysis — desktop only (tempo/chord/stats detection). */}
      {!IS_MOBILE && (
        <div className="tool-group">
          <button className="btn ghost" onClick={p.onDetectTempo} disabled={p.analyzing !== null}>
            {p.analyzing === 'tempo' ? 'Detecting…' : <><Timer size={14} /> Detect tempo</>}
          </button>
          <button className="btn ghost" onClick={p.onDetectChords} disabled={p.analyzing !== null}>
            {p.analyzing === 'chords' ? 'Detecting…' : <><Music2 size={14} /> Detect chords</>}
          </button>
          <button className="btn ghost" onClick={p.onStats} disabled={p.analyzing !== null}>
            {p.analyzing === 'stats' ? 'Analyzing…' : <><BarChart3 size={14} /> Stats</>}
          </button>
          {p.chordCount > 0 && <span className="hint">{p.chordCount} chords</span>}
        </div>
      )}

      {/* Tools (output-audio visualizers) — desktop only. */}
      {!IS_MOBILE && (
        <div className="tool-group tool-group-end">
          <button
            className={`btn ghost${p.toolsOpen ? ' active' : ''}`}
            onClick={p.onToggleTools}
            title="Tools: output-audio visualizers (VU meter, spectrum)"
          >
            <PanelRight size={15} /> Tools
          </button>
        </div>
      )}
    </div>
  );
}
