import type { NextConfig } from 'next';

/**
 * onnxruntime-web needs SharedArrayBuffer for WASM threads/SIMD, which requires
 * the page to be cross-origin isolated. These headers set that up; the model
 * and any cross-origin assets must be served with a compatible CORP.
 */
// `credentialless` keeps the page cross-origin isolated (crossOriginIsolated ===
// true → SharedArrayBuffer for onnxruntime-web threads + the AudioWorklet
// recorder) while allowing cross-origin subresources without CORP — needed so
// smplr can load its General-MIDI samples from its CDN. Chrome/Edge only.
const crossOriginIsolationHeaders = [
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
];

// For the desktop (Electron) build we export a static bundle that the packaged
// Fastify server serves locally; the web deploy keeps the normal Next server.
const desktop = process.env.BUILD_TARGET === 'desktop';

const nextConfig: NextConfig = {
  // Transpile the shared TS workspace package (published as raw source).
  transpilePackages: ['@ytx/shared'],
  ...(desktop ? { output: 'export' as const, images: { unoptimized: true } } : {}),
  async headers() {
    return [
      {
        source: '/:path*',
        headers: crossOriginIsolationHeaders,
      },
    ];
  },
  webpack(config) {
    // onnxruntime-web ships .wasm/.mjs assets; let webpack leave Node core
    // modules alone (they are only referenced by the node build path).
    config.resolve = config.resolve ?? {};
    config.resolve.fallback = {
      ...(config.resolve.fallback ?? {}),
      fs: false,
      path: false,
      crypto: false,
    };
    return config;
  },
};

export default nextConfig;
