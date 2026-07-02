// Bundle the Fastify backend (TypeScript, + the @ytx/shared TS package) into a
// single ESM file the Electron main process imports. Native / hard-to-bundle
// packages stay external and are shipped as real node_modules (see asarUnpack
// + dependencies in package.json).
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(here, '..', 'server', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: join(here, 'dist', 'backend.mjs'),
  // Keep the native + heavyweight deps external; @ytx/shared is bundled inline.
  external: [
    'onnxruntime-node',
    'ffmpeg-static',
    'fastify',
    '@fastify/cors',
    '@fastify/static',
    'youtubei.js',
  ],
  // Some CJS externals expect require() to exist in the ESM output.
  banner: {
    js: "import { createRequire as _cr } from 'module'; const require = _cr(import.meta.url);",
  },
  logLevel: 'info',
});

console.log('backend bundled → dist/backend.mjs');
