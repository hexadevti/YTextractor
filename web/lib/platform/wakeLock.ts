/**
 * Keep the screen awake while a long job runs.
 *
 * On mobile the WebView is suspended when the phone auto-locks the screen — which
 * aborts an in-flight cloud separation (a single multi-minute `fetch`, see
 * lib/engines/cloud.ts) and interrupts the import. Holding a screen wake lock for
 * the duration of a job prevents the idle screen-lock so the request survives.
 *
 * Uses the standard Screen Wake Lock API (`navigator.wakeLock`), which is
 * available in the Capacitor Android WebView (Chromium, secure `https://` origin
 * — see mobile/capacitor.config.ts) and the iOS 16.4+ WKWebView, as well as
 * desktop/mobile browsers. Where it's unavailable it degrades to a no-op.
 *
 * The browser auto-releases the lock whenever the page is hidden, so we re-acquire
 * it on `visibilitychange` — this matters on the pure-web build if the user
 * briefly switches tabs; on mobile the screen simply never locks while held.
 */

// Minimal local typing so this compiles regardless of the DOM lib's WakeLock defs.
interface WakeLockSentinelLike {
  release(): Promise<void>;
}
interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

/** Release the wake lock acquired by {@link keepScreenAwake}. Safe to call twice. */
export type ReleaseWakeLock = () => void;

const NOOP: ReleaseWakeLock = () => {};

/**
 * Acquire a screen wake lock for the duration of a job. Always resolves (never
 * throws — a denied or unsupported lock just yields a no-op release). Call the
 * returned function in a `finally` so the lock is always freed.
 */
export function keepScreenAwake(): ReleaseWakeLock {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return NOOP;
  const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
  if (!wakeLock) return NOOP;

  let sentinel: WakeLockSentinelLike | null = null;
  let released = false;

  const acquire = () => {
    if (released || document.visibilityState !== 'visible') return;
    wakeLock.request('screen').then(
      (s) => {
        if (released) void s.release();
        else sentinel = s;
      },
      () => {
        /* denied / not allowed — leave as a no-op */
      },
    );
  };

  const onVisibility = () => {
    if (document.visibilityState === 'visible') acquire();
  };
  document.addEventListener('visibilitychange', onVisibility);
  acquire();

  return () => {
    if (released) return;
    released = true;
    document.removeEventListener('visibilitychange', onVisibility);
    void sentinel?.release().catch(() => {});
    sentinel = null;
  };
}
