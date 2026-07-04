/**
 * Build-target flag. The same `web/` code ships three ways:
 *  - the pure web deploy (100% browser: WebGPU separation, IndexedDB/OPFS
 *    library, upload-only),
 *  - the Electron desktop app (bundles the Node backend: native separation,
 *    YouTube import, filesystem library), and
 *  - the Capacitor mobile app (iOS/Android): same in-browser runtime as the web
 *    build, but separation defaults to the cloud service (WebView has no WebGPU
 *    and no SharedArrayBuffer, so on-device is single-threaded/experimental) and
 *    downloads go through the native share sheet.
 *
 * `NEXT_PUBLIC_BUILD_TARGET` is injected at build time by next.config.ts
 * (`desktop`, `mobile`, or `web`).
 */
export const IS_DESKTOP = process.env.NEXT_PUBLIC_BUILD_TARGET === 'desktop';

/** True in the Capacitor iOS/Android build (a specialization of the web build). */
export const IS_MOBILE = process.env.NEXT_PUBLIC_BUILD_TARGET === 'mobile';

/**
 * True in any pure-browser build (no Node backend) — covers both the web deploy
 * and the mobile app, so both reuse the in-browser separation + IndexedDB/OPFS
 * store. Use IS_MOBILE for the mobile-only tweaks (native share, permissions,
 * on-device gating).
 */
export const IS_WEB = !IS_DESKTOP;
