'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ArrangementSummary, ProjectMeta, SourceMeta } from '@ytx/shared';
import {
  deleteArrangement as apiDeleteArrangement,
  deleteProject as apiDeleteProject,
  deleteSource as apiDeleteSource,
  listArrangements,
  listProjects,
  listSources,
  sourceAudioUrl,
  sourceThumbUrl,
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

function fmtCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** Stats line (uploader · views · likes) for a YouTube source, if present. */
function sourceStats(s: SourceMeta): string | null {
  const parts: string[] = [];
  if (s.uploader) parts.push(s.uploader);
  if (typeof s.viewCount === 'number') parts.push(`${fmtCount(s.viewCount)} views`);
  if (typeof s.likeCount === 'number') parts.push(`${fmtCount(s.likeCount)} likes`);
  return parts.length ? parts.join(' · ') : null;
}

/** Thumbnail image that removes itself if the file 404s (older sources / uploads). */
function Thumb({ src, alt }: { src: string; alt: string }) {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="lib-thumb" src={src} alt={alt} loading="lazy" onError={() => setOk(false)} />;
}

export interface LibraryPanelProps {
  backendUrl: string;
  onOpenProject: (project: ProjectMeta) => void;
  onSplitSource: (source: SourceMeta) => void;
  onOpenArrangement: (arr: ArrangementSummary) => void;
  reloadKey?: number;
}

export default function LibraryPanel({
  backendUrl,
  onOpenProject,
  onSplitSource,
  onOpenArrangement,
  reloadKey,
}: LibraryPanelProps) {
  const [sources, setSources] = useState<SourceMeta[] | null>(null);
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null);
  const [arrangements, setArrangements] = useState<ArrangementSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [s, p, a] = await Promise.all([
        listSources(backendUrl),
        listProjects(backendUrl),
        listArrangements(backendUrl),
      ]);
      setSources(s);
      setProjects(p);
      setArrangements(a);
    } catch {
      setError('Library needs the backend running.');
      setSources(null);
      setProjects(null);
      setArrangements(null);
    }
  }, [backendUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh, reloadKey]);

  // Projects show the thumbnail of the source they were separated from.
  const srcById = new Map((sources ?? []).map((s) => [s.id, s]));

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
              {s.hasThumb && <Thumb src={sourceThumbUrl(backendUrl, s.id)} alt={s.title} />}
              <div className="lib-info">
                <strong>{s.title}</strong>
                {sourceStats(s) && <div className="hint">{sourceStats(s)}</div>}
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
                    if (!window.confirm(`Delete "${s.title}"? This permanently removes it from disk.`))
                      return;
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
          {projects?.map((p) => {
            const src = p.sourceId ? srcById.get(p.sourceId) : undefined;
            return (
            <div className="lib-item" key={p.id}>
              {src?.hasThumb && <Thumb src={sourceThumbUrl(backendUrl, src.id)} alt={p.title} />}
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
                    if (!window.confirm(`Delete project "${p.title}"? This cannot be undone.`)) return;
                    await apiDeleteProject(backendUrl, p.id);
                    void refresh();
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
            );
          })}

          <h3 style={{ marginTop: 20 }}>Edited projects</h3>
          {arrangements && arrangements.length === 0 && (
            <p className="hint">No edited projects yet — save one from the editor.</p>
          )}
          {arrangements?.map((a) => (
            <div className="lib-item" key={a.id}>
              <div className="lib-info">
                <strong>{a.title}</strong>
                <div className="hint">
                  edited · {a.trackCount} tracks · {fmtDate(a.createdAt)}
                </div>
              </div>
              <div className="lib-actions">
                <button className="btn" onClick={() => onOpenArrangement(a)}>
                  Open in editor
                </button>
                <button
                  className="btn ghost"
                  onClick={async () => {
                    if (!window.confirm(`Delete edited project "${a.title}"? This cannot be undone.`))
                      return;
                    await apiDeleteArrangement(backendUrl, a.id);
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
