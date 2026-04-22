#!/usr/bin/env node
// Fetches NCNN Vulkan Windows binaries + models.
// Idempotent: skips when target files already exist.
// Non-fatal on failure so `npm install` does not break on a flaky network.
//
// This repo targets Windows only. The URLs below pin the Windows zips
// from each upstream project so the build is reproducible from any host OS.

import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { cp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SOURCES = {
  realesrgan: {
    url: "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip",
    binaryName: "realesrgan-ncnn-vulkan.exe",
    modelSubdir: "realesrgan",
  },
  realcugan: {
    url: "https://github.com/nihui/realcugan-ncnn-vulkan/releases/download/20220728/realcugan-ncnn-vulkan-20220728-windows.zip",
    binaryName: "realcugan-ncnn-vulkan.exe",
    modelSubdir: "realcugan",
  },
};

const BIN_DIR = path.join(ROOT, "resources", "bin", "win");
const MODELS_DIR = path.join(ROOT, "resources", "models");

async function main() {
  mkdirSync(BIN_DIR, { recursive: true });
  mkdirSync(MODELS_DIR, { recursive: true });

  let yauzl;
  try {
    yauzl = require("yauzl");
  } catch {
    console.warn(
      "[cove] yauzl not installed yet — skipping binary download. " +
        "It will run on the next `npm install` or you can run it manually with `node scripts/download-binaries.mjs`.",
    );
    return;
  }

  for (const [name, spec] of Object.entries(SOURCES)) {
    const binPath = path.join(BIN_DIR, spec.binaryName);
    const modelDest = path.join(MODELS_DIR, spec.modelSubdir);

    if (existsSync(binPath) && existsSync(modelDest)) {
      console.log(`[cove] ${name}: already installed, skipping`);
      continue;
    }

    try {
      console.log(`[cove] ${name}: downloading ${spec.url}`);
      const zipPath = await downloadToTmp(spec.url, `${name}.zip`);
      const extractDir = path.join(tmpdir(), `cove-${name}-${Date.now()}`);
      mkdirSync(extractDir, { recursive: true });
      await extractZip(yauzl, zipPath, extractDir);
      await installExtracted(extractDir, spec, binPath, modelDest);
      rmSync(zipPath, { force: true });
      await rm(extractDir, { recursive: true, force: true });
      console.log(`[cove] ${name}: installed`);
    } catch (err) {
      console.warn(`[cove] ${name}: download failed — ${err.message}`);
      console.warn(
        "[cove] Upscaling will error until binaries are present. Rerun: node scripts/download-binaries.mjs",
      );
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

async function installExtracted(extractRoot, spec, binDest, modelDest) {
  const topLevel = await findSingleRoot(extractRoot);
  const sourceRoot = topLevel ?? extractRoot;

  const sourceBin = await findFile(sourceRoot, spec.binaryName);
  if (!sourceBin) {
    throw new Error(`Binary ${spec.binaryName} not found in archive`);
  }
  mkdirSync(path.dirname(binDest), { recursive: true });
  await cp(sourceBin, binDest, { force: true });

  // The Windows zips ship a vcomp DLL next to the .exe that the binary needs
  // at runtime. Copy any sibling DLLs alongside the binary.
  const binSrcDir = path.dirname(sourceBin);
  const binSiblings = await readdir(binSrcDir, { withFileTypes: true });
  for (const e of binSiblings) {
    if (!e.isFile() || e.name === spec.binaryName) continue;
    if (path.extname(e.name).toLowerCase() === ".dll") {
      await cp(path.join(binSrcDir, e.name), path.join(path.dirname(binDest), e.name), { force: true });
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
