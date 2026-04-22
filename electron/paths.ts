import { app } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";

function platformDir(): "linux" | "mac" | "win" {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "win";
  return "linux";
}

function binaryName(base: string): string {
  return process.platform === "win32" ? `${base}.exe` : base;
}

export function binDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "bin");
  }
  return path.join(app.getAppPath(), "resources", "bin", platformDir());
}

export function modelsDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "models");
  }
  return path.join(app.getAppPath(), "resources", "models");
}

export function realesrganBinary(): string {
  return path.join(binDir(), binaryName("realesrgan-ncnn-vulkan"));
}

export function realcuganBinary(): string {
  return path.join(binDir(), binaryName("realcugan-ncnn-vulkan"));
}

export function realesrganModelsDir(): string {
  return path.join(modelsDir(), "realesrgan");
}

export function realcuganModelsDir(): string {
  return path.join(modelsDir(), "realcugan", "models-se");
}

export function ensureBinariesReady(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const paths = [realesrganBinary(), realcuganBinary()];
  for (const p of paths) {
    if (!fs.existsSync(p)) missing.push(p);
  }
  return { ok: missing.length === 0, missing };
}
