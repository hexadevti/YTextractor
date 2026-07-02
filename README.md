# 🎛 YTextractor — Stem Splitter & Multitrack Editor

Extract audio from a **YouTube link** or an **uploaded file**, split it into 6 stems with
**Demucs (`htdemucs_6s`)**, and work with them in a **clip-based multitrack editor** — per-track
waveform + live spectrum, cut / move / trim / **record** on a timeline, **audio → MIDI** with a
sampled General-MIDI instrument bank, tempo / chord / key detection, a **pitch-preserving speed
control** for practice, and export to WAV / MP3.

Runs as a **web app** (for development) or a **bundled Windows desktop app** (see
[DESKTOP.md](DESKTOP.md)). The desktop app runs everything locally, so **YouTube import uses your own
residential IP** and just works.

Both heavy operations are **selectable per job**:

| | Browser | Backend |
|---|---|---|
| **YouTube extraction** | youtubei.js + CORS proxy* | yt-dlp (auto-downloaded), youtubei.js fallback |
| **Separation** | onnxruntime-web (WebGPU/WASM) | onnxruntime-node (native CPU, optional DirectML) |

Plus **file upload** as a third input that needs no extraction. The editor always runs in the
browser (or the desktop app's window) and consumes the same stems regardless of where separation ran.

\* Browser YouTube extraction still routes through the backend's `/proxy` (there is no truly
serverless YouTube fetch). The **upload path always works** with no backend.

## Layout

```
shared/   runtime-agnostic TS: Demucs pipeline, stem defs, types (used by web + server)
web/      Next.js (React/TS) frontend + browser engines + Web Audio editor
server/   optional Node/TS (Fastify) backend: extraction, CORS proxy, native separation
desktop/  Electron app that bundles the backend + UI into one Windows program
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

### Desktop app (Windows)

A single **Electron** app that bundles the backend **and** the UI (one local server on
`127.0.0.1`). Because it runs on your machine, yt-dlp uses your **residential IP** — no cloud, no
cookies/proxies. Full details in **[DESKTOP.md](DESKTOP.md)**:

```bash
npm install                    # repo root (one-time)
cd desktop && npm install      # Electron + backend deps (one-time)
npm run dev                    # launch the app
npm run dist                   # build the Windows installer → desktop/release/
```

The library, saved projects, the ~258 MB separation model and the yt-dlp binary live under the
app's per-user data (`%APPDATA%/YTextractor`). The backend runs in a separate process, so heavy
work (import, separation) never freezes the window.

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

## Distribution

- **Desktop app (recommended)** — `cd desktop && npm run dist` builds a Windows installer that
  bundles everything (UI + backend + native separation) into one program. Runs locally, so YouTube
  import works from your own IP. See [DESKTOP.md](DESKTOP.md).
- **Web + backend** — `web/` is a normal Next.js app and `server/` a small Node service; both can be
  hosted. Note that YouTube extraction from **datacenter IPs is usually blocked** — the file-upload
  path always works, and browser separation + upload need no backend at all.

## Editor & recording

The project page is a **clip-based multitrack editor**. Each stem becomes a track of clips on a
timeline:

- **Select** a time range by dragging an empty area (drag vertically to span multiple tracks);
  click a clip to select it.
- **Cut / Copy / Paste / Delete** (`Ctrl+X/C/V`, `Del`), **Split** at the playhead (`S`),
  **move** clips by dragging (horizontal = time, vertical = another track), **trim** by dragging a
  clip edge, and **Undo/Redo** (`Ctrl+Z` / `Ctrl+Y`). Editing is **non-destructive** (originals are
  never modified).
- **Zoom** with `Ctrl`+scroll (anchored at the cursor) or the toolbar ±; **pan** with scroll / the
  bottom scrollbar; a time **ruler** stays in sync. `Space` toggles play.
- **Export** the edited arrangement to WAV/MP3 (clip positions, gaps, and recordings honored).

### Recording (mic / M-Vave Tank-G)

The **Audio I/O** bar shows from the start (it requests mic permission on load; **Monitor is off by
default** to avoid feedback). Pick your **In**/**Out** devices, **arm** a track with the ● button
(**＋ Track** creates a new track already armed), then hit **Record** (⏺ → ⏹ while recording). The
take is captured at the playhead via `getUserMedia` + an AudioWorklet, drawn as a **live waveform**
as it records, and always recorded at **normal speed** even when the transport speed is set to
something else.

- **M-Vave Tank-G on Windows requires the official M-VAVE driver** (https://www.m-vave.com/download)
  before it shows up as an input/output device.
- Browsers use **WASAPI shared mode, not ASIO**, so monitoring latency is higher than a native DAW
  (~tens of ms). Use **headphones** when monitoring to avoid feedback.
- **Output-device selection** (the **Out** dropdown / `setSinkId`) works in **Chrome/Edge**, not
  Safari, and needs a secure context (localhost or HTTPS).

## Notes

- **Backend YouTube extraction uses yt-dlp** (the pure-JS libraries hit YouTube's PoToken /
  "No valid URL to decipher" wall). The standalone yt-dlp binary is auto-downloaded on first use and
  run with a JavaScript runtime for signature deciphering — Node in dev/server, or the Electron
  binary via `ELECTRON_RUN_AS_NODE` in the desktop app — plus the bundled ffmpeg. youtubei.js remains
  a fallback. Datacenter IPs get blocked by YouTube (the **upload path always works**); the **desktop
  app sidesteps this** by running on your own IP.
- **MIDI tracks** (from a track's 🎹 audio→MIDI) play a **sampled General-MIDI instrument bank**
  via [smplr](https://github.com/danigb/smplr) — pick the instrument on the MIDI lane; samples load
  from smplr's CDN on first use (cached), with the built-in oscillator as an instant fallback while
  they load. Clean tidies the notes; right-click → Export `.mid` (with the matching GM program).
- **Audio → MIDI** uses [Spotify Basic Pitch](https://github.com/spotify/basic-pitch) (neural,
  polyphonic, in-browser). Neural transcription inherently invents some notes from harmonics/noise,
  so 🎹 opens options to keep it clean: **Sensitivity** (Cleaner/Balanced/Detailed thresholds), a
  **Pitch range** (Full / Bass / Lead-Vocal), a **minimum note length**, and **Monophonic** (one
  note at a time). The output is auto-cleaned. Best results: transcribe a **single stem** (not the
  full mix), pick the matching range, and use Monophonic for bass/vocal/lead lines.
- **Playback speed** (transport ⏩) changes tempo from 0.5× to 2×. Tick **Keep pitch** to time-stretch
  (WSOLA) instead of resampling, so slowing a song down for practice keeps the original pitch. The
  stretched audio is built across a pool of Web Workers (one per CPU) with a `building N/M…` counter;
  the pitch-shifted audio plays meanwhile and swaps in when ready. MIDI tracks always keep pitch.
  Optimised for the musical range (~55 Hz–5 kHz); a pure sub-bass tone at exactly half speed can
  octave-slip, and sharp percussion softens/doubles slightly when slowed a lot (inherent to WSOLA —
  mute the drum stem if it bothers you).
- Cross-origin isolation headers (COOP/COEP) are set in `web/next.config.ts`. COEP is
  **`credentialless`** (not `require-corp`) so the page stays cross-origin isolated (SharedArrayBuffer
  for onnxruntime-web + the AudioWorklet recorder) **and** smplr's cross-origin samples can load —
  **Chrome/Edge** (Safari doesn't support `credentialless`). The backend sends
  `Cross-Origin-Resource-Policy: cross-origin` on all responses so the isolated page can read them.
- For personal use only — respect copyright and YouTube's Terms of Service.
