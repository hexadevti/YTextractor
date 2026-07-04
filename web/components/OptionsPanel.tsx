'use client';

import { useEffect, useState } from 'react';
import { Mic } from 'lucide-react';
import { checkBackend } from '@/lib/engines/client';
import { checkCloud } from '@/lib/engines/cloud';
import { getCloudUrl } from '@/lib/cloudConfig';
import { getDesktopBridge, type UpdateStatus } from '@/lib/desktop';
import { IS_DESKTOP, IS_MOBILE } from '@/lib/env';
import { requestPermission } from '@/lib/editor/devices';
import { store } from '@/lib/store';

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

/** Optional cloud "fast mode" endpoint — configured via site env vars (read-only). */
function CloudOptions() {
  const url = getCloudUrl();
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => {
    if (!url) {
      setReachable(null);
      return;
    }
    let cancelled = false;
    setReachable(null);
    checkCloud(url).then((ok) => {
      if (!cancelled) setReachable(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className="field">
      <label>Cloud separation (optional, &quot;fast mode&quot;)</label>
      <p className={reachable === false ? 'err' : 'hint'}>
        {!url
          ? 'Not configured. Set NEXT_PUBLIC_CLOUD_SEPARATE_URL (and NEXT_PUBLIC_CLOUD_TOKEN if the endpoint needs one) in the site environment to enable the “Cloud (fast)” toggle on Import.'
          : reachable === null
            ? `Checking ${url}…`
            : reachable
              ? `✓ Cloud endpoint reachable — ${url}`
              : `✗ Cloud endpoint not reachable — ${url}`}
      </p>
    </div>
  );
}

/** Turn electron-updater's verbose errors (HTTP headers, stack traces) into one readable line. */
function friendlyUpdateError(raw: string): string {
  const s = raw ?? '';
  if (/latest\.yml/i.test(s) || /Cannot find .*release/i.test(s))
    return 'The latest release doesn’t include update information yet — this clears once a newer version is published with auto-update support.';
  if (/ENOTFOUND|getaddrinfo|ETIMEDOUT|net::|ECONNREFUSED|EAI_AGAIN/i.test(s))
    return 'Couldn’t reach GitHub. Check your internet connection and try again.';
  if (/rate limit/i.test(s)) return 'GitHub rate limit reached. Please try again in a few minutes.';
  // Fallback: first line only, capped so a raw dump never floods the panel.
  const first = (s.split('\n')[0] ?? '').trim();
  return first.length > 160 ? `${first.slice(0, 160)}…` : first || 'Update check failed.';
}

/** Desktop only: check GitHub for a new release and update in one click. */
function UpdateSection() {
  const bridge = getDesktopBridge();
  const [version, setVersion] = useState<string | null>(null);
  const [state, setState] = useState<UpdateStatus>({ status: 'checking' });

  useEffect(() => {
    if (!bridge) return;
    bridge.updates.getVersion().then(setVersion).catch(() => {});
    const off = bridge.updates.onEvent(setState);
    // Check once when the panel opens, so an available update shows immediately.
    bridge.updates.check().catch(() => {});
    return off;
  }, [bridge]);

  // Not running inside the Electron app (e.g. `next dev`): nothing to update.
  if (!bridge) return null;

  const check = () => {
    setState({ status: 'checking' });
    bridge.updates.check().catch(() => {});
  };
  const download = () => {
    setState({ status: 'downloading', percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
    bridge.updates.download().catch(() => {});
  };
  const install = () => void bridge.updates.install();

  return (
    <div className="field">
      <label>App version &amp; updates</label>
      <p className="hint" style={{ marginBottom: 10 }}>
        Current version: <strong>{version ?? '…'}</strong>
      </p>

      {state.status === 'checking' && <p className="hint">Checking for updates…</p>}

      {state.status === 'not-available' && (
        <>
          <p className="hint">✓ You’re on the latest version.</p>
          <button className="btn secondary" onClick={check} style={{ marginTop: 10 }}>
            Check again
          </button>
        </>
      )}

      {state.status === 'available' && (
        <>
          <p className="hint">
            A new version{state.version ? ` (${state.version})` : ''} is available.
          </p>
          <button className="btn" onClick={download} style={{ marginTop: 10 }}>
            Download &amp; install
          </button>
        </>
      )}

      {state.status === 'downloading' && (
        <div className="progress-wrap">
          <div className="phase-label">
            <span>Downloading update…</span>
            <span className="engine">{Math.round(state.percent)}%</span>
          </div>
          <div className="bar">
            <span style={{ width: `${Math.max(2, state.percent)}%` }} />
          </div>
          {state.total > 0 && (
            <p className="hint" style={{ marginTop: 6 }}>
              {fmtBytes(state.transferred)} of {fmtBytes(state.total)}
              {state.bytesPerSecond > 0 ? ` · ${fmtBytes(state.bytesPerSecond)}/s` : ''}
            </p>
          )}
        </div>
      )}

      {state.status === 'downloaded' && (
        <>
          <p className="hint">
            ✓ Update{state.version ? ` ${state.version}` : ''} downloaded — restart to finish.
          </p>
          <button className="btn" onClick={install} style={{ marginTop: 10 }}>
            Restart &amp; install
          </button>
        </>
      )}

      {state.status === 'error' && (
        <>
          <p className="err">{friendlyUpdateError(state.error)}</p>
          <button className="btn secondary" onClick={check} style={{ marginTop: 10 }}>
            Try again
          </button>
        </>
      )}
    </div>
  );
}

/** Desktop: configure/monitor the local backend. */
function DesktopOptions({
  backendUrl,
  onBackendUrlChange,
}: {
  backendUrl: string;
  onBackendUrlChange: (v: string) => void;
}) {
  const [up, setUp] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUp(null);
    checkBackend(backendUrl).then((ok) => {
      if (!cancelled) setUp(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [backendUrl]);

  return (
    <div className="panel">
      <h2>Options</h2>
      <div className="field">
        <label htmlFor="backend">Backend URL</label>
        <input
          id="backend"
          type="text"
          value={backendUrl}
          onChange={(e) => onBackendUrlChange(e.target.value)}
          placeholder="http://localhost:8787"
        />
        <p className={up === false ? 'err' : 'hint'} style={{ marginTop: 6 }}>
          {up === null
            ? 'Checking service…'
            : up
              ? '✓ Service reachable'
              : '✗ Service not reachable — restart the app (or start it with `npm run dev:server`).'}
        </p>
      </div>
      <p className="hint">
        The local service powers YouTube import, native stem separation, the library, and saving
        edited projects. It starts automatically with the app.
      </p>
      <UpdateSection />
    </div>
  );
}

/** Mobile: microphone permission for editor recording. On mobile the audio I/O
 *  lives here (device/output selection isn't available in a WebView), so the
 *  editor's Audio I/O bar is hidden and recording asks for the mic on demand. */
function MicOptions() {
  const [state, setState] = useState<'idle' | 'checking' | 'granted' | 'denied'>('idle');
  const enable = async () => {
    setState('checking');
    try {
      const stream = await requestPermission();
      stream?.getTracks().forEach((t) => t.stop());
      setState(stream ? 'granted' : 'denied');
    } catch {
      setState('denied');
    }
  };
  return (
    <div className="field">
      <label>Audio input (microphone)</label>
      <p className={state === 'denied' ? 'err' : 'hint'} style={{ marginTop: 6, marginBottom: 8 }}>
        {state === 'granted'
          ? '✓ Microphone enabled — you can record tracks in the editor.'
          : state === 'denied'
            ? '✗ Microphone blocked. Allow it in your device settings, then try again.'
            : 'Grant microphone access to record audio tracks in the editor.'}
      </p>
      {state !== 'granted' && (
        <button className="btn secondary" onClick={enable} disabled={state === 'checking'}>
          <Mic size={15} /> {state === 'checking' ? 'Requesting…' : 'Enable microphone'}
        </button>
      )}
    </div>
  );
}

/** Web: 100% in-browser — report engine + local storage usage. */
function WebOptions() {
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const [hasWebGPU, setHasWebGPU] = useState<boolean | null>(null);

  useEffect(() => {
    setHasWebGPU(typeof navigator !== 'undefined' && !!navigator.gpu);
    store.estimate?.().then(setUsage).catch(() => {});
  }, []);

  return (
    <div className="panel">
      <h2>Options</h2>
      {/* WebGPU only applies to the pure-web build; a mobile WebView has none. */}
      {!IS_MOBILE && (
        <div className="field">
          <label>Separation engine</label>
          <p className={hasWebGPU === false ? 'warn' : 'hint'} style={{ marginTop: 6 }}>
            {hasWebGPU === null
              ? 'Runs in your browser.'
              : hasWebGPU
                ? '✓ WebGPU — fast in-browser separation.'
                : '⚠ WebGPU unavailable — falls back to WASM (much slower). Use Chrome/Edge.'}
          </p>
        </div>
      )}
      <div className="field">
        <label>Local storage</label>
        <p className="hint" style={{ marginTop: 6 }}>
          {usage
            ? `Using ${fmtBytes(usage.usage)}${usage.quota ? ` of ~${fmtBytes(usage.quota)} available` : ''}.`
            : 'Your library (songs, stems, edited projects) is saved on this device.'}
        </p>
      </div>
      {IS_MOBILE && <MicOptions />}
      {!IS_MOBILE && (
        <p className="hint">
          Everything runs locally — no server. Audio never leaves your machine. Best in Chrome/Edge.
        </p>
      )}
      <CloudOptions />
    </div>
  );
}

export default function OptionsPanel({
  backendUrl,
  onBackendUrlChange,
}: {
  backendUrl: string;
  onBackendUrlChange: (v: string) => void;
}) {
  return IS_DESKTOP ? (
    <DesktopOptions backendUrl={backendUrl} onBackendUrlChange={onBackendUrlChange} />
  ) : (
    <WebOptions />
  );
}
