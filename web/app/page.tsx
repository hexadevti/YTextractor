'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronsLeft, Download, Library, Menu, Settings, X } from 'lucide-react';
import type {
  ArrangementSummary,
  JobConfig,
  ProgressUpdate,
  ProjectMeta,
  SourceMeta,
  StemName,
  StemSet,
} from '@prismaxim/shared';
import StartPanel from '@/components/StartPanel';
import LibraryPanel from '@/components/LibraryPanel';
import OptionsPanel from '@/components/OptionsPanel';
import ProgressPanel from '@/components/ProgressPanel';
import Editor from '@/components/editor/Editor';
import Mixer from '@/components/Mixer';
import { runJob, splitSavedSource } from '@/lib/pipeline';
import { store } from '@/lib/store';
import { emptyProject, fromStemSet, type EditorProject, type EditorTrack } from '@/lib/editor/model';
import type { ImportMode } from '@/components/StartPanel';
import { keepScreenAwake } from '@/lib/platform/wakeLock';
import { IS_MOBILE } from '@/lib/env';
import { DEFAULT_BACKEND_URL } from '@/lib/config';

type View = 'import' | 'library' | 'options';
const TITLES: Record<View, string> = { import: 'Import', library: 'Library', options: 'Options' };

interface Loaded {
  title: string;
  /** The raw 6-stem set, present for fresh splits and saved projects (drives the
   *  mobile quick-mixer). Absent for arrangements, which need the full editor. */
  set?: StemSet;
  /** Prebuilt editor project — present for arrangements (which carry no stem set).
   *  For set-based loads the project is derived from `set`: eagerly on desktop,
   *  lazily on mobile (see loadIntoEditor / toggleMobileEdit) so the quick-mixer
   *  path doesn't hold a second full copy of the audio in memory. */
  project?: EditorProject;
}

export default function Home() {
  const [modal, setModal] = useState<View | null>('import');
  const [project, setProject] = useState<EditorProject>(() => emptyProject());
  const [title, setTitle] = useState('Untitled');
  // Mobile lands in a simple faders mixer after a split; the full DAW editor is
  // opt-in via a toggle. `stemSet` holds the raw split for the mixer (null once an
  // arrangement — which the mixer can't represent — is loaded).
  const [stemSet, setStemSet] = useState<StemSet | null>(null);
  const [mobileEdit, setMobileEdit] = useState(false);
  const [sessionId, setSessionId] = useState(0);
  // Tracks queued to append to the live editor project (an "Add to open project"
  // import). Bumping `token` re-triggers the editor's append effect each time.
  const [pendingImport, setPendingImport] = useState<{ tracks: EditorTrack[]; token: number } | null>(
    null,
  );
  const importTokenRef = useRef(0);
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
    let project: EditorProject;
    if (loaded.project) {
      // Arrangement: comes with a prebuilt project (no stem set).
      project = loaded.project;
      if (IS_MOBILE) {
        // Mobile has no MIDI features — drop any MIDI tracks so a loaded project
        // never opens them (audio tracks only).
        const audioOnly = project.tracks.filter((t) => !t.midi);
        if (audioOnly.length !== project.tracks.length) {
          project = { ...project, tracks: audioOnly };
        }
      }
    } else if (loaded.set && !IS_MOBILE) {
      // Desktop / web: no quick-mixer, so build the editor project up front.
      project = fromStemSet(loaded.set);
    } else {
      // Mobile split/project: defer building the per-stem AudioBuffers until the
      // user opens the editor (toggleMobileEdit) — the mixer runs off the stem
      // set, so building them now would hold a second full copy of the audio.
      project = emptyProject();
    }
    setProject(project);
    setTitle(loaded.title);
    setStemSet(loaded.set ?? null);
    setMobileEdit(false); // default to the mixer view on mobile after a load
    setSessionId((s) => s + 1);
    dirtyRef.current = false;
    setJob({ running: false });
    setModal(null);
    setReloadKey((k) => k + 1);
  }, []);

  // Mobile: switch between the quick faders mixer and the full editor. The editor
  // project is built lazily on first entry (see loadIntoEditor) to keep the mixer
  // path light on memory.
  const toggleMobileEdit = useCallback(() => {
    const entering = !mobileEdit;
    if (entering && stemSet && project.tracks.length === 0) {
      setProject(fromStemSet(stemSet));
    }
    setMobileEdit(entering);
  }, [mobileEdit, stemSet, project]);

  // Append a load result to the live editor project (an "Add to open project"
  // import) instead of replacing it. The editor watches `pendingImport.token`.
  const addToEditor = useCallback((loaded: Loaded) => {
    const tracks = loaded.project
      ? loaded.project.tracks
      : loaded.set
        ? fromStemSet(loaded.set).tracks
        : [];
    if (tracks.length) {
      importTokenRef.current += 1;
      setPendingImport({ tracks, token: importTokenRef.current });
    }
    setMobileEdit(true); // ensure the editor (not the mixer) is showing on mobile
    setJob({ running: false });
    setModal(null);
  }, []);

  // Run a project-loading task inside the active modal. mode 'new' replaces the
  // editor project (confirming first if there are unsaved edits); mode 'add'
  // appends the result to the current project.
  const runInModal = useCallback(
    async (fn: () => Promise<Loaded>, mode: ImportMode = 'new') => {
      if (
        mode === 'new' &&
        dirtyRef.current &&
        !window.confirm('Replace the current project? Unsaved changes will be lost.')
      ) {
        return;
      }
      cancelledRef.current = false;
      setJob({ running: true, progress: { phase: 'extracting', percent: 0 } });
      // Hold a screen wake lock for the whole job: on mobile an auto screen-lock
      // suspends the WebView and kills the in-flight cloud separation request.
      const releaseWakeLock = keepScreenAwake();
      try {
        const loaded = await fn();
        if (cancelledRef.current) return;
        if (mode === 'add') addToEditor(loaded);
        else loadIntoEditor(loaded);
      } catch (err) {
        if (cancelledRef.current) return;
        setJob({ running: false, error: err instanceof Error ? err.message : String(err) });
      } finally {
        releaseWakeLock();
      }
    },
    [loadIntoEditor, addToEditor],
  );

  const start = useCallback(
    (config: JobConfig, file: File | null, mode: ImportMode = 'new') =>
      runInModal(async () => {
        const { set, project, title: t } = await runJob(config, file, onProgress);
        return { title: t, set, project };
      }, mode),
    [runInModal, onProgress],
  );

  const splitSource = useCallback(
    (source: SourceMeta, useCloud = false, stems?: StemName[]) =>
      runInModal(async () => {
        const { set, project } = await splitSavedSource(source, backendUrl, onProgress, useCloud, stems);
        return { title: source.title, set, project };
      }),
    [runInModal, backendUrl, onProgress],
  );

  const openProject = useCallback(
    (p: ProjectMeta) =>
      runInModal(async () => {
        const set = await store.loadProject(p, onProgress);
        return { title: p.title, set };
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
    if (view === 'import')
      return (
        <StartPanel
          onStart={start}
          backendUrl={backendUrl}
          canAddToProject={project.tracks.length > 0}
        />
      );
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

  // On mobile, a completed split shows the simple faders mixer; the full DAW
  // editor is opt-in. Desktop always uses the editor.
  const showMixer = IS_MOBILE && !!stemSet && !mobileEdit;

  return (
    <div className="app-shell">
      {/* Floating hamburger — only visible on small screens (see globals.css). */}
      <button className="mobile-nav-open" onClick={toggleNav} aria-label="Open menu">
        <Menu size={20} />
      </button>

      {/* Mobile-only toggle between the quick mixer and the full editor. */}
      {IS_MOBILE && stemSet && (
        <button className="mobile-view-toggle" onClick={toggleMobileEdit}>
          {mobileEdit ? '◂ Mixer' : 'Editor ▸'}
        </button>
      )}

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

      <main className={`app-main${showMixer ? ' mixer-mode' : ''}`}>
        {showMixer && stemSet ? (
          <Mixer set={stemSet} title={title} persisted onReset={() => selectView('import')} />
        ) : (
          <Editor
            key={sessionId}
            initialProject={project}
            title={title}
            onImport={() => selectView('import')}
            pendingImport={pendingImport}
            onSaved={() => {
              dirtyRef.current = false;
              setReloadKey((k) => k + 1);
            }}
            onDirtyChange={(d) => {
              dirtyRef.current = d;
            }}
          />
        )}
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
