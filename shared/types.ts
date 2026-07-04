/** Shared DTOs for engine selection, job configuration, and progress reporting. */

import type { StemName } from './stems';

export type ExtractionEngine = 'browser' | 'backend';
/**
 * Where stem separation runs: in the browser (onnxruntime-web, WebGPU/WASM), on
 * the native desktop backend, or on the optional GPU cloud service (see /cloud).
 */
export type SeparationEngine = 'browser' | 'backend' | 'cloud';

export type InputSource =
  | { kind: 'youtube'; url: string; extraction: ExtractionEngine }
  | { kind: 'file'; fileName: string };

export interface JobConfig {
  input: InputSource;
  separation: SeparationEngine;
  /** Base URL of the optional Node backend, e.g. http://localhost:8787 */
  backendBaseUrl: string;
  /**
   * Which stems to produce (subset of the 6). Absent/empty means all 6.
   * Threaded to every engine (browser / backend / cloud); see
   * SeparationOptions.include for how it maps onto the model output.
   */
  stems?: StemName[];
}

export type JobPhase =
  | 'idle'
  | 'extracting'
  | 'loading-model'
  | 'separating'
  | 'ready'
  | 'error';

export interface ProgressUpdate {
  phase: JobPhase;
  /** 0..100 within the current phase */
  percent: number;
  message?: string;
  /** compute backend actually used, e.g. 'webgpu' | 'wasm' | 'cpu' | 'directml' */
  engine?: string;
}

/* ----- Backend wire protocol (server/ <-> web/) ----- */

/** POST /separate response */
export interface SeparateStartResponse {
  jobId: string;
}

/** One server-sent event from GET /separate/:id/events */
export interface SeparateEvent {
  phase: JobPhase;
  percent: number;
  message?: string;
  engine?: string;
  /** present when phase === 'ready': stem names available for download */
  stems?: StemName[];
  /** audio metadata for the ready stems */
  sampleRate?: number;
  /** present when phase === 'ready' and the project was persisted */
  projectId?: string;
  error?: string;
}

/** Stats scraped from a YouTube video on import. */
export interface VideoStats {
  uploader?: string;
  viewCount?: number;
  likeCount?: number;
  uploadDate?: string; // YYYYMMDD
}

/** POST /extract response metadata (audio bytes streamed separately) */
export interface ExtractInfo extends VideoStats {
  title: string;
  durationSeconds?: number;
  mimeType: string;
}

/* ----- Library (persisted on the backend disk) ----- */

/** A saved source audio (imported from YouTube or uploaded). */
export interface SourceMeta extends VideoStats {
  id: string;
  title: string;
  origin: 'youtube' | 'file';
  url?: string;
  createdAt: string; // ISO
  durationSeconds?: number;
  ext: string;
  mimeType: string;
  bytes: number;
  hasThumb?: boolean;
  /** How long the YouTube extraction (capture) took, in ms. */
  captureMs?: number;
}

/** Summary of a saved editable arrangement (clip layout + referenced audio). */
export interface ArrangementSummary {
  id: string;
  title: string;
  createdAt: string; // ISO
  trackCount: number;
}

/** A saved separation project (6 stems + metadata) on disk. */
export interface ProjectMeta {
  id: string;
  title: string;
  sourceId?: string;
  createdAt: string; // ISO
  sampleRate: number;
  numChannels: number;
  lengthSamples: number;
  stems: StemName[];
  engine: string;
  /** How long the stem separation took, in ms. */
  separationMs?: number;
}
