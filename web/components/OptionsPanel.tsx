'use client';

import { useEffect, useState } from 'react';
import { checkBackend } from '@/lib/engines/client';

export default function OptionsPanel({
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
            ? 'Checking backend…'
            : up
              ? '✓ Backend reachable'
              : '✗ Backend not reachable — start it with `npm run dev:server`, or work browser-only.'}
        </p>
      </div>
      <p className="hint">
        The backend powers YouTube import, native (faster) separation, the library, and saving
        edited projects. Without it, use <strong>file upload</strong> + <strong>browser</strong>{' '}
        separation — no server needed.
      </p>
    </div>
  );
}
