#!/usr/bin/env node
// Fetches NCNN Vulkan binaries (realesrgan + realcugan) and shared model
// files for the host OS into resources/bin/<os>/ and resources/models/.
//
// Defaults to the host OS so `npm install` on Linux only pulls the Linux
// zip, not the Windows/macOS ones. CI passes `--all` to populate all three
// before the per-platform `electron-builder` step.
//
// Idempotent: skips when the target binary + models already exist.
// Non-fatal on failure so a flaky network does not break `npm install`.

import { createWriteStream, existsSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { cp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REALESRGAN_BASE =
  "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424";
const REALCUGAN_BASE =
  "https://github.com/nihui/realcugan-ncnn-vulkan/releases/download/20220728/realcugan-ncnn-vulkan-20220728";

const PLATFORMS = {
  linux: {
    suffix: "ubuntu",
    binExt: "",
    libExts: [".so", ".so.1"],
  },
  mac: {
    suffix: "macos",
    binExt: "",
    libExts: [".dylib"],
  },
  win: {
    suffix: "windows",
    binExt: ".exe",
    libExts: [".dll"],
  },
};

const SOURCES = {
  realesrgan: {
    urlBase: REALESRGAN_BASE,
    binary: "realesrgan-ncnn-vulkan",
    modelSubdir: "realesrgan",
  },
  realcugan: {
    urlBase: REALCUGAN_BASE,
    binary: "realcugan-ncnn-vulkan",
    modelSubdir: "realcugan",
  },
};

function hostPlatformKey() {
  if (process.platform === "win32") return "win";
  if (process.platform === "darwin") return "mac";
  return "linux";
}

function targetsFromArgs() {
  const argv = process.argv.slice(2);
  if (argv.includes("--all")) return Object.keys(PLATFORMS);
  const wanted = argv.filter((a) => Object.keys(PLATFORMS).includes(a));
  if (wanted.length) return wanted;
  return [hostPlatformKey()];
}

async function main() {
  const targets = targetsFromArgs();
  console.log(`[cove] downloading binaries for: ${targets.join(", ")}`);

  let yauzl;
  try {
    yauzl = require("yauzl");
  } catch {
    console.warn(
      "[cove] yauzl not installed yet — skipping binary download. " +
        "Rerun with `node scripts/download-binaries.mjs` after `npm install`.",
    );
    return;
  }

  for (const platformKey of targets) {
    const platform = PLATFORMS[platformKey];
    const binDir = path.join(ROOT, "resources", "bin", platformKey);
    mkdirSync(binDir, { recursive: true });

    for (const [name, spec] of Object.entries(SOURCES)) {
      const binName = spec.binary + platform.binExt;
      const binPath = path.join(binDir, binName);
      const modelDest = path.join(ROOT, "resources", "models", spec.modelSubdir);
      const url = `${spec.urlBase}-${platform.suffix}.zip`;

      if (existsSync(binPath) && existsSync(modelDest)) {
        console.log(`[cove] ${platformKey}/${name}: already installed, skipping`);
        continue;
      }

      try {
        console.log(`[cove] ${platformKey}/${name}: downloading ${url}`);
        const zipPath = await downloadToTmp(url, `${platformKey}-${name}.zip`);
        const extractDir = path.join(tmpdir(), `cove-${platformKey}-${name}-${Date.now()}`);
        mkdirSync(extractDir, { recursive: true });
        await extractZip(yauzl, zipPath, extractDir);
        await installExtracted(extractDir, spec, platform, binPath, modelDest);
        rmSync(zipPath, { force: true });
        await rm(extractDir, { recursive: true, force: true });
        console.log(`[cove] ${platformKey}/${name}: installed`);
      } catch (err) {
        console.warn(`[cove] ${platformKey}/${name}: download failed — ${err.message}`);
      }
    }
  }
}

async function downloadToTmp(url, fileName) {
  const dest = path.join(tmpdir(), `cove-${Date.now()}-${fileName}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  return dest;
}

function extractZip(yauzl, zipPath, destDir) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.readEntry();
      zip.on("entry", (entry) => {
        const outPath = path.join(destDir, entry.fileName);
        if (/\/$/.test(entry.fileName)) {
          mkdirSync(outPath, { recursive: true });
          zip.readEntry();
        } else {
          mkdirSync(path.dirname(outPath), { recursive: true });
          zip.openReadStream(entry, (err2, readStream) => {
            if (err2) return reject(err2);
            const writeStream = createWriteStream(outPath);
            readStream.pipe(writeStream);
            writeStream.on("finish", () => zip.readEntry());
            writeStream.on("error", reject);
          });
        }
      });
    });
  });
}

async function installExtracted(extractRoot, spec, platform, binDest, modelDest) {
  const topLevel = await findSingleRoot(extractRoot);
  const sourceRoot = topLevel ?? extractRoot;

  const binName = spec.binary + platform.binExt;
  const sourceBin = await findFile(sourceRoot, binName);
  if (!sourceBin) {
    throw new Error(`Binary ${binName} not found in archive`);
  }
  await cp(sourceBin, binDest, { force: true });
  if (platform !== PLATFORMS.win) {
    chmodSync(binDest, 0o755);
  }

  // Copy any sibling shared libraries the binary needs (vcomp/vulkan DLLs on
  // Windows, libomp.dylib on macOS, occasional .so on Linux).
  const binSrcDir = path.dirname(sourceBin);
  const binSiblings = await readdir(binSrcDir, { withFileTypes: true });
  for (const e of binSiblings) {
    if (!e.isFile() || e.name === binName) continue;
    const lower = e.name.toLowerCase();
    if (platform.libExts.some((ext) => lower.endsWith(ext))) {
      const dest = path.join(path.dirname(binDest), e.name);
      await cp(path.join(binSrcDir, e.name), dest, { force: true });
      if (platform !== PLATFORMS.win) chmodSync(dest, 0o755);
    }
  }

  const sourceModels = path.join(sourceRoot, "models");
  if (existsSync(sourceModels)) {
    await rm(modelDest, { recursive: true, force: true });
    await cp(sourceModels, modelDest, { recursive: true, force: true });
    return;
  }

  // realcugan ships top-level models-se / models-pro / models-nose dirs
  const subdirs = await readdir(sourceRoot, { withFileTypes: true });
  const modelDirs = subdirs.filter((d) => d.isDirectory() && d.name.startsWith("models"));
  if (modelDirs.length === 0) {
    throw new Error(`No models directory found in archive`);
  }
  await rm(modelDest, { recursive: true, force: true });
  mkdirSync(modelDest, { recursive: true });
  for (const d of modelDirs) {
    await cp(path.join(sourceRoot, d.name), path.join(modelDest, d.name), {
      recursive: true,
      force: true,
    });
  }
}

async function findSingleRoot(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(dir, entries[0].name);
  }
  return null;
}

async function findFile(root, fileName) {
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    const entries = await readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.name === fileName) {
        return full;
      }
    }
  }
  return null;
}

main().catch((err) => {
  console.warn("[cove] binary setup failed:", err.message);
  process.exit(0);
});
