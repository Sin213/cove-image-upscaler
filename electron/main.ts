import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell } from "electron";
import { autoUpdater } from "electron-updater";
import * as path from "node:path";
import * as fs from "node:fs";
import { Upscaler } from "./upscaler";
import { ensureBinariesReady } from "./paths";
import type { ImportedImage, UpscaleJob } from "./types";

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const THUMB_SIZE = 128;

let mainWindow: BrowserWindow | null = null;
const upscaler = new Upscaler();

interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

function boundsFile(): string {
  return path.join(app.getPath("userData"), "window-bounds.json");
}

function readBounds(): WindowBounds | null {
  try {
    const raw = fs.readFileSync(boundsFile(), "utf-8");
    const parsed = JSON.parse(raw) as WindowBounds;
    if (
      typeof parsed.width === "number" &&
      typeof parsed.height === "number" &&
      parsed.width >= 600 &&
      parsed.height >= 400
    ) {
      return parsed;
    }
  } catch {
    // first run / corrupt — fall back to defaults
  }
  return null;
}

function writeBounds(b: WindowBounds): void {
  try {
    fs.mkdirSync(path.dirname(boundsFile()), { recursive: true });
    fs.writeFileSync(boundsFile(), JSON.stringify(b));
  } catch {
    // best effort
  }
}

function createWindow(): void {
  const saved = readBounds();
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1180,
    height: saved?.height ?? 760,
    x: saved?.x,
    y: saved?.y,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: "#0b0b10",
    show: false,
    frame: false,
    titleBarStyle: "hidden",
    icon: path.join(app.getAppPath(), "cove_icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Wait for the renderer to be ready before showing — eliminates the white
  // flash that you'd otherwise see between window creation and first paint.
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  if (saved?.maximized) mainWindow.maximize();

  if (DEV_URL) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  }

  const persist = () => {
    if (!mainWindow) return;
    const isMax = mainWindow.isMaximized();
    const bounds = isMax ? saved ?? mainWindow.getBounds() : mainWindow.getBounds();
    writeBounds({ ...bounds, maximized: isMax });
  };
  mainWindow.on("close", persist);
  mainWindow.on("resize", debounce(persist, 250));
  mainWindow.on("move", debounce(persist, 250));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let t: NodeJS.Timeout | null = null;
  return ((...args: unknown[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}

upscaler.on("progress", (payload) => {
  mainWindow?.webContents.send("cove:progress", payload);
});

async function importImage(filePath: string): Promise<ImportedImage | null> {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) return null;
    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) return null;
    const size = img.getSize();
    const scale = Math.min(THUMB_SIZE / size.width, THUMB_SIZE / size.height, 1);
    const thumb = scale < 1
      ? img.resize({
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
          quality: "good",
        })
      : img;
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      path: filePath,
      name: path.basename(filePath),
      width: size.width,
      height: size.height,
      thumbnailDataUrl: thumb.toDataURL(),
    };
  } catch {
    return null;
  }
}

function expandPaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(p);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      try {
        for (const entry of fs.readdirSync(p)) {
          const child = path.join(p, entry);
          const childStat = fs.statSync(child);
          if (childStat.isFile() && IMAGE_EXTS.has(path.extname(child).toLowerCase())) {
            out.push(child);
          }
        }
      } catch {
        // ignore unreadable directories
      }
    } else if (stat.isFile()) {
      out.push(p);
    }
  }
  return out;
}

async function importPaths(paths: string[]): Promise<ImportedImage[]> {
  const expanded = expandPaths(paths);
  const results = await Promise.all(expanded.map(importImage));
  return results.filter((x): x is ImportedImage => x !== null);
}

function registerIpc(): void {
  ipcMain.handle("cove:pick-input-files", async () => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select images",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (result.canceled) return [];
    return importPaths(result.filePaths);
  });

  ipcMain.handle("cove:import-dropped", async (_e, paths: string[]) => {
    return importPaths(paths);
  });

  ipcMain.handle("cove:pick-output-dir", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select output folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("cove:reveal", async (_e, p: string) => {
    if (fs.existsSync(p)) shell.showItemInFolder(p);
  });

  ipcMain.handle("cove:open-folder", async (_e, dir: string) => {
    if (fs.existsSync(dir)) await shell.openPath(dir);
  });

  ipcMain.handle("cove:read-image-data-url", async (_e, p: string, maxSize?: number) => {
    try {
      if (!fs.existsSync(p)) return null;
      const img = nativeImage.createFromPath(p);
      if (img.isEmpty()) return null;
      const size = img.getSize();
      const max = typeof maxSize === "number" && maxSize > 0 ? maxSize : 1920;
      const scale = Math.min(max / size.width, max / size.height, 1);
      const out = scale < 1
        ? img.resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
            quality: "good",
          })
        : img;
      return { url: out.toDataURL(), width: size.width, height: size.height };
    } catch {
      return null;
    }
  });

  ipcMain.handle("cove:enqueue", async (_e, jobs: UpscaleJob[]) => {
    const status = ensureBinariesReady();
    if (!status.ok) {
      for (const j of jobs) {
        mainWindow?.webContents.send("cove:progress", {
          id: j.id,
          percent: 0,
          status: "error",
          error: `Missing binary: ${status.missing.join(", ")}. Run: node scripts/download-binaries.mjs`,
        });
      }
      return;
    }
    upscaler.enqueue(jobs);
  });

  ipcMain.handle("cove:cancel-all", async () => {
    upscaler.cancelAll();
  });

  ipcMain.handle("cove:cancel-one", async (_e, jobId: string) => {
    upscaler.cancelOne(jobId);
  });

  ipcMain.on("cove:window-minimize", () => {
    mainWindow?.minimize();
  });

  ipcMain.on("cove:window-toggle-maximize", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });

  ipcMain.on("cove:window-close", () => {
    mainWindow?.close();
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.warn("auto-update check failed:", err);
    });
  }
});

app.on("window-all-closed", () => {
  upscaler.cancelAll();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  upscaler.cancelAll();
});
