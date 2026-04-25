import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { CoveApi, ImportedImage, JobProgress, UpscaleJob } from "./types";

const api: CoveApi = {
  pickInputFiles: () => ipcRenderer.invoke("cove:pick-input-files"),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  importDroppedPaths: (paths: string[]) =>
    ipcRenderer.invoke("cove:import-dropped", paths),
  pickOutputDir: () => ipcRenderer.invoke("cove:pick-output-dir"),
  revealInFolder: (p: string) => ipcRenderer.invoke("cove:reveal", p),
  openFolder: (dir: string) => ipcRenderer.invoke("cove:open-folder", dir),
  enqueue: (jobs: UpscaleJob[]) => ipcRenderer.invoke("cove:enqueue", jobs),
  cancelAll: () => ipcRenderer.invoke("cove:cancel-all"),
  cancelOne: (jobId: string) => ipcRenderer.invoke("cove:cancel-one", jobId),
  readImageDataUrl: (p: string, maxSize?: number) =>
    ipcRenderer.invoke("cove:read-image-data-url", p, maxSize),
  onProgress: (cb: (p: JobProgress) => void) => {
    const listener = (_: unknown, payload: JobProgress) => cb(payload);
    ipcRenderer.on("cove:progress", listener);
    return () => ipcRenderer.removeListener("cove:progress", listener);
  },
  windowMinimize: () => ipcRenderer.send("cove:window-minimize"),
  windowToggleMaximize: () => ipcRenderer.send("cove:window-toggle-maximize"),
  windowClose: () => ipcRenderer.send("cove:window-close"),
};

contextBridge.exposeInMainWorld("cove", api);

// Keep the type export around so tsc includes it.
export type { ImportedImage };
