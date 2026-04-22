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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: "#0f1419",
    icon: path.join(app.getAppPath(), "cove_icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (DEV_URL) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
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

  ipcMain.handle("cove:default-output-dir", async (_e, inputPath: string) => {
    return path.dirname(inputPath);
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
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Auto-updater: checks GitHub releases on startup. For NSIS (Setup.exe)
  // and AppImage installs, electron-updater downloads the new build in
  // the background and prompts the user to restart. Portable/.deb/source
  // are skipped with a log message.
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
