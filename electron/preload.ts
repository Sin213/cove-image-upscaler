import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { CoveApi, ImportedImage, JobProgress, UpscaleJob } from "./types";

const api: CoveApi = {
  pickInputFiles: () => ipcRenderer.invoke("cove:pick-input-files"),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  importDroppedPaths: (paths: string[]) =>
    ipcRenderer.invoke("cove:import-dropped", paths),
  pickOutputDir: () => ipcRenderer.invoke("cove:pick-output-dir"),
  revealInFolder: (p: string) => ipcRenderer.invoke("cove:reveal", p),
  enqueue: (jobs: UpscaleJob[]) => ipcRenderer.invoke("cove:enqueue", jobs),
  cancelAll: () => ipcRenderer.invoke("cove:cancel-all"),
  getDefaultOutputDir: (inputPath: string) =>
    ipcRenderer.invoke("cove:default-output-dir", inputPath),
  onProgress: (cb: (p: JobProgress) => void) => {
    const listener = (_: unknown, payload: JobProgress) => cb(payload);
    ipcRenderer.on("cove:progress", listener);
    return () => ipcRenderer.removeListener("cove:progress", listener);
  },
};

contextBridge.exposeInMainWorld("cove", api);

// Keep the type export around so tsc includes it.
export type { ImportedImage };
