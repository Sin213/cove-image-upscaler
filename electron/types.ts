export type Mode = "photo" | "anime";
export type Scale = 2 | 3 | 4;
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

export interface UpscaleJob {
  id: string;
  inputPath: string;
  outputDir: string | null;
  mode: Mode;
  scale: Scale;
}

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
