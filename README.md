# 🎛 YTextractor — Stem Splitter & Studio Mixer

Extract audio from a **YouTube link** or an **uploaded file**, split it into 6 stems with
**Demucs (`htdemucs_6s`)**, and remix in a **studio-style browser mixer** — per-track waveform +
live spectrum, mute / solo / remove, one-click Karaoke & Solo-practice presets, and export your
custom mix to WAV / MP3.

Both heavy operations are **selectable per job**:

| | Browser | Backend |
|---|---|---|
| **YouTube extraction** | youtubei.js + CORS proxy* | yt-dlp (auto-downloaded), youtubei.js fallback |
| **Separation** | onnxruntime-web (WebGPU/WASM) | onnxruntime-node (native CPU, optional DirectML) |

Plus **file upload** as a third input that needs no extraction. The mixer always runs in the
browser and consumes the same stems regardless of where separation ran.

\* Browser YouTube extraction still routes through the backend's `/proxy` (there is no truly
serverless YouTube fetch). The **upload path always works** with no backend.

## Layout

```
shared/   runtime-agnostic TS: Demucs pipeline, stem defs, types (used by web + server)
web/      Next.js (React/TS) frontend + browser engines + Web Audio mixer
server/   optional Node/TS (Fastify) backend: extraction, CORS proxy, native separation
```

## Prerequisites

- **Node 20+** (Node 22 recommended). No Python, no system ffmpeg (the backend bundles ffmpeg
  via `ffmpeg-static`).
- A **Chromium browser** (Chrome/Edge) is recommended for browser separation (WebGPU).

## Install

```bash
npm install        # installs all workspaces
```

## Run

```bash
# frontend (required)
npm run dev:web    # http://localhost:3000

# backend (only for backend extraction / backend separation / browser-extraction proxy)
npm run dev:server # http://localhost:8787
```

Open http://localhost:3000. Confirm the tab is cross-origin isolated (DevTools console:
`crossOriginIsolated === true`) — required for onnxruntime-web threads.

### Quickest path (no backend)

Choose **Upload file** + **Separation: Browser**, drop an MP3, and mix. First run downloads the
model (cached afterward); separation takes a few minutes on CPU/WASM (faster on WebGPU).

## Configuration

| Var | Where | Default | Meaning |
|---|---|---|---|
| `NEXT_PUBLIC_MODEL_URL` | web | HF `StemSplitio/htdemucs-6s-onnx` | ONNX model URL (browser) |
| `NEXT_PUBLIC_BACKEND_URL` | web | `http://localhost:8787` | backend base URL |
| `MODEL_URL` / `MODEL_DIR` | server | same HF model | model source / on-disk cache |
| `ORT_EP` | server | `cpu` | onnxruntime EP (`cpu`, or `dml` for Intel Arc if a DirectML build is installed) |
| `PORT` | server | `8787` | backend port |

> The exact ONNX file path/model must be verified against the chosen export
> (`shared/demucs.ts` assumes a 7.8 s segment and `[drums, bass, other, vocals, guitar, piano]`
> output order — adjust `SEGMENT_SECONDS`/`STEM_NAMES` if your export differs).

## Deployment

- **web/** → any static/Next host (Vercel/Netlify). Serve the model with CORS/CORP compatible
  with cross-origin isolation; it caches client-side after first load.
- **server/** → a small Node VPS/container. Needed for backend extraction, backend separation,
  and the browser-extraction proxy. Datacenter IPs can be blocked by YouTube — the upload path
  keeps the app usable regardless.

## Notes

- **Backend YouTube extraction uses yt-dlp** (the pure-JS libraries hit YouTube's PoToken /
  "No valid URL to decipher" wall). The standalone yt-dlp binary is auto-downloaded to
  `server/bin/` on first use, run with the current Node as its JS runtime (for signature
  deciphering) and the bundled ffmpeg. youtubei.js remains a fallback. YouTube can still block
  some networks/IPs — the **upload path always works**.
- Cross-origin isolation headers (COOP/COEP) are set in `web/next.config.ts`; the backend sends
  `Cross-Origin-Resource-Policy: cross-origin` on all responses so the isolated page can read them.
- For personal use only — respect copyright and YouTube's Terms of Service.
