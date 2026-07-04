'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronsLeft, Download, Library, Menu, Settings, X } from 'lucide-react';
import type {
  ArrangementSummary,
  JobConfig,
  ProgressUpdate,
  ProjectMeta,
  SourceMeta,
} from '@prismaxim/shared';
import StartPanel from '@/components/StartPanel';
import LibraryPanel from '@/components/LibraryPanel';
import OptionsPanel from '@/components/OptionsPanel';
import ProgressPanel from '@/components/ProgressPanel';
import Editor from '@/components/editor/Editor';
import { runJob, splitSavedSource } from '@/lib/pipeline';
import { store } from '@/lib/store';
import { emptyProject, fromStemSet, type EditorProject } from '@/lib/editor/model';
import { DEFAULT_BACKEND_URL } from '@/lib/config';

type View = 'import' | 'library' | 'options';
const TITLES: Record<View, string> = { import: 'Import', library: 'Library', options: 'Options' };

interface Loaded {
  project: EditorProject;
  title: string;
}

export default function Home() {
  const [modal, setModal] = useState<View | null>('import');
  const [project, setProject] = useState<EditorProject>(() => emptyProject());
  const [title, setTitle] = useState('Untitled');
  const [sessionId, setSessionId] = useState(0);
  const [backendUrl, setBackendUrl] = useState(DEFAULT_BACKEND_URL);
  const [reloadKey, setReloadKey] = useState(0);
  const [job, setJob] = useState<{ running: boolean; progress?: ProgressUpdate; error?: string }>({
    running: false,
  });
  const cancelledRef = useRef(false);
  const dirtyRef = useRef(false);
  // Start closed so the static-export first paint doesn't flash an open drawer on
  // mobile; the mount effect opens it on desktop (or restores the saved rail).
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    // On phones the sidebar is an off-canvas drawer (see globals.css) — start it
    // closed so the editor is full-screen. On desktop, restore the saved rail
    // preference.
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches) {
      setNavOpen(false);
      return;
    }
    try {
      const v = localStorage.getItem('prismaxim-nav-open');
      // Desktop defaults to open (rail expanded) on first visit.
      setNavOpen(v === null ? true : v === '1');
    } catch {
      setNavOpen(true);
    }
  }, []);

  // Open a view's modal; on mobile also close the drawer so it doesn't cover it.
  const selectView = (v: View) => {
    setModal(v);
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches) {
      setNavOpen(false);
    }
  };

  const toggleNav = () =>
    setNavOpen((o) => {
      const n = !o;
      try {
        localStorage.setItem('prismaxim-nav-open', n ? '1' : '0');
      } catch {
        /* ignore */
      }
      return n;
    });

  const onProgress = useCallback((progress: ProgressUpdate) => {
    if (!cancelledRef.current) setJob({ running: true, progress });
  }, []);

  const loadIntoEditor = useCallback((loaded: Loaded) => {
    setProject(loaded.project);
    setTitle(loaded.title);
    setSessionId((s) => s + 1);
    dirtyRef.current = false;
    setJob({ running: false });
    setModal(null);
    setReloadKey((k) => k + 1);
  }, []);

  // Run a project-loading task inside the active modal; on success it replaces
  // the editor's project (confirming first if there are unsaved edits).
  const runInModal = useCallback(
    async (fn: () => Promise<Loaded>) => {
      if (
        dirtyRef.current &&
        !window.confirm('Replace the current project? Unsaved changes will be lost.')
      ) {
        return;
      }
      cancelledRef.current = false;
      setJob({ running: true, progress: { phase: 'extracting', percent: 0 } });
      try {
        const loaded = await fn();
        if (cancelledRef.current) return;
        loadIntoEditor(loaded);
      } catch (err) {
        if (cancelledRef.current) return;
        setJob({ running: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
    [loadIntoEditor],
  );

  const start = useCallback(
    (config: JobConfig, file: File | null) =>
      runInModal(async () => {
        const { set, title: t } = await runJob(config, file, onProgress);
        return { project: fromStemSet(set), title: t };
      }),
    [runInModal, onProgress],
  );

  const splitSource = useCallback(
    (source: SourceMeta, useCloud = false) =>
      runInModal(async () => {
        const set = await splitSavedSource(source, backendUrl, onProgress, useCloud);
        return { project: fromStemSet(set), title: source.title };
      }),
    [runInModal, backendUrl, onProgress],
  );

  const openProject = useCallback(
    (p: ProjectMeta) =>
      runInModal(async () => {
        const set = await store.loadProject(p, onProgress);
        return { project: fromStemSet(set), title: p.title };
      }),
    [runInModal, onProgress],
  );

  const openArrangement = useCallback(
    (a: ArrangementSummary) => runInModal(() => store.loadArrangement(a.id, onProgress)),
    [runInModal, onProgress],
  );

  const closeModal = useCallback(() => {
    if (job.running) cancelledRef.current = true;
    setJob({ running: false });
    setModal(null);
  }, [job.running]);

  function modalInner(view: View) {
    if (job.running) {
      return (
        <ProgressPanel
          progress={job.progress ?? { phase: 'extracting', percent: 0 }}
          onCancel={closeModal}
        />
      );
    }
    if (job.error) {
      return (
        <div className="panel">
          <h2>Something went wrong</h2>
          <p className="err">{job.error}</p>
          <p className="hint">
            If YouTube extraction failed, try the file-upload path or the backend engine — the
            upload path works without any server.
          </p>
          <button className="btn" onClick={() => setJob({ running: false })}>
            ← Back
          </button>
        </div>
      );
    }
    if (view === 'import') return <StartPanel onStart={start} backendUrl={backendUrl} />;
    if (view === 'library') {
      return (
        <LibraryPanel
          onOpenProject={openProject}
          onSplitSource={splitSource}
          onOpenArrangement={openArrangement}
          reloadKey={reloadKey}
        />
      );
    }
    return <OptionsPanel backendUrl={backendUrl} onBackendUrlChange={setBackendUrl} />;
  }

  return (
    <div className="app-shell">
      {/* Floating hamburger — only visible on small screens (see globals.css). */}
      <button className="mobile-nav-open" onClick={toggleNav} aria-label="Open menu">
        <Menu size={20} />
      </button>

      {/* Backdrop behind the mobile drawer; tapping it closes the drawer. */}
      {navOpen && <div className="drawer-backdrop" onClick={toggleNav} />}

      <aside className={`sidebar${navOpen ? '' : ' collapsed'}`}>
        <button
          className="nav-toggle"
          onClick={toggleNav}
          title={navOpen ? 'Collapse menu' : 'Expand menu'}
          aria-label={navOpen ? 'Collapse menu' : 'Expand menu'}
        >
          {navOpen ? <ChevronsLeft size={18} /> : <Menu size={18} />}
        </button>
        <div className="brand">
          <span className="brand-icon">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.png" alt="Prismaxim" width={32} height={32} />
          </span>
          <span className="label">Prismaxim</span>
        </div>
        <nav>
          {(['import', 'library', 'options'] as View[]).map((v) => (
            <button
              key={v}
              className={`nav-btn${modal === v ? ' active' : ''}`}
              onClick={() => selectView(v)}
              title={TITLES[v]}
            >
              <span className="nav-icon">
                {v === 'import' ? (
                  <Download size={17} />
                ) : v === 'library' ? (
                  <Library size={17} />
                ) : (
                  <Settings size={17} />
                )}
              </span>
              <span className="label">{TITLES[v]}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          Demucs (htdemucs_6s) 6-stem separation. For personal use — respect copyright and
          YouTube&apos;s Terms of Service.
        </div>
      </aside>

      <main className="app-main">
        <Editor
          key={sessionId}
          initialProject={project}
          title={title}
          onSaved={() => {
            dirtyRef.current = false;
            setReloadKey((k) => k + 1);
          }}
          onDirtyChange={(d) => {
            dirtyRef.current = d;
          }}
        />
      </main>

      {modal && (
        <div className="modal-backdrop">
          <div className={`modal modal-${modal}`} onPointerDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>{TITLES[modal]}</span>
              <button className="modal-close" onClick={closeModal} title="Close">
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">{modalInner(modal)}</div>
          </div>
        </div>
      )}
    </div>
  );
}
