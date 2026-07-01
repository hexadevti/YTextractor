'use client';

import { useEffect, useState } from 'react';
import type {
  ExtractionEngine,
  JobConfig,
  SeparationEngine,
} from '@ytx/shared';
import { checkBackend } from '@/lib/engines/client';
import { addToHistory, getHistory, removeFromHistory, type HistoryEntry } from '@/lib/history';

type InputKind = 'youtube' | 'file';

export interface StartPanelProps {
  onStart: (config: JobConfig, file: File | null) => void;
  backendUrl: string;
  onBackendUrlChange: (url: string) => void;
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === value ? 'active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function StartPanel({ onStart, backendUrl, onBackendUrlChange }: StartPanelProps) {
  const [inputKind, setInputKind] = useState<InputKind>('youtube');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [extraction, setExtraction] = useState<ExtractionEngine>('backend');
  const [separation, setSeparation] = useState<SeparationEngine>('backend');
  const [backendUp, setBackendUp] = useState<boolean | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  // Load link history on mount (client-only).
  useEffect(() => {
    setHistory(getHistory());
  }, []);

  const needsBackend =
    separation === 'backend' || (inputKind === 'youtube' && extraction === 'backend') ||
    (inputKind === 'youtube' && extraction === 'browser'); // browser extraction needs the proxy

  useEffect(() => {
    let cancelled = false;
    if (!needsBackend) {
      setBackendUp(null);
      return;
    }
    setBackendUp(null);
    checkBackend(backendUrl).then((ok) => {
      if (!cancelled) setBackendUp(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [needsBackend, backendUrl]);

  const canStart =
    (inputKind === 'file' && !!file) ||
    (inputKind === 'youtube' && url.trim().length > 0);

  function start() {
    if (inputKind === 'youtube') setHistory(addToHistory(url.trim()));
    const config: JobConfig = {
      input:
        inputKind === 'file'
          ? { kind: 'file', fileName: file!.name }
          : { kind: 'youtube', url: url.trim(), extraction },
      separation,
      backendBaseUrl: backendUrl.replace(/\/$/, ''),
    };
    onStart(config, inputKind === 'file' ? file : null);
  }

  return (
    <div className="panel">
      <h2>1 · Choose your source</h2>
      <div className="field">
        <Segmented
          value={inputKind}
          onChange={setInputKind}
          options={[
            { value: 'youtube', label: 'YouTube link' },
            { value: 'file', label: 'Upload file' },
          ]}
        />
      </div>

      {inputKind === 'youtube' ? (
        <>
          <div className="field">
            <label htmlFor="yturl">YouTube URL</label>
            <input
              id="yturl"
              type="url"
              placeholder="https://www.youtube.com/watch?v=…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            {history.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div className="hint" style={{ marginBottom: 4 }}>
                  Recent links:
                </div>
                <div className="row" style={{ gap: 6 }}>
                  {history.slice(0, 8).map((h) => (
                    <span key={h.url} className="chip">
                      <button
                        type="button"
                        className="chip-main"
                        title={h.url}
                        onClick={() => setUrl(h.url)}
                      >
                        {h.title || h.url.replace(/^https?:\/\/(www\.)?/, '')}
                      </button>
                      <button
                        type="button"
                        className="chip-x"
                        title="Remove"
                        onClick={() => setHistory(removeFromHistory(h.url))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="field">
            <label>Extraction engine</label>
            <Segmented
              value={extraction}
              onChange={setExtraction}
              options={[
                { value: 'backend', label: 'Backend (reliable)' },
                { value: 'browser', label: 'Browser (via proxy)' },
              ]}
            />
            {extraction === 'browser' && (
              <p className="warn" style={{ marginTop: 8 }}>
                Browser extraction still routes through the backend&apos;s CORS proxy — the
                backend must be running.
              </p>
            )}
          </div>
        </>
      ) : (
        <div className="field">
          <label>Audio file</label>
          <div
            className={`dropzone${dragging ? ' drag' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) setFile(f);
            }}
            onClick={() => document.getElementById('fileInput')?.click()}
          >
            {file ? (
              <strong>{file.name}</strong>
            ) : (
              <>Drop an MP3 / WAV / M4A here, or click to browse</>
            )}
          </div>
          <input
            id="fileInput"
            type="file"
            accept="audio/*"
            style={{ display: 'none' }}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
      )}

      <h2 style={{ marginTop: 20 }}>2 · Separation engine</h2>
      <div className="field">
        <Segmented
          value={separation}
          onChange={setSeparation}
          options={[
            { value: 'backend', label: 'Backend (native)' },
            { value: 'browser', label: 'Browser (WebGPU/WASM)' },
          ]}
        />
        <p className="hint" style={{ marginTop: 8 }}>
          {separation === 'browser'
            ? 'Runs on your device — private, no server. The htdemucs_6s model is large (~258 MB): needs a WebGPU browser (Chrome/Edge) and plenty of memory, or it may fail with an out-of-memory error. First run downloads the model, then it is cached.'
            : 'Recommended. Runs natively on the Node backend — reliable and fast (~seconds per 8 s of audio on CPU). Requires the Node server.'}
        </p>
      </div>

      {needsBackend && (
        <div className="field">
          <label htmlFor="backend">Backend URL</label>
          <input
            id="backend"
            type="text"
            value={backendUrl}
            onChange={(e) => onBackendUrlChange(e.target.value)}
          />
          <p className={backendUp === false ? 'err' : 'hint'} style={{ marginTop: 6 }}>
            {backendUp === null
              ? 'Checking backend…'
              : backendUp
                ? '✓ Backend reachable'
                : '✗ Backend not reachable — start it, or switch to browser/upload.'}
          </p>
        </div>
      )}

      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn" disabled={!canStart} onClick={start}>
          Split into stems →
        </button>
      </div>
    </div>
  );
}
