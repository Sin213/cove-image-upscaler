import { create } from "zustand";
import { AI_SCALES, PIXEL_SCALES } from "../electron/types";
import type {
  AiScale,
  AnyScale,
  ImportedImage,
  JobProgress,
  JobStatus,
  LogEntry,
  LogLevel,
  Mode,
  PixelScale,
} from "./types";

export interface QueueEntry {
  image: ImportedImage;
  jobId: string | null;
  status: JobStatus | "idle";
  percent: number;
  error?: string;
  outputPath?: string;
  startedAt?: number;
  // The mode/scale actually used to build this entry's job. Absent until the
  // entry has been run at least once. Never re-derived from global controls,
  // so a completed entry keeps reporting the settings it was produced with.
  runSettings?: JobSelection;
}

export type Theme = "light" | "dark";

// Each mode remembers its own last-used scale; Pixel supports scales the AI
// modes do not, so a single global scale can't represent the selection.
export interface ScaleByMode {
  photo: AiScale;
  anime: AiScale;
  pixel: PixelScale;
}

// A validated mode/scale pair, ready to be spread into an `UpscaleJob`.
export type JobSelection =
  | { mode: "photo"; scale: AiScale }
  | { mode: "anime"; scale: AiScale }
  | { mode: "pixel"; scale: PixelScale };

const MAX_LOGS = 200;

interface State {
  mode: Mode;
  scale: AnyScale;
  scaleByMode: ScaleByMode;
  outputDir: string | null;
  queue: QueueEntry[];
  theme: Theme;
  logs: LogEntry[];
  logCollapsed: boolean;

  setMode: (m: Mode) => void;
  setScale: (s: AnyScale) => void;
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

  startJob: (imageId: string, jobId: string, runSettings: JobSelection) => void;
  applyProgress: (p: JobProgress) => void;
  resetStatuses: () => void;

  isProcessing: () => boolean;
}

const KEY_MODE = "cove:mode";
// Legacy single global AI scale. Read once for migration, never written again.
const KEY_LEGACY_SCALE = "cove:scale";
const KEY_SCALE_BY_MODE = "cove:scale-by-mode";
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

export function isAiScale(value: unknown): value is AiScale {
  return typeof value === "number" && AI_SCALES.some((candidate) => candidate === value);
}

export function isPixelScale(value: unknown): value is PixelScale {
  return typeof value === "number" && PIXEL_SCALES.some((candidate) => candidate === value);
}

export const DEFAULT_SCALE_BY_MODE: ScaleByMode = { photo: 2, anime: 2, pixel: 2 };

function readInitialMode(): Mode {
  const v = readString(KEY_MODE);
  if (v === "anime") return "anime";
  if (v === "pixel") return "pixel";
  return "photo";
}

// Own-property read that never inherits from the prototype chain and never
// widens the result away from `unknown`.
function ownValue(source: object, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return undefined;
  return Reflect.get(source, key);
}

// Each property is validated independently: a valid field survives even when a
// sibling is corrupt, and an invalid field falls back to its default.
export function parseScaleByMode(raw: string | null): ScaleByMode | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const photo = ownValue(value, "photo");
  const anime = ownValue(value, "anime");
  const pixel = ownValue(value, "pixel");
  return {
    photo: isAiScale(photo) ? photo : DEFAULT_SCALE_BY_MODE.photo,
    anime: isAiScale(anime) ? anime : DEFAULT_SCALE_BY_MODE.anime,
    pixel: isPixelScale(pixel) ? pixel : DEFAULT_SCALE_BY_MODE.pixel,
  };
}

// Only reached when the per-mode key is absent or structurally unusable. A
// legacy value is an AI scale, so it can never seed Pixel-only scales.
export function migrateLegacyScale(legacy: string | null): ScaleByMode {
  const parsed = legacy === null ? Number.NaN : Number(legacy);
  if (isAiScale(parsed)) return { photo: parsed, anime: parsed, pixel: DEFAULT_SCALE_BY_MODE.pixel };
  return { ...DEFAULT_SCALE_BY_MODE };
}

export function scaleForMode(mode: Mode, byMode: ScaleByMode): AnyScale {
  return mode === "pixel" ? byMode.pixel : byMode[mode];
}

function readInitialScaleByMode(): ScaleByMode {
  return parseScaleByMode(readString(KEY_SCALE_BY_MODE)) ?? migrateLegacyScale(readString(KEY_LEGACY_SCALE));
}

// Narrows the current selection to a discriminated mode/scale pair. Throws
// rather than letting an impossible pair reach the queue.
export function selectJobSettings(mode: Mode, scale: AnyScale): JobSelection {
  switch (mode) {
    case "photo":
      if (!isAiScale(scale)) throw new Error(`Invalid photo scale: ${String(scale)}`);
      return { mode: "photo", scale };
    case "anime":
      if (!isAiScale(scale)) throw new Error(`Invalid anime scale: ${String(scale)}`);
      return { mode: "anime", scale };
    case "pixel":
      if (!isPixelScale(scale)) throw new Error(`Invalid pixel scale: ${String(scale)}`);
      return { mode: "pixel", scale };
  }
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

// Computed before the store object so `mode` and `scale` start consistent.
const initialMode = readInitialMode();
const initialScaleByMode = readInitialScaleByMode();

export const useStore = create<State>((set, get) => ({
  mode: initialMode,
  scale: scaleForMode(initialMode, initialScaleByMode),
  scaleByMode: initialScaleByMode,
  outputDir: readInitialOutputDir(),
  queue: [],
  theme: readInitialTheme(),
  logs: [],
  logCollapsed: readInitialLogCollapsed(),

  setMode: (mode) => {
    writeString(KEY_MODE, mode);
    set((state) => ({ mode, scale: scaleForMode(mode, state.scaleByMode) }));
  },
  setScale: (scale) =>
    set((state) => {
      let scaleByMode: ScaleByMode;
      if (state.mode === "pixel") {
        if (!isPixelScale(scale)) return state;
        scaleByMode = { ...state.scaleByMode, pixel: scale };
      } else if (state.mode === "photo") {
        if (!isAiScale(scale)) return state;
        scaleByMode = { ...state.scaleByMode, photo: scale };
      } else {
        if (!isAiScale(scale)) return state;
        scaleByMode = { ...state.scaleByMode, anime: scale };
      }
      writeString(KEY_SCALE_BY_MODE, JSON.stringify(scaleByMode));
      return { scale, scaleByMode };
    }),
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

  startJob: (imageId, jobId, runSettings) =>
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
              runSettings,
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
