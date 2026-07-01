import type { NextConfig } from 'next';

/**
 * onnxruntime-web needs SharedArrayBuffer for WASM threads/SIMD, which requires
 * the page to be cross-origin isolated. These headers set that up; the model
 * and any cross-origin assets must be served with a compatible CORP.
 */
const crossOriginIsolationHeaders = [
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
];

const nextConfig: NextConfig = {
  // Transpile the shared TS workspace package (published as raw source).
  transpilePackages: ['@ytx/shared'],
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
