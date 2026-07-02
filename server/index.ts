/**
 * Optional Node backend for YTextractor.
 *
 * Provides: backend YouTube extraction, a CORS proxy for browser youtubei.js,
 * native stem separation as an SSE job, and a persistent on-disk library
 * (imported sources + saved separation projects).
 *
 * All responses carry `Cross-Origin-Resource-Policy: cross-origin` so the
 * cross-origin-isolated web app (COEP: require-corp) can consume them.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  separateMixture,
  STEM_NAMES,
  type SeparateEvent,
  type SeparationSession,
  type StemName,
  type StemSet,
} from '@ytx/shared';
import { BODY_LIMIT, HOST, PORT, WEB_DIR } from './config';
import { decodePcm, encodeWav } from './decode';
import { createNodeRuntime, ensureModel } from './separation.node';
import { extractAudio } from './extract.node';
import {
  createArrangement,
  createProjectShell,
  deleteArrangement,
  deleteProject,
  deleteSource,
  getArrangementBufferPath,
  getArrangementManifest,
  getProjectStemPath,
  getSource,
  getSourceThumbPath,
  listArrangements,
  listProjects,
  listSources,
  readSourceBytes,
  saveProject,
  saveSource,
  writeArrangementBuffer,
  writeProjectStemWav,
} from './library';

interface Job {
  id: string;
  emitter: EventEmitter;
  state: SeparateEvent;
  stems?: StemSet;
}

const jobs = new Map<string, Job>();

function setState(job: Job, state: SeparateEvent) {
  job.state = state;
  job.emitter.emit('event', state);
}

// Reuse a single ONNX session across jobs.
let sessionPromise: Promise<SeparationSession> | null = null;
function getSession(): Promise<SeparationSession> {
  if (!sessionPromise) {
    const runtime = createNodeRuntime();
    sessionPromise = ensureModel((m) => console.log(m)).then((path) => runtime.createSession(path));
  }
  return sessionPromise;
}

async function runSeparation(
  job: Job,
  audio: Buffer,
  meta: { title: string; sourceId?: string },
) {
  try {
    setState(job, { phase: 'extracting', percent: 100, message: 'Decoding audio…' });
    const pcm = await decodePcm(audio);

    setState(job, { phase: 'loading-model', percent: 0, message: 'Loading model…' });
    const session = await getSession();
    const engine = createNodeRuntime().engine;

    setState(job, { phase: 'separating', percent: 0, engine });
    const set = await separateMixture(pcm.channels, session, {
      overlap: 0.25,
      onProgress: (f) =>
        setState(job, { phase: 'separating', percent: Math.round(f * 100), engine }),
    });
    job.stems = set;

    // Persist the project to the library.
    let projectId: string | undefined;
    try {
      const project = await saveProject(set, {
        title: meta.title,
        sourceId: meta.sourceId,
        engine,
      });
      projectId = project.id;
    } catch (e) {
      console.error('Failed to save project:', e);
    }

    setState(job, {
      phase: 'ready',
      percent: 100,
      engine,
      stems: STEM_NAMES as unknown as StemName[],
      sampleRate: set.sampleRate,
      projectId,
    });
  } catch (err) {
    setState(job, {
      phase: 'error',
      percent: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function main() {
  const app = Fastify({ bodyLimit: BODY_LIMIT, logger: true });
  await app.register(cors, {
    origin: true,
    exposedHeaders: ['Content-Type', 'X-Audio-Title', 'Content-Disposition'],
  });

  // Treat every request body as a raw Buffer (audio uploads, proxied bodies, JSON).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // Cross-origin isolation: COOP+COEP make the served UI cross-origin isolated
  // (SharedArrayBuffer for onnxruntime-web threads + the AudioWorklet recorder);
  // CORP lets a separately-hosted cross-origin web app read these responses too.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Embedder-Policy', 'credentialless');
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    return payload;
  });

  const parseJson = <T,>(body: unknown): T | null => {
    try {
      return JSON.parse((body as Buffer).toString()) as T;
    } catch {
      return null;
    }
  };

  app.get('/health', async () => ({ ok: true }));

  /* ---------------- CORS proxy for browser youtubei.js ---------------- */
  const proxyHandler = async (req: any, reply: any) => {
    const target = req.query?.url as string | undefined;
    if (!target) return reply.code(400).send('Missing url');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (['host', 'connection', 'content-length', 'origin', 'referer'].includes(k)) continue;
      if (typeof v === 'string') headers[k] = v;
    }
    const method = req.method;
    const body = method === 'GET' || method === 'HEAD' ? undefined : (req.body as Buffer);
    const upstream = await fetch(target, { method, headers, body });
    const buf = Buffer.from(await upstream.arrayBuffer());
    reply.code(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) reply.header('Content-Type', ct);
    return reply.send(buf);
  };
  app.route({ method: ['GET', 'POST'], url: '/proxy', handler: proxyHandler });

  /* ---------------- Library: sources ---------------- */

  // Import a YouTube URL: extract + persist as a source.
  app.post('/library/import', async (req, reply) => {
    const body = parseJson<{ url: string }>(req.body);
    if (!body?.url) return reply.code(400).send('Missing url');
    const { bytes, info, ext, thumb } = await extractAudio(body.url);
    const source = await saveSource({
      bytes,
      title: info.title,
      origin: 'youtube',
      url: body.url,
      durationSeconds: info.durationSeconds,
      ext,
      mimeType: info.mimeType,
      thumb,
      uploader: info.uploader,
      viewCount: info.viewCount,
      likeCount: info.likeCount,
      uploadDate: info.uploadDate,
    });
    return reply.send(source);
  });

  // Upload an audio file: persist as a source.
  app.post('/library/upload', async (req, reply) => {
    const audio = req.body as Buffer;
    if (!audio || audio.length === 0) return reply.code(400).send('Empty audio body');
    const title = decodeURIComponent((req.headers['x-title'] as string) || 'Uploaded audio');
    const ext = ((req.headers['x-ext'] as string) || 'audio').toLowerCase();
    const mimeType = (req.headers['content-type'] as string) || 'audio/octet-stream';
    const source = await saveSource({ bytes: audio, title, origin: 'file', ext, mimeType });
    return reply.send(source);
  });

  app.get('/library/sources', async () => listSources());

  app.get('/library/sources/:id/audio', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = await getSource(id);
    if (!found) return reply.code(404).send('Unknown source');
    const bytes = await readFile(found.audioPath);
    return reply
      .header('Content-Type', found.meta.mimeType)
      .header('Content-Disposition', `inline; filename="${found.meta.id}.${found.meta.ext}"`)
      .send(bytes);
  });

  app.get('/library/sources/:id/thumb', async (req, reply) => {
    const { id } = req.params as { id: string };
    const path = await getSourceThumbPath(id);
    if (!path) return reply.code(404).send('No thumbnail');
    const bytes = await readFile(path);
    return reply
      .header('Content-Type', 'image/jpeg')
      .header('Cache-Control', 'public, max-age=86400')
      .send(bytes);
  });

  app.delete('/library/sources/:id', async (req, reply) => {
    await deleteSource((req.params as { id: string }).id);
    return reply.send({ ok: true });
  });

  /* ---------------- Library: projects ---------------- */

  app.get('/library/projects', async () => listProjects());

  app.get('/library/projects/:id/stems/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const path = await getProjectStemPath(id, name);
    if (!path) return reply.code(404).send('Unknown project stem');
    const wav = await readFile(path);
    return reply.header('Content-Type', 'audio/wav').send(wav);
  });

  // Create a project shell for browser-separated stems (uploaded via PUT below).
  app.post('/library/projects', async (req, reply) => {
    const body = parseJson<{
      title: string;
      engine: string;
      sampleRate: number;
      numChannels: number;
      lengthSamples: number;
      stems: StemName[];
    }>(req.body);
    if (!body?.title) return reply.code(400).send('Missing project meta');
    const project = await createProjectShell({
      title: body.title,
      engine: body.engine || 'browser',
      sampleRate: body.sampleRate,
      numChannels: body.numChannels,
      lengthSamples: body.lengthSamples,
      stems: body.stems ?? (STEM_NAMES as unknown as StemName[]),
    });
    return reply.send(project);
  });

  app.put('/library/projects/:id/stems/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const wav = req.body as Buffer;
    if (!wav || wav.length === 0) return reply.code(400).send('Empty stem body');
    const ok = await writeProjectStemWav(id, name, wav);
    if (!ok) return reply.code(404).send('Unknown project');
    return reply.send({ ok: true });
  });

  app.delete('/library/projects/:id', async (req, reply) => {
    await deleteProject((req.params as { id: string }).id);
    return reply.send({ ok: true });
  });

  /* ---------------- Library: arrangements (editable clip layouts) ---------------- */

  app.get('/library/arrangements', async () => listArrangements());

  app.post('/library/arrangements', async (req, reply) => {
    const manifest = parseJson<Record<string, unknown>>(req.body);
    if (!manifest) return reply.code(400).send('Invalid manifest');
    const { id } = await createArrangement(manifest);
    return reply.send({ id });
  });

  app.get('/library/arrangements/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const manifest = await getArrangementManifest(id);
    if (!manifest) return reply.code(404).send('Unknown arrangement');
    return reply.send(manifest);
  });

  app.put('/library/arrangements/:id/buffers/:bufferId', async (req, reply) => {
    const { id, bufferId } = req.params as { id: string; bufferId: string };
    const wav = req.body as Buffer;
    if (!wav || wav.length === 0) return reply.code(400).send('Empty buffer');
    const ok = await writeArrangementBuffer(id, bufferId, wav);
    if (!ok) return reply.code(404).send('Unknown arrangement or bad buffer id');
    return reply.send({ ok: true });
  });

  app.get('/library/arrangements/:id/buffers/:bufferId', async (req, reply) => {
    const { id, bufferId } = req.params as { id: string; bufferId: string };
    const path = await getArrangementBufferPath(id, bufferId);
    if (!path) return reply.code(404).send('Unknown buffer');
    const wav = await readFile(path);
    return reply.header('Content-Type', 'audio/wav').send(wav);
  });

  app.delete('/library/arrangements/:id', async (req, reply) => {
    await deleteArrangement((req.params as { id: string }).id);
    return reply.send({ ok: true });
  });

  /* ---------------- Native separation job ---------------- */

  app.post('/separate', async (req, reply) => {
    const ct = (req.headers['content-type'] as string) || '';
    let audio: Buffer;
    let title = 'audio';
    let sourceId: string | undefined;

    if (ct.includes('application/json')) {
      const body = parseJson<{ sourceId: string }>(req.body);
      if (!body?.sourceId) return reply.code(400).send('Missing sourceId');
      const bytes = await readSourceBytes(body.sourceId);
      if (!bytes) return reply.code(404).send('Unknown source');
      const src = await getSource(body.sourceId);
      audio = bytes;
      sourceId = body.sourceId;
      title = src?.meta.title ?? 'audio';
    } else {
      audio = req.body as Buffer;
      if (!audio || audio.length === 0) return reply.code(400).send('Empty audio body');
      // Persist the uploaded audio as a source so the project can reference it.
      const uploadTitle = decodeURIComponent(
        (req.headers['x-title'] as string) || 'Uploaded audio',
      );
      const ext = ((req.headers['x-ext'] as string) || 'audio').toLowerCase();
      const src = await saveSource({
        bytes: audio,
        title: uploadTitle,
        origin: 'file',
        ext,
        mimeType: ct || 'audio/octet-stream',
      });
      sourceId = src.id;
      title = uploadTitle;
    }

    const job: Job = {
      id: randomUUID(),
      emitter: new EventEmitter(),
      state: { phase: 'extracting', percent: 0 },
    };
    job.emitter.setMaxListeners(0);
    jobs.set(job.id, job);
    void runSeparation(job, audio, { title, sourceId });
    return reply.send({ jobId: job.id });
  });

  app.get('/separate/:id/events', (req, reply) => {
    const { id } = req.params as { id: string };
    const job = jobs.get(id);
    if (!job) {
      reply.code(404).send('Unknown job');
      return;
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    const send = (e: SeparateEvent) => raw.write(`data: ${JSON.stringify(e)}\n\n`);
    send(job.state);
    if (job.state.phase === 'ready' || job.state.phase === 'error') {
      raw.end();
      return;
    }
    const listener = (e: SeparateEvent) => {
      send(e);
      if (e.phase === 'ready' || e.phase === 'error') raw.end();
    };
    job.emitter.on('event', listener);
    req.raw.on('close', () => job.emitter.off('event', listener));
  });

  app.get('/separate/:id/stems/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: StemName };
    const job = jobs.get(id);
    if (!job?.stems) return reply.code(404).send('Stems not ready');
    const stem = job.stems.stems.find((s) => s.name === name);
    if (!stem) return reply.code(404).send('Unknown stem');
    const wav = encodeWav(stem.channels, job.stems.sampleRate);
    return reply.header('Content-Type', 'audio/wav').send(wav);
  });

  // Desktop/monolith: serve the static web bundle on our own origin if present.
  if (existsSync(WEB_DIR)) {
    await app.register(fastifyStatic, { root: WEB_DIR, index: ['index.html'] });
    app.log.info(`Serving web UI from ${WEB_DIR}`);
  }

  await app.listen({ port: PORT, host: HOST });
  console.log(`YTextractor backend listening on http://localhost:${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
