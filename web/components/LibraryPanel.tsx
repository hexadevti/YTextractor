'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ProjectMeta, SourceMeta } from '@ytx/shared';
import {
  deleteProject as apiDeleteProject,
  deleteSource as apiDeleteSource,
  listProjects,
  listSources,
  sourceAudioUrl,
} from '@/lib/library';

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function fmtSize(bytes: number): string {
  return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`;
}

export interface LibraryPanelProps {
  backendUrl: string;
  onOpenProject: (project: ProjectMeta) => void;
  onSplitSource: (source: SourceMeta) => void;
  reloadKey?: number;
}

export default function LibraryPanel({
  backendUrl,
  onOpenProject,
  onSplitSource,
  reloadKey,
}: LibraryPanelProps) {
  const [sources, setSources] = useState<SourceMeta[] | null>(null);
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [s, p] = await Promise.all([listSources(backendUrl), listProjects(backendUrl)]);
      setSources(s);
      setProjects(p);
    } catch {
      setError('Library needs the backend running.');
      setSources(null);
      setProjects(null);
    }
  }, [backendUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh, reloadKey]);

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Library</h2>
        <button className="btn ghost" onClick={() => void refresh()}>
          ↻ Refresh
        </button>
      </div>

      {error && <p className="hint">{error}</p>}

      {!error && (
        <>
          <h3 style={{ marginTop: 16 }}>Imported songs</h3>
          {sources && sources.length === 0 && (
            <p className="hint">No saved songs yet — import a YouTube link above.</p>
          )}
          {sources?.map((s) => (
            <div className="lib-item" key={s.id}>
              <div className="lib-info">
                <strong>{s.title}</strong>
                <div className="hint">
                  {s.origin} · {fmtDate(s.createdAt)} · {fmtSize(s.bytes)}
                </div>
              </div>
              <div className="lib-actions">
                <a className="btn secondary" href={sourceAudioUrl(backendUrl, s.id)} target="_blank" rel="noreferrer">
                  ▶ Open
                </a>
                <button className="btn" onClick={() => onSplitSource(s)}>
                  Split
                </button>
                <button
                  className="btn ghost"
                  onClick={async () => {
                    await apiDeleteSource(backendUrl, s.id);
                    void refresh();
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}

          <h3 style={{ marginTop: 20 }}>Saved projects</h3>
          {projects && projects.length === 0 && (
            <p className="hint">No projects yet — split a song to save one here.</p>
          )}
          {projects?.map((p) => (
            <div className="lib-item" key={p.id}>
              <div className="lib-info">
                <strong>{p.title}</strong>
                <div className="hint">
                  {p.stems.length} stems · {p.engine} · {fmtDate(p.createdAt)}
                </div>
              </div>
              <div className="lib-actions">
                <button className="btn" onClick={() => onOpenProject(p)}>
                  Open project
                </button>
                <button
                  className="btn ghost"
                  onClick={async () => {
                    await apiDeleteProject(backendUrl, p.id);
                    void refresh();
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
