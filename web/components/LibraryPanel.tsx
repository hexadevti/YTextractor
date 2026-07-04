'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Play, RefreshCw, Trash2 } from 'lucide-react';
import { STEM_META } from '@prismaxim/shared';
import type { ArrangementSummary, ProjectMeta, SourceMeta, StemName, StemSet } from '@prismaxim/shared';
import { store } from '@/lib/store';
import { cloudConfigured } from '@/lib/cloudConfig';
import { downloadBlob, encodeWav, renderProject } from '@/lib/editor/export';
import { fromStemSet, makeAudioBuffer } from '@/lib/editor/model';
import StemPicker from './StemPicker';

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

/** Format a duration in ms, or null when absent. */
function fmtMs(ms?: number): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
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

/**
 * Thumbnail resolved asynchronously via the store (an object URL in the web
 * build, a backend URL on desktop). Renders nothing when the source has none;
 * revokes object URLs on unmount.
 */
function AsyncThumb({ sourceId, alt }: { sourceId: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    store
      .getSourceThumbUrl(sourceId)
      .then((u) => {
        if (!alive) return;
        url = u;
        setSrc(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
    };
  }, [sourceId]);
  if (!src) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="lib-thumb" src={src} alt={alt} loading="lazy" onError={() => setSrc(null)} />;
}

async function openSourceAudio(id: string) {
  try {
    const url = await store.getSourceAudioUrl(id);
    window.open(url, '_blank', 'noopener');
  } catch {
    /* ignore */
  }
}

/** Filesystem-safe base filename for a download. */
function safeName(t: string): string {
  return t.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'audio';
}

/** Download an imported song in its original format. */
async function downloadSource(s: SourceMeta): Promise<void> {
  const bytes = await store.getSourceBytes(s.id);
  const type = s.mimeType || 'application/octet-stream';
  downloadBlob(new Blob([bytes], { type }), `${safeName(s.title)}.${s.ext}`);
}

/** Render an edited arrangement to a single mixed WAV and download it. */
async function downloadArrangementMix(a: ArrangementSummary): Promise<void> {
  const { project } = await store.loadArrangement(a.id);
  downloadBlob(encodeWav(await renderProject(project)), `${safeName(a.title)}.wav`);
}

/** Ghost icon button that runs an async download, showing a busy/disabled state. */
function DownloadButton({ title, run }: { title: string; run: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn ghost"
      title={title}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await run();
        } catch {
          window.alert('Could not prepare the download.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <Download size={14} />
    </button>
  );
}

/**
 * Download menu for a separated project: the full mix (all stems recombined) or
 * any individual stem, each as a WAV. The stem set is loaded on first pick and
 * cached while the menu stays open so downloading several stems decodes once.
 */
function ProjectDownloadMenu({ project }: { project: ProjectMeta }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'mix' | StemName | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const setRef = useRef<StemSet | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  const ensureSet = async (): Promise<StemSet> => {
    if (!setRef.current) setRef.current = await store.loadProject(project);
    return setRef.current;
  };

  const dl = async (key: 'mix' | StemName) => {
    setBusy(key);
    try {
      const set = await ensureSet();
      if (key === 'mix') {
        downloadBlob(encodeWav(await renderProject(fromStemSet(set))), `${safeName(project.title)}.wav`);
      } else {
        const stem = set.stems.find((s) => s.name === key);
        if (stem) {
          const buf = makeAudioBuffer(stem.channels, set.sampleRate);
          downloadBlob(encodeWav(buf), `${safeName(project.title)}_${key}.wav`);
        }
      }
    } catch {
      window.alert('Could not prepare the download.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dl-wrap" ref={wrapRef}>
      <button
        className="btn ghost"
        title="Download audio (mix or a single stem)"
        onClick={() => setOpen((o) => !o)}
      >
        <Download size={14} />
      </button>
      {open && (
        <div className="ctx-menu dl-menu">
          <button onClick={() => dl('mix')} disabled={busy !== null}>
            {busy === 'mix' ? 'Preparing…' : 'Full song (mix)'}
          </button>
          {project.stems.map((name) => (
            <button key={name} onClick={() => dl(name)} disabled={busy !== null}>
              {busy === name ? 'Preparing…' : (STEM_META[name]?.label ?? name)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface LibraryPanelProps {
  onOpenProject: (project: ProjectMeta) => void;
  onSplitSource: (source: SourceMeta, useCloud: boolean, stems: StemName[]) => void;
  onOpenArrangement: (arr: ArrangementSummary) => void;
  reloadKey?: number;
}

export default function LibraryPanel({
  onOpenProject,
  onSplitSource,
  onOpenArrangement,
  reloadKey,
}: LibraryPanelProps) {
  const [sources, setSources] = useState<SourceMeta[] | null>(null);
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null);
  const [arrangements, setArrangements] = useState<ArrangementSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Opt-in cloud "fast mode" for re-splitting a saved source.
  const [hasCloud, setHasCloud] = useState(false);
  const [useCloud, setUseCloud] = useState(false);
  // Which stems a re-split produces (shared across the sources below). Default:
  // none — the source loads unseparated unless the user picks stems.
  const [stems, setStems] = useState<StemName[]>([]);

  useEffect(() => {
    setHasCloud(cloudConfigured());
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [s, p, a] = await Promise.all([
        store.listSources(),
        store.listProjects(),
        store.listArrangements(),
      ]);
      setSources(s);
      setProjects(p);
      setArrangements(a);
    } catch {
      setError('Could not read the library.');
      setSources(null);
      setProjects(null);
      setArrangements(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, reloadKey]);

  // Projects show the thumbnail of the source they were separated from.
  const srcById = new Map((sources ?? []).map((s) => [s.id, s]));

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Library</h2>
        <div className="row" style={{ gap: 12 }}>
          {hasCloud && (
            <label
              className="hint"
              style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
              title="Re-split using the cloud GPU endpoint"
            >
              <input
                type="checkbox"
                checked={useCloud}
                onChange={(e) => setUseCloud(e.target.checked)}
              />
              ⚡ Cloud (fast)
            </label>
          )}
          <button className="btn ghost" onClick={() => void refresh()}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {error && <p className="hint">{error}</p>}

      {!error && (
        <>
          <h3 style={{ marginTop: 16 }}>Imported songs</h3>
          {sources && sources.length > 0 && (
            <div className="field" style={{ marginTop: 4 }}>
              <label>Stems to separate when splitting</label>
              <StemPicker value={stems} onChange={setStems} />
            </div>
          )}
          {sources && sources.length === 0 && (
            <p className="hint">No saved songs yet — split an uploaded file above.</p>
          )}
          {sources?.map((s) => (
            <div className="lib-item" key={s.id}>
              {s.hasThumb && <AsyncThumb sourceId={s.id} alt={s.title} />}
              <div className="lib-info">
                <strong>{s.title}</strong>
                {sourceStats(s) && <div className="hint">{sourceStats(s)}</div>}
                <div className="hint">
                  {s.origin} · {fmtDate(s.createdAt)} · {fmtSize(s.bytes)}
                  {fmtMs(s.captureMs) && ` · captured in ${fmtMs(s.captureMs)}`}
                </div>
              </div>
              <div className="lib-actions">
                <button className="btn secondary" onClick={() => void openSourceAudio(s.id)}>
                  <Play size={14} /> Open
                </button>
                <DownloadButton title="Download the original audio" run={() => downloadSource(s)} />
                <button className="btn" onClick={() => onSplitSource(s, useCloud, stems)}>
                  {stems.length === 0 ? 'Load' : useCloud ? 'Split ⚡' : 'Split'}
                </button>
                <button
                  className="btn ghost"
                  onClick={async () => {
                    if (!window.confirm(`Delete "${s.title}"? This permanently removes it.`)) return;
                    await store.deleteSource(s.id);
                    void refresh();
                  }}
                >
                  <Trash2 size={14} />
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
                {src?.hasThumb && <AsyncThumb sourceId={src.id} alt={p.title} />}
                <div className="lib-info">
                  <strong>{p.title}</strong>
                  <div className="hint">
                    {p.stems.length} stems · {p.engine} · {fmtDate(p.createdAt)}
                    {fmtMs(p.separationMs) && ` · separated in ${fmtMs(p.separationMs)}`}
                  </div>
                </div>
                <div className="lib-actions">
                  <button className="btn" onClick={() => onOpenProject(p)}>
                    Open project
                  </button>
                  <ProjectDownloadMenu project={p} />
                  <button
                    className="btn ghost"
                    onClick={async () => {
                      if (!window.confirm(`Delete project "${p.title}"? This cannot be undone.`))
                        return;
                      await store.deleteProject(p.id);
                      void refresh();
                    }}
                  >
                    <Trash2 size={14} />
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
                <DownloadButton title="Download the mixed audio (WAV)" run={() => downloadArrangementMix(a)} />
                <button
                  className="btn ghost"
                  onClick={async () => {
                    if (!window.confirm(`Delete edited project "${a.title}"? This cannot be undone.`))
                      return;
                    await store.deleteArrangement(a.id);
                    void refresh();
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
