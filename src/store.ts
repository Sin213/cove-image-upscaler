import { create } from "zustand";
import type { ImportedImage, JobProgress, JobStatus, Mode, Scale } from "./types";

export interface QueueEntry {
  image: ImportedImage;
  jobId: string | null;
  status: JobStatus | "idle";
  percent: number;
  error?: string;
  outputPath?: string;
}

export type Theme = "light" | "dark";

interface State {
  mode: Mode;
  scale: Scale;
  outputDir: string | null;
  queue: QueueEntry[];
  theme: Theme;

  setMode: (m: Mode) => void;
  setScale: (s: Scale) => void;
  setOutputDir: (dir: string | null) => void;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;

  addImages: (imgs: ImportedImage[]) => void;
  removeImage: (id: string) => void;
  clearImages: () => void;

  startJob: (imageId: string, jobId: string) => void;
  applyProgress: (p: JobProgress) => void;
  resetStatuses: () => void;

  isProcessing: () => boolean;
}

function readInitialTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem("cove:theme", theme);
  } catch {
    // ignore
  }
}

export const useStore = create<State>((set, get) => ({
  mode: "photo",
  scale: 4,
  outputDir: null,
  queue: [],
  theme: readInitialTheme(),

  setMode: (mode) => set({ mode }),
  setScale: (scale) => set({ scale }),
  setOutputDir: (outputDir) => set({ outputDir }),
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () => {
    const next: Theme = get().theme === "dark" ? "light" : "dark";
    applyTheme(next);
    set({ theme: next });
  },

  addImages: (imgs) =>
    set((state) => {
      const existing = new Set(state.queue.map((q) => q.image.path));
      const fresh = imgs.filter((i) => !existing.has(i.path));
      return {
        queue: [
          ...state.queue,
          ...fresh.map<QueueEntry>((image) => ({
            image,
            jobId: null,
            status: "idle",
            percent: 0,
          })),
        ],
      };
    }),

  removeImage: (id) =>
    set((state) => ({
      queue: state.queue.filter((q) => q.image.id !== id),
    })),

  clearImages: () => set({ queue: [] }),

  startJob: (imageId, jobId) =>
    set((state) => ({
      queue: state.queue.map((q) =>
        q.image.id === imageId
          ? { ...q, jobId, status: "queued", percent: 0, error: undefined, outputPath: undefined }
          : q,
      ),
    })),

  applyProgress: (p) =>
    set((state) => ({
      queue: state.queue.map((q) =>
        q.jobId === p.id
          ? {
              ...q,
              status: p.status,
              percent: p.percent,
              error: p.error,
              outputPath: p.outputPath ?? q.outputPath,
            }
          : q,
      ),
    })),

  resetStatuses: () =>
    set((state) => ({
      queue: state.queue.map((q) => ({
        ...q,
        jobId: null,
        status: "idle",
        percent: 0,
        error: undefined,
      })),
    })),

  isProcessing: () =>
    get().queue.some((q) => q.status === "running" || q.status === "queued"),
}));
