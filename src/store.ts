import { create } from "zustand";
import type { ImportedImage, JobProgress, JobStatus, LogEntry, LogLevel, Mode, Scale } from "./types";

export interface QueueEntry {
  image: ImportedImage;
  jobId: string | null;
  status: JobStatus | "idle";
  percent: number;
  error?: string;
  outputPath?: string;
  startedAt?: number;
}

export type Theme = "light" | "dark";

const MAX_LOGS = 200;

interface State {
  mode: Mode;
  scale: Scale;
  outputDir: string | null;
  queue: QueueEntry[];
  theme: Theme;
  logs: LogEntry[];
  logCollapsed: boolean;

  setMode: (m: Mode) => void;
  setScale: (s: Scale) => void;
  setOutputDir: (dir: string | null) => void;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  toggleLogCollapsed: () => void;
  clearLogs: () => void;
  log: (level: LogLevel, text: string, detail?: string) => void;

  addImages: (imgs: ImportedImage[]) => void;
  removeImage: (id: string) => void;
  reorder: (fromId: string, toId: string) => void;
  clearImages: () => void;

  startJob: (imageId: string, jobId: string) => void;
  applyProgress: (p: JobProgress) => void;
  resetStatuses: () => void;

  isProcessing: () => boolean;
}

const KEY_MODE = "cove:mode";
const KEY_SCALE = "cove:scale";
const KEY_OUTPUT_DIR = "cove:output-dir";
const KEY_THEME = "cove:theme";
const KEY_LOG_COLLAPSED = "cove:log-collapsed";

function readString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeString(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function readInitialMode(): Mode {
  const v = readString(KEY_MODE);
  return v === "anime" ? "anime" : "photo";
}

function readInitialScale(): Scale {
  const v = readString(KEY_SCALE);
  if (v === "2" || v === "3" || v === "4") return Number(v) as Scale;
  return 2;
}

function readInitialOutputDir(): string | null {
  const v = readString(KEY_OUTPUT_DIR);
  return v && v.length ? v : null;
}

function readInitialTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function readInitialLogCollapsed(): boolean {
  const v = readString(KEY_LOG_COLLAPSED);
  return v !== "false";
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  writeString(KEY_THEME, theme);
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function pushLog(prev: LogEntry[], entry: LogEntry): LogEntry[] {
  const next = prev.length >= MAX_LOGS ? prev.slice(prev.length - MAX_LOGS + 1) : prev.slice();
  next.push(entry);
  return next;
}

export const useStore = create<State>((set, get) => ({
  mode: readInitialMode(),
  scale: readInitialScale(),
  outputDir: readInitialOutputDir(),
  queue: [],
  theme: readInitialTheme(),
  logs: [],
  logCollapsed: readInitialLogCollapsed(),

  setMode: (mode) => {
    writeString(KEY_MODE, mode);
    set({ mode });
  },
  setScale: (scale) => {
    writeString(KEY_SCALE, String(scale));
    set({ scale });
  },
  setOutputDir: (outputDir) => {
    writeString(KEY_OUTPUT_DIR, outputDir);
    set({ outputDir });
  },
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () => {
    const next: Theme = get().theme === "dark" ? "light" : "dark";
    applyTheme(next);
    set({ theme: next });
  },
  toggleLogCollapsed: () => {
    const next = !get().logCollapsed;
    writeString(KEY_LOG_COLLAPSED, String(next));
    set({ logCollapsed: next });
  },
  clearLogs: () => set({ logs: [] }),
  log: (level, text, detail) =>
    set((state) => ({
      logs: pushLog(state.logs, { id: makeId(), ts: Date.now(), level, text, detail }),
    })),

  addImages: (imgs) =>
    set((state) => {
      const existing = new Set(state.queue.map((q) => q.image.path));
      const fresh = imgs.filter((i) => !existing.has(i.path));
      let logs = state.logs;
      if (fresh.length > 0) {
        logs = pushLog(logs, {
          id: makeId(),
          ts: Date.now(),
          level: "info",
          text: `Added ${fresh.length} image${fresh.length === 1 ? "" : "s"}`,
        });
      }
      return {
        logs,
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

  reorder: (fromId, toId) =>
    set((state) => {
      const fromIdx = state.queue.findIndex((q) => q.image.id === fromId);
      const toIdx = state.queue.findIndex((q) => q.image.id === toId);
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return state;
      const dragged = state.queue[fromIdx];
      if (dragged.status === "running" || dragged.status === "queued") return state;
      const next = state.queue.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return { queue: next };
    }),

  clearImages: () => set({ queue: [] }),

  startJob: (imageId, jobId) =>
    set((state) => ({
      queue: state.queue.map((q) =>
        q.image.id === imageId
          ? {
              ...q,
              jobId,
              status: "queued",
              percent: 0,
              error: undefined,
              outputPath: undefined,
              startedAt: undefined,
            }
          : q,
      ),
    })),

  applyProgress: (p) =>
    set((state) => {
      let logs = state.logs;
      const queue = state.queue.map((q) => {
        if (q.jobId !== p.id) return q;
        const prev = q.status;
        const next = p.status;
        let startedAt = q.startedAt;
        if (prev !== next) {
          if (next === "running" && !startedAt) startedAt = Date.now();
          const entry = formatLogTransition(q.image.name, next, p.error, p.outputPath, q.startedAt);
          if (entry) logs = pushLog(logs, entry);
        }
        return {
          ...q,
          status: next,
          percent: p.percent,
          error: p.error,
          outputPath: p.outputPath ?? q.outputPath,
          startedAt,
        };
      });
      return { queue, logs };
    }),

  resetStatuses: () =>
    set((state) => ({
      queue: state.queue.map((q) => ({
        ...q,
        jobId: null,
        status: "idle",
        percent: 0,
        error: undefined,
        startedAt: undefined,
      })),
    })),

  isProcessing: () =>
    get().queue.some((q) => q.status === "running" || q.status === "queued"),
}));

function formatLogTransition(
  name: string,
  status: JobStatus,
  error?: string,
  outputPath?: string,
  startedAt?: number,
): LogEntry | null {
  const id = makeId();
  const ts = Date.now();
  if (status === "running") {
    return { id, ts, level: "info", text: `Started · ${name}` };
  }
  if (status === "done") {
    const ms = startedAt ? ts - startedAt : 0;
    const duration = ms ? ` in ${(ms / 1000).toFixed(1)}s` : "";
    const out = outputPath ? basename(outputPath) : "";
    return {
      id,
      ts,
      level: "good",
      text: `Done · ${name}${duration}`,
      detail: out,
    };
  }
  if (status === "error") {
    return { id, ts, level: "error", text: `Error · ${name}`, detail: error };
  }
  if (status === "cancelled") {
    return { id, ts, level: "warn", text: `Cancelled · ${name}` };
  }
  return null;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}
