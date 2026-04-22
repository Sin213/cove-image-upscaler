export type Mode = "photo" | "anime";
export type Scale = 2 | 3 | 4;
export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface ImportedImage {
  id: string;
  path: string;
  name: string;
  width: number;
  height: number;
  thumbnailDataUrl: string;
}

export interface UpscaleJob {
  id: string;
  inputPath: string;
  outputPath: string;
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
  enqueue: (jobs: UpscaleJob[]) => Promise<void>;
  cancelAll: () => Promise<void>;
  onProgress: (cb: (p: JobProgress) => void) => () => void;
  getDefaultOutputDir: (inputPath: string) => Promise<string>;
}

declare global {
  interface Window {
    cove: CoveApi;
  }
}
