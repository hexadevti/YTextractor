/** Undo/redo stack of EditorProject snapshots. */

import type { EditorProject } from './model';

export class History {
  private past: EditorProject[] = [];
  private future: EditorProject[] = [];
  private readonly limit: number;

  constructor(limit = 100) {
    this.limit = limit;
  }

  /** Record the project state *before* an edit is applied. */
  push(prev: EditorProject) {
    this.past.push(prev);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }
  canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Undo: given the current state, return the previous one (or null). */
  undo(current: EditorProject): EditorProject | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(current);
    return prev;
  }

  /** Redo: given the current state, return the next one (or null). */
  redo(current: EditorProject): EditorProject | null {
    const nextState = this.future.pop();
    if (!nextState) return null;
    this.past.push(current);
    return nextState;
  }
}
