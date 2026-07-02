// YTextractor desktop (Electron). Runs the bundled Fastify backend in a separate
// utility process — so heavy work (YouTube import, native stem separation) never
// blocks the window's UI thread — and opens a window pointed at it. Running
// locally means yt-dlp uses the user's own (residential) IP, so YouTube import
// works without cookies/proxies.
import { app, BrowserWindow, dialog, shell, utilityProcess } from 'electron';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.YTX_PORT ?? 8787);
const BASE = `http://127.0.0.1:${PORT}`;

// Per-user storage: library, model cache, scratch, and the yt-dlp binary.
const dataDir = join(app.getPath('userData'), 'data');
for (const d of ['library', 'models', 'tmp', 'bin']) {
  mkdirSync(join(dataDir, d), { recursive: true });
}

// Environment handed to the backend process.
const backendEnv = {
  ...process.env,
  PORT: String(PORT),
  HOST: '127.0.0.1', // local only — not exposed on the network
  LIBRARY_DIR: join(dataDir, 'library'),
  MODEL_DIR: join(dataDir, 'models'),
  TMP_DIR: join(dataDir, 'tmp'),
  YTDLP_DIR: join(dataDir, 'bin'), // yt-dlp(.exe) auto-downloads here on first use
  WEB_DIR: app.isPackaged ? join(process.resourcesPath, 'web') : join(here, '..', 'web', 'out'),
};

let backend = null;

function startBackend() {
  // A dedicated Node process: its CPU-heavy work can't freeze the UI/window.
  backend = utilityProcess.fork(join(here, 'dist', 'backend.mjs'), [], { env: backendEnv });

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    backend.on('exit', (code) => done(reject, new Error(`backend exited (${code})`)));
    (async () => {
      for (let i = 0; i < 150; i++) {
        try {
          const r = await fetch(`${BASE}/health`);
          if (r.ok) return done(resolve);
        } catch {
          /* backend not listening yet */
        }
        await new Promise((res) => setTimeout(res, 200));
      }
      done(reject, new Error('backend failed to start'));
    })();
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  void win.loadURL(BASE);
  // External links (help, YouTube) open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // The web app's `beforeunload` (unsaved-changes guard) fires this only when
  // there ARE unsaved edits — Electron would otherwise silently cancel the close
  // (dead X button). Ask the user with a native dialog instead. With no unsaved
  // changes this never fires and the window closes immediately.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Sair', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      title: 'Alterações não salvas',
      message: 'Há alterações não salvas no editor.',
      detail: 'Se sair agora, elas serão perdidas.',
    });
    if (choice === 0) e.preventDefault(); // "Sair" → allow the close to proceed
  });
}

app.whenReady().then(async () => {
  await startBackend();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
// Tear down the backend process, then make sure we really exit.
app.on('before-quit', () => {
  try {
    backend?.kill();
  } catch {
    /* already gone */
  }
});
app.on('quit', () => process.exit(0));
