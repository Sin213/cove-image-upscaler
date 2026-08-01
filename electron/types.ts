export const AI_SCALES = [2, 3, 4] as const;
export const PIXEL_SCALES = [2, 3, 4, 5, 6, 8] as const;

export type AiMode = "photo" | "anime";
export type Mode = AiMode | "pixel";

export type AiScale = (typeof AI_SCALES)[number];
export type PixelScale = (typeof PIXEL_SCALES)[number];

// `Scale` stays AI-only: existing renderer state and persistence are AI scales.
export type Scale = AiScale;
export type AnyScale = AiScale | PixelScale;
export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";
export type LogLevel = "info" | "good" | "warn" | "error";

export interface LogEntry {
  id: string;
  ts: number;
  level: LogLevel;
  text: string;
  detail?: string;
}

export interface ImportedImage {
  id: string;
  path: string;
  name: string;
  width: number;
  height: number;
  thumbnailDataUrl: string;
}

export interface LoadedImage {
  url: string;
  width: number;
  height: number;
}

interface UpscaleJobBase {
  id: string;
  inputPath: string;
  outputDir: string | null;
}

export interface PhotoUpscaleJob extends UpscaleJobBase {
  mode: "photo";
  scale: AiScale;
}

export interface AnimeUpscaleJob extends UpscaleJobBase {
  mode: "anime";
  scale: AiScale;
}

export interface PixelUpscaleJob extends UpscaleJobBase {
  mode: "pixel";
  scale: PixelScale;
}

// Discriminated on `mode` so mode/scale pairs can't be mismatched and so
// backend dispatch can be proven exhaustive by the compiler.
export type UpscaleJob = PhotoUpscaleJob | AnimeUpscaleJob | PixelUpscaleJob;

export interface JobProgress {
  id: string;
  percent: number;
  status: JobStatus;
  error?: string;
  outputPath?: string;
}

export interface CoveApi {
  pickInputFiles: () => Promise<ImportedImage[]>;
  getPathForFile: (file: File) => string;
  importDroppedPaths: (paths: string[]) => Promise<ImportedImage[]>;
  pickOutputDir: () => Promise<string | null>;
  revealInFolder: (path: string) => Promise<void>;
  openFolder: (dir: string) => Promise<void>;
  enqueue: (jobs: UpscaleJob[]) => Promise<void>;
  cancelAll: () => Promise<void>;
  cancelOne: (jobId: string) => Promise<void>;
  onProgress: (cb: (p: JobProgress) => void) => () => void;
  readImageDataUrl: (path: string, maxSize?: number) => Promise<LoadedImage | null>;
  windowMinimize: () => void;
  windowToggleMaximize: () => void;
  windowClose: () => void;
}

declare global {
  interface Window {
    cove: CoveApi;
  }
}
