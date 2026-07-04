import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor wraps the Next.js static export in a native iOS/Android shell.
 *
 * `webDir` points at the same `web/out` bundle the desktop app ships — produced
 * by `npm run build:mobile` at the repo root (BUILD_TARGET=mobile → static
 * export). The bundle is copied into the native project by `cap sync`, so the
 * app loads locally (no `server.url`, works offline; separation calls the cloud
 * service at runtime — see web/lib/config.ts).
 */
const config: CapacitorConfig = {
  appId: 'com.prismaxim.app',
  appName: 'Prismaxim',
  webDir: '../web/out',
  server: {
    // Serve the local bundle over https:// on Android (avoids mixed-content and
    // matches iOS' capacitor:// origin semantics for OPFS/IndexedDB persistence).
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#0b0d10',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0b0d10',
    },
  },
};

export default config;
