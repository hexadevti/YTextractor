'use client';

import { useCallback, useRef, useState } from 'react';
import type {
  JobConfig,
  ProgressUpdate,
  ProjectMeta,
  SourceMeta,
  StemSet,
} from '@ytx/shared';
import StartPanel from '@/components/StartPanel';
import LibraryPanel from '@/components/LibraryPanel';
import ProgressPanel from '@/components/ProgressPanel';
import Mixer from '@/components/Mixer';
import { runJob } from '@/lib/pipeline';
import { separateFromSource } from '@/lib/engines/client';
import { loadProject } from '@/lib/library';
import { DEFAULT_BACKEND_URL } from '@/lib/config';

type Stage =
  | { name: 'config' }
  | { name: 'running'; progress: ProgressUpdate }
  | { name: 'ready'; set: StemSet; title: string; persisted: boolean }
  | { name: 'error'; message: string };

export default function Home() {
  const [stage, setStage] = useState<Stage>({ name: 'config' });
  const [backendUrl, setBackendUrl] = useState(DEFAULT_BACKEND_URL);
  const [reloadKey, setReloadKey] = useState(0);
  const cancelledRef = useRef(false);

  const onProgress = useCallback((progress: ProgressUpdate) => {
    if (!cancelledRef.current) setStage({ name: 'running', progress });
  }, []);

  const start = useCallback(
    async (config: JobConfig, file: File | null) => {
      cancelledRef.current = false;
      setStage({ name: 'running', progress: { phase: 'extracting', percent: 0 } });
      try {
        const { set, title, persisted } = await runJob(config, file, onProgress);
        if (cancelledRef.current) return;
        setStage({ name: 'ready', set, title, persisted });
        setReloadKey((k) => k + 1);
      } catch (err) {
        if (cancelledRef.current) return;
        setStage({ name: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    },
    [onProgress],
  );

  const splitSource = useCallback(
    async (source: SourceMeta) => {
      cancelledRef.current = false;
      setStage({ name: 'running', progress: { phase: 'separating', percent: 0 } });
      try {
        const set = await separateFromSource(backendUrl, source.id, onProgress);
        if (cancelledRef.current) return;
        setStage({ name: 'ready', set, title: source.title, persisted: true });
        setReloadKey((k) => k + 1);
      } catch (err) {
        if (cancelledRef.current) return;
        setStage({ name: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    },
    [backendUrl, onProgress],
  );

  const openProject = useCallback(
    async (project: ProjectMeta) => {
      cancelledRef.current = false;
      setStage({ name: 'running', progress: { phase: 'loading-model', percent: 0, message: 'Opening project…' } });
      try {
        const set = await loadProject(backendUrl, project, onProgress);
        if (cancelledRef.current) return;
        setStage({ name: 'ready', set, title: project.title, persisted: true });
      } catch (err) {
        if (cancelledRef.current) return;
        setStage({ name: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    },
    [backendUrl, onProgress],
  );

  const reset = useCallback(() => {
    cancelledRef.current = true;
    setStage({ name: 'config' });
    setReloadKey((k) => k + 1);
  }, []);

  return (
    <main className="container">
      <header className="app-header">
        <span className="logo">🎛 YTextractor</span>
        <span className="tagline">Stem splitter &amp; studio mixer</span>
      </header>

      {stage.name === 'config' && (
        <>
          <StartPanel onStart={start} backendUrl={backendUrl} onBackendUrlChange={setBackendUrl} />
          <LibraryPanel
            backendUrl={backendUrl}
            onOpenProject={openProject}
            onSplitSource={splitSource}
            reloadKey={reloadKey}
          />
        </>
      )}

      {stage.name === 'running' && <ProgressPanel progress={stage.progress} onCancel={reset} />}

      {stage.name === 'error' && (
        <div className="panel">
          <h2>Something went wrong</h2>
          <p className="err">{stage.message}</p>
          <p className="hint">
            If YouTube extraction failed, try the file-upload path or the backend engine — the
            upload path works without any server.
          </p>
          <button className="btn" onClick={reset}>
            ← Try again
          </button>
        </div>
      )}

      {stage.name === 'ready' && (
        <Mixer
          set={stage.set}
          title={stage.title}
          persisted={stage.persisted}
          backendUrl={backendUrl}
          onReset={reset}
        />
      )}

      <footer className="hint" style={{ marginTop: 28 }}>
        Runs Demucs (htdemucs_6s) for 6-stem separation. For personal use — respect copyright and
        YouTube&apos;s Terms of Service.
      </footer>
    </main>
  );
}
