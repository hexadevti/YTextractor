/**
 * Stateless cloud stem-separation service.
 *
 * One job: receive audio, separate into 6 stems with htdemucs_6s (GPU/CUDA when
 * available, CPU fallback), return the stems as lossless FLAC. No library, no
 * YouTube, no persistence — the app keeps its own library (IndexedDB/OPFS on
 * web, filesystem on desktop) and just calls this for the heavy compute.
 *
 * Deployable to Modal (@modal.web_server) or a RunPod Pod — see README.md.
 *
 * Response ("framed" binary, so the browser needs no unzip dependency):
 *   repeat 6×:  [nameLen u32le][name utf8][dataLen u32le][flac bytes]
 *   headers: X-Sample-Rate, X-Stem-Names, X-Engine
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import { parseStemList, separateMixture, type SeparationSession, type StemSet } from '@prismaxim/shared';
import { decodePcm, encodeFlac } from './encode';
import { createSession } from './runtime';

const here = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const BODY_LIMIT = Number(process.env.BODY_LIMIT ?? 300 * 1024 * 1024);
const MODEL_FILE = process.env.MODEL_FILE ?? join(here, '..', 'server', 'models', 'htdemucs_6s.onnx');
const CLOUD_TOKEN = process.env.CLOUD_TOKEN ?? '';
// Fewer windows than Demucs' 0.25 default; ~negligible audible difference.
const OVERLAP = Math.min(Math.max(Number(process.env.SEPARATION_OVERLAP ?? 0.1), 0), 0.9);

// Reuse a single ONNX session across requests (creation/optimization is costly).
let sessionPromise: Promise<{ session: SeparationSession; engine: string }> | null = null;
function getSession() {
  if (!sessionPromise) sessionPromise = createSession(MODEL_FILE);
  return sessionPromise;
}

/** Serialize a StemSet's FLAC-encoded stems into the framed binary body. */
async function frameStems(set: StemSet): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const stem of set.stems) {
    const flac = await encodeFlac(stem.channels, set.sampleRate);
    const name = Buffer.from(stem.name, 'utf8');
    // Framing: [nameLen u32le][name][dataLen u32le][flac] — matches cloud.ts.
    const nameLen = Buffer.alloc(4);
    nameLen.writeUInt32LE(name.length, 0);
    const dataLen = Buffer.alloc(4);
    dataLen.writeUInt32LE(flac.length, 0);
    parts.push(nameLen, name, dataLen, flac);
  }
  return Buffer.concat(parts);
}

async function main() {
  const app = Fastify({ bodyLimit: BODY_LIMIT, logger: true });
  // Treat every request body as a raw Buffer (audio uploads).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // Let a cross-origin (isolated) web app read our responses.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Expose-Headers', 'X-Sample-Rate, X-Stem-Names, X-Engine');
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    return payload;
  });
  app.options('/*', async (_req, reply) => {
    reply
      .header('Access-Control-Allow-Origin', '*')
      .header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      .header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Title, X-Ext, X-Stems')
      .code(204)
      .send();
  });

  app.get('/health', async () => {
    // Touch the session so a warm container reports its real engine.
    const engine = sessionPromise ? (await sessionPromise).engine : 'cold';
    return { ok: true, engine };
  });

  app.post('/separate', async (req, reply) => {
    if (CLOUD_TOKEN) {
      const auth = (req.headers['authorization'] as string) || '';
      if (auth !== `Bearer ${CLOUD_TOKEN}`) return reply.code(401).send('Unauthorized');
    }
    const audio = req.body as Buffer;
    if (!audio || audio.length === 0) return reply.code(400).send('Empty audio body');

    // Optional stem selection: encode/return only these (absent = all 6).
    const include = parseStemList(req.headers['x-stems'] as string | undefined);

    const t0 = Date.now();
    const pcm = await decodePcm(audio);
    const { session, engine } = await getSession();
    const set = await separateMixture(pcm.channels, session, { overlap: OVERLAP, include });
    const body = await frameStems(set);
    app.log.info(
      `separated ${(audio.length / 1e6).toFixed(1)}MB → ${set.stems.length} stems in ${Date.now() - t0}ms on ${engine}`,
    );

    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('X-Sample-Rate', String(set.sampleRate))
      .header('X-Stem-Names', set.stems.map((s) => s.name).join(','))
      .header('X-Engine', engine)
      .send(body);
  });

  await app.listen({ port: PORT, host: HOST });
  console.log(`Prismaxim cloud separator on http://localhost:${PORT} (model: ${MODEL_FILE})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
