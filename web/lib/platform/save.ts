/**
 * Save a Blob to the user's device, adapting to the build target.
 *
 *  - web / desktop: a normal browser download (object URL + synthetic <a> click).
 *  - mobile (Capacitor): WKWebView/Android WebView have no `a.click()` download,
 *    so we write the file into the app's Cache directory and hand its file URI to
 *    the native share sheet (Files, AirDrop, other apps). The Capacitor plugins
 *    are dynamically imported so they never load in the web/desktop bundles.
 *
 * `downloadBlob` (lib/mixer/export.ts) delegates here, so every existing
 * "Export WAV/MP3" / download button routes through this automatically.
 */

import { IS_MOBILE } from '../env';

/** Browser download via an object URL + synthetic anchor click. */
function browserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Read a Blob as a bare base64 string (no `data:...;base64,` prefix). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Persist `blob` under `filename`. On mobile this opens the native share sheet;
 * elsewhere it triggers a browser download. Resolves once the file is handed off
 * (the mobile share sheet is fire-and-forget from the UI's perspective).
 */
export async function saveOrShare(blob: Blob, filename: string): Promise<void> {
  if (!IS_MOBILE) {
    browserDownload(blob, filename);
    return;
  }

  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);

  const data = await blobToBase64(blob);
  const written = await Filesystem.writeFile({ path: filename, data, directory: Directory.Cache });
  await Share.share({ title: filename, url: written.uri, dialogTitle: 'Save or share' });
}
