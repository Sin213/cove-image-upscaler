// Navigation policy for the main window.
//
// The renderer is entirely local. Only the packaged application's own `dist`
// content and, in development, the exact configured Vite origin may be
// navigated to. Everything else - other local files, external origins,
// javascript:, data:, unparseable strings - is denied. Fails closed.

import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface NavigationPolicyInput {
  targetUrl: string;
  /** Absolute path of the packaged renderer's `dist` directory. */
  appDistDir: string;
  /** VITE_DEV_SERVER_URL when development mode is active, otherwise absent. */
  devServerUrl?: string | null;
}

export function isNavigationAllowed(input: NavigationPolicyInput): boolean {
  const { targetUrl, appDistDir, devServerUrl } = input;

  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return false;
  }

  if (url.protocol === "http:" || url.protocol === "https:") {
    if (!devServerUrl) return false;
    let dev: URL;
    try {
      dev = new URL(devServerUrl);
    } catch {
      return false;
    }
    return url.origin === dev.origin;
  }

  if (url.protocol !== "file:") return false;

  let filePath: string;
  try {
    filePath = fileURLToPath(url);
  } catch {
    return false;
  }

  const root = path.resolve(appDistDir);
  const resolved = path.resolve(filePath);
  if (resolved === root) return true;
  const rel = path.relative(root, resolved);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
