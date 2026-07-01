/** Shared DTOs for engine selection, job configuration, and progress reporting. */

import type { StemName } from './stems';

export type ExtractionEngine = 'browser' | 'backend';
export type SeparationEngine = 'browser' | 'backend';

export type InputSource =
  | { kind: 'youtube'; url: string; extraction: ExtractionEngine }
  | { kind: 'file'; fileName: string };

export interface JobConfig {
  input: InputSource;
  separation: SeparationEngine;
  /** Base URL of the optional Node backend, e.g. http://localhost:8787 */
  backendBaseUrl: string;
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

/** POST /extract response metadata (audio bytes streamed separately) */
export interface ExtractInfo {
  title: string;
  durationSeconds?: number;
  mimeType: string;
}

/* ----- Library (persisted on the backend disk) ----- */

/** A saved source audio (imported from YouTube or uploaded). */
export interface SourceMeta {
  id: string;
  title: string;
  origin: 'youtube' | 'file';
  url?: string;
  createdAt: string; // ISO
  durationSeconds?: number;
  ext: string;
  mimeType: string;
  bytes: number;
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
}
