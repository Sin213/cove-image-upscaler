// Regression tests for the AI binary bootstrap (scripts/download-binaries.mjs).
//
// Covers the Windows defect where the yauzl extraction path stalled on the
// first DEFLATE entry, never resolved, never errored, and let the process
// exit 0 with no binaries installed.
//
// No network access: archives are hand-built ZIP fixtures (tests/lib-zip.mjs)
// and every download is injected.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { buildZip, verifyZipStructure, standardFixtureEntries } from "./lib-zip.mjs";

const SCRIPT = path.resolve(fileURLToPath(new URL("../scripts/download-binaries.mjs", import.meta.url)));
const mod = await import(pathToFileURL(SCRIPT).href);

const {
  extractArchive,
  validateTree,
  requiredRelPaths,
  installSource,
  runCli,
  withTimeout,
  closeExtractionResources,
  PLATFORMS,
  SOURCES,
} = mod;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const cleanups = [];
function tmp(prefix = "cove-dl-test-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}
test.after(async () => {
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true });
});

function writeFixture(dir, entries = standardFixtureEntries(), name = "fixture.zip") {
  const buf = buildZip(entries);
  // Self-verify the fixture before any extractor sees it.
  verifyZipStructure(buf);
  const zipPath = path.join(dir, name);
  writeFileSync(zipPath, buf);
  return zipPath;
}

// Fake platform/source pair mirroring the real script's shape but independent
// of the host OS, so archive-relative names stay stable everywhere.
const FAKE_PLATFORM = { suffix: "windows", binExt: ".exe", libExts: [".dll"], requiredLibs: [] };
const FAKE_SPEC = {
  urlBase: "https://example.invalid/photo-tool",
  binary: "photo-tool",
  modelSubdir: "photo",
  requiredModels: ["photo/model.param", "anime/model.param"],
};

function baseInstallArgs(root, zipPath, overrides = {}) {
  return {
    platformKey: "win",
    platform: FAKE_PLATFORM,
    sourceKey: "phototool",
    spec: FAKE_SPEC,
    root,
    downloadArchive: async () => zipPath,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// fixture self-check
// ---------------------------------------------------------------------------

test("zip fixture is structurally valid and contains the expected entries", () => {
  const names = verifyZipStructure(buildZip(standardFixtureEntries()));
  assert.deepEqual(names, [
    "bin/",
    "bin/photo-tool.exe",
    "bin/anime-tool.exe",
    "models/",
    "models/photo/",
    "models/photo/model.param",
    "models/anime/",
    "models/anime/model.param",
  ]);
});

// ---------------------------------------------------------------------------
// 1-2. extraction
// ---------------------------------------------------------------------------

test("extractArchive extracts a DEFLATE-compressed entry on the host platform", async () => {
  const dir = tmp();
  const zipPath = writeFixture(dir);
  const dest = path.join(dir, "extract");

  await extractArchive(zipPath, dest);

  // bin/anime-tool.exe is the DEFLATE entry — the one that stalled yauzl.
  const animePath = path.join(dest, "bin", "anime-tool.exe");
  assert.ok(existsSync(animePath), "DEFLATE entry was not extracted");
  assert.equal(readFileSync(animePath, "utf8"), "ANIME-BINARY-CONTENT".repeat(64));
});

test("extractArchive creates nested directories correctly", async () => {
  const dir = tmp();
  const zipPath = writeFixture(dir);
  const dest = path.join(dir, "extract");

  await extractArchive(zipPath, dest);

  assert.ok(existsSync(path.join(dest, "models", "photo", "model.param")));
  assert.ok(existsSync(path.join(dest, "models", "anime", "model.param")));
  assert.equal(readFileSync(path.join(dest, "models", "photo", "model.param"), "utf8"), "photo-param");
});

test("extractArchive rejects on a corrupt archive", async () => {
  const dir = tmp();
  const bad = path.join(dir, "bad.zip");
  writeFileSync(bad, buildZip(standardFixtureEntries()).subarray(0, 200)); // truncated
  await assert.rejects(() => extractArchive(bad, path.join(dir, "extract")));
});

test("withTimeout rejects when the operation does not settle", async () => {
  await assert.rejects(
    () => withTimeout(() => new Promise(() => {}), 25, "stalled phase", { graceMs: 50 }),
    /timed out/i,
  );
});

// ---------------------------------------------------------------------------
// 3-6. manifest validation
// ---------------------------------------------------------------------------

test("validateTree passes only when every required file exists and is nonzero", () => {
  const dir = tmp();
  mkdirSync(path.join(dir, "bin"), { recursive: true });
  writeFileSync(path.join(dir, "bin", "a.exe"), "x");

  assert.deepEqual(validateTree(dir, ["bin/a.exe"]).missing, []);
  assert.equal(validateTree(dir, ["bin/a.exe"]).ok, true);

  const missing = validateTree(dir, ["bin/a.exe", "bin/b.exe"]);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ["bin/b.exe"]);
});

test("validateTree fails a zero-byte required file", () => {
  const dir = tmp();
  mkdirSync(path.join(dir, "bin"), { recursive: true });
  writeFileSync(path.join(dir, "bin", "a.exe"), "");
  const result = validateTree(dir, ["bin/a.exe"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.empty, ["bin/a.exe"]);
});

test("validateTree rejects a required path that escapes the root", () => {
  const dir = tmp();
  const result = validateTree(dir, ["../outside.exe"]);
  assert.equal(result.ok, false);
  assert.equal(result.escaped.length, 1);
});

test("validateTree fails an empty tree", () => {
  const dir = tmp();
  assert.equal(validateTree(dir, ["bin/a.exe"]).ok, false);
});

test("installSource fails when a required binary is missing from the archive", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const entries = standardFixtureEntries().filter((e) => e.name !== "bin/photo-tool.exe");
  const zipPath = writeFixture(dir, entries);

  await assert.rejects(() => installSource(baseInstallArgs(root, zipPath)), /photo-tool\.exe/);
  assert.equal(existsSync(path.join(root, "resources", "bin", "win", "photo-tool.exe")), false);
});

test("installSource fails when a required model file is missing from the archive", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const entries = standardFixtureEntries().filter((e) => e.name !== "models/anime/model.param");
  const zipPath = writeFixture(dir, entries);

  await assert.rejects(() => installSource(baseInstallArgs(root, zipPath)), /anime[\\/]model\.param/);
});

test("installSource fails when a required file is zero bytes", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const entries = standardFixtureEntries().map((e) =>
    e.name === "models/photo/model.param" ? { ...e, data: "" } : e,
  );
  const zipPath = writeFixture(dir, entries);

  await assert.rejects(() => installSource(baseInstallArgs(root, zipPath)), /empty|zero/i);
});

// ---------------------------------------------------------------------------
// 7-9. no-output extractor, partial publication, temp cleanup
// ---------------------------------------------------------------------------

test("an extractor that resolves without producing files cannot yield success", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const zipPath = writeFixture(dir);

  await assert.rejects(
    () => installSource(baseInstallArgs(root, zipPath, { extract: async () => {} })),
    /extraction produced no files/,
  );
  assert.equal(existsSync(path.join(root, "resources", "bin", "win")), false);
});

test("partial extraction is never published to the final destination", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const zipPath = writeFixture(dir);

  // Extractor produces the binary but no models at all.
  const partial = async (_zip, dest) => {
    mkdirSync(path.join(dest, "bin"), { recursive: true });
    writeFileSync(path.join(dest, "bin", "photo-tool.exe"), "PARTIAL");
  };

  await assert.rejects(() => installSource(baseInstallArgs(root, zipPath, { extract: partial })));
  assert.equal(existsSync(path.join(root, "resources", "bin", "win", "photo-tool.exe")), false);
  assert.equal(existsSync(path.join(root, "resources", "models", "photo")), false);
});

test("temporary extraction directory is removed after failure", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const workRoot = path.join(dir, "work");
  mkdirSync(workRoot, { recursive: true });
  const zipPath = writeFixture(dir);

  await assert.rejects(() =>
    installSource(baseInstallArgs(root, zipPath, { extract: async () => {}, workRoot })),
  );
  assert.deepEqual(readdirSync(workRoot), [], "temporary extraction directory was left behind");
});

test("temporary extraction directory is removed after success", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const workRoot = path.join(dir, "work");
  mkdirSync(workRoot, { recursive: true });
  const zipPath = writeFixture(dir);

  await installSource(baseInstallArgs(root, zipPath, { workRoot }));
  assert.deepEqual(readdirSync(workRoot), []);
});

// ---------------------------------------------------------------------------
// 10-11, 14-15. success, idempotency, spaces, unrelated files
// ---------------------------------------------------------------------------

test("successful extraction publishes the complete payload", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const zipPath = writeFixture(dir);

  await installSource(baseInstallArgs(root, zipPath));

  const bin = path.join(root, "resources", "bin", "win", "photo-tool.exe");
  assert.ok(existsSync(bin));
  assert.equal(readFileSync(bin, "utf8"), "PHOTO-BINARY-CONTENT");
  assert.ok(existsSync(path.join(root, "resources", "models", "photo", "photo", "model.param")));
  assert.ok(existsSync(path.join(root, "resources", "models", "photo", "anime", "model.param")));
});

test("repeated successful execution is idempotent", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const zipPath = writeFixture(dir);

  const first = await installSource(baseInstallArgs(root, zipPath));
  const second = await installSource(baseInstallArgs(root, zipPath));

  assert.equal(first.installed, true);
  assert.equal(second.skipped, true, "second run should detect a complete payload and skip");
  assert.equal(
    readFileSync(path.join(root, "resources", "bin", "win", "photo-tool.exe"), "utf8"),
    "PHOTO-BINARY-CONTENT",
  );
});

test("a re-run repairs an incomplete existing payload instead of skipping", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const zipPath = writeFixture(dir);

  await installSource(baseInstallArgs(root, zipPath));
  await rm(path.join(root, "resources", "models", "photo"), { recursive: true, force: true });

  const result = await installSource(baseInstallArgs(root, zipPath));
  assert.equal(result.installed, true);
  assert.ok(existsSync(path.join(root, "resources", "models", "photo", "photo", "model.param")));
});

test("paths containing spaces work correctly", async () => {
  const dir = tmp("cove dl test ");
  const root = path.join(dir, "my project root");
  const zipPath = writeFixture(dir, standardFixtureEntries(), "my fixture.zip");

  await installSource(baseInstallArgs(root, zipPath));

  assert.ok(existsSync(path.join(root, "resources", "bin", "win", "photo-tool.exe")));
  assert.ok(existsSync(path.join(root, "resources", "models", "photo", "photo", "model.param")));
});

test("existing files outside the managed payload are not deleted", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const binDir = path.join(root, "resources", "bin", "win");
  const otherModels = path.join(root, "resources", "models", "unrelated");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(otherModels, { recursive: true });
  writeFileSync(path.join(binDir, "keep-me.txt"), "keep");
  writeFileSync(path.join(otherModels, "keep-me.txt"), "keep");
  const zipPath = writeFixture(dir);

  await installSource(baseInstallArgs(root, zipPath));

  assert.ok(existsSync(path.join(binDir, "keep-me.txt")), "unrelated bin file was deleted");
  assert.ok(existsSync(path.join(otherModels, "keep-me.txt")), "unrelated models dir was deleted");
});

// ---------------------------------------------------------------------------
// 12-13. top-level exit code and success ordering
// ---------------------------------------------------------------------------

test("runCli returns a nonzero exit code when a phase fails", async () => {
  const dir = tmp();
  const logs = [];
  const code = await runCli(["win"], {
    root: path.join(dir, "root"),
    log: (m) => logs.push(m),
    downloadArchive: async () => {
      throw new Error("boom");
    },
  });

  assert.notEqual(code, 0);
  assert.ok(logs.join("\n").includes("boom"));
  assert.ok(!logs.join("\n").includes("Complete"), "success was reported despite failure");
});

test("runCli does not print Complete before postcondition validation", async () => {
  const dir = tmp();
  const logs = [];
  const code = await runCli(["win"], {
    root: path.join(dir, "root"),
    log: (m) => logs.push(m),
    downloadArchive: async () => writeFixture(dir),
    extract: async () => {}, // resolves, produces nothing
  });

  assert.notEqual(code, 0);
  const joined = logs.join("\n");
  assert.ok(joined.includes("Validating"), "validation phase was not reached");
  assert.ok(!joined.includes("Complete"));
});

test("importing the script does not execute the bootstrap", async () => {
  // The module was imported at the top of this file; if the entry-point guard
  // were missing, that import would have triggered real network downloads.
  assert.equal(typeof mod.runCli, "function");
});

test("the script exits nonzero when the bootstrap fails", async () => {
  const url = pathToFileURL(SCRIPT).href;
  const code = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        "-e",
        `import(${JSON.stringify(url)}).then(async (m) => {
           const c = await m.runCli(["win"], {
             root: ${JSON.stringify(tmp())},
             log: () => {},
             downloadArchive: async () => { throw new Error("no network"); },
           });
           process.exitCode = c;
         })`,
      ],
      (_err, _stdout, _stderr) => {},
    ).on("close", resolve);
  });
  assert.notEqual(code, 0);
});

// ---------------------------------------------------------------------------
// real manifest: must match what electron/upscaler.ts actually invokes
// ---------------------------------------------------------------------------

test("the Windows manifest requires the exact runtime binaries and models", () => {
  const esrgan = requiredRelPaths(PLATFORMS.win, SOURCES.realesrgan);
  assert.ok(esrgan.bin.includes("realesrgan-ncnn-vulkan.exe"));
  assert.ok(esrgan.bin.includes("vcomp140.dll"));
  // Photo runs `-n realesrgan-x4plus`.
  assert.ok(esrgan.models.includes("realesrgan-x4plus.param"));
  assert.ok(esrgan.models.includes("realesrgan-x4plus.bin"));

  const cugan = requiredRelPaths(PLATFORMS.win, SOURCES.realcugan);
  assert.ok(cugan.bin.includes("realcugan-ncnn-vulkan.exe"));
  assert.ok(cugan.bin.includes("vcomp140.dll"));
  // Anime resolves models under models-se; -n 2 at 2x, -n 0 at 3x/4x.
  for (const rel of [
    "models-se/up2x-denoise2x.param",
    "models-se/up2x-denoise2x.bin",
    "models-se/up3x-no-denoise.param",
    "models-se/up3x-no-denoise.bin",
    "models-se/up4x-no-denoise.param",
    "models-se/up4x-no-denoise.bin",
  ]) {
    assert.ok(cugan.models.includes(rel), `missing required model ${rel}`);
  }
});

// ---------------------------------------------------------------------------
// Codex finding 1: required paths must be regular files, not directories
// ---------------------------------------------------------------------------

test("validateTree rejects a directory standing in for a required file", () => {
  const dir = tmp();
  mkdirSync(path.join(dir, "bin", "a.exe"), { recursive: true });

  const result = validateTree(dir, ["bin/a.exe"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.invalidType, ["bin/a.exe"]);
  assert.deepEqual(result.missing, [], "a directory must not be reported as missing");
  assert.deepEqual(result.empty, []);
});

test("a directory at a required binary path fails installSource", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const zipPath = writeFixture(dir);

  // Extractor stages a directory where the binary belongs.
  const extract = async (_zip, dest) => {
    mkdirSync(path.join(dest, "bin", "photo-tool.exe"), { recursive: true });
    mkdirSync(path.join(dest, "models", "photo"), { recursive: true });
    writeFileSync(path.join(dest, "models", "photo", "model.param"), "p");
    mkdirSync(path.join(dest, "models", "anime"), { recursive: true });
    writeFileSync(path.join(dest, "models", "anime", "model.param"), "a");
  };

  // Fails and names the path — either at binary discovery or at validation;
  // what matters is that a directory never satisfies the requirement.
  await assert.rejects(
    () => installSource(baseInstallArgs(root, zipPath, { extract })),
    /photo-tool\.exe/,
  );
  assert.equal(existsSync(path.join(root, "resources", "bin", "win")), false);
});

test("a directory at a required model path fails installSource", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const entries = standardFixtureEntries().filter((e) => e.name !== "models/anime/model.param");
  // models/anime/model.param arrives as a directory instead of a file.
  entries.push({ name: "models/anime/model.param/", dir: true });
  const zipPath = writeFixture(dir, entries);

  await assert.rejects(
    () => installSource(baseInstallArgs(root, zipPath)),
    /not a regular file.*anime[\\/]model\.param/s,
  );
  assert.equal(existsSync(path.join(root, "resources", "models", "photo")), false);
});

test("an invalid-type installed path triggers repair instead of an idempotent skip", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const zipPath = writeFixture(dir);

  await installSource(baseInstallArgs(root, zipPath));

  // Replace the installed binary with a directory.
  const binPath = path.join(root, "resources", "bin", "win", "photo-tool.exe");
  await rm(binPath, { force: true });
  mkdirSync(binPath, { recursive: true });

  const result = await installSource(baseInstallArgs(root, zipPath));
  assert.equal(result.installed, true, "a directory must not satisfy the skip check");
  assert.equal(result.skipped, false);
  assert.equal(readFileSync(binPath, "utf8"), "PHOTO-BINARY-CONTENT");
});

test("valid regular nonzero files still pass validation", () => {
  const dir = tmp();
  mkdirSync(path.join(dir, "bin"), { recursive: true });
  writeFileSync(path.join(dir, "bin", "a.exe"), "content");
  const result = validateTree(dir, ["bin/a.exe"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.invalidType, []);
});

// ---------------------------------------------------------------------------
// Codex finding 2: timeout must actually cancel, and cleanup must wait for it
// ---------------------------------------------------------------------------

test("withTimeout aborts the signal and waits for the operation to settle", async () => {
  const order = [];
  await assert.rejects(
    () =>
      withTimeout(
        (signal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => {
              order.push("cancelled");
              setTimeout(() => {
                order.push("settled");
                resolve();
              }, 20);
            });
          }),
        20,
        "slow phase",
        { graceMs: 2000 },
      ),
    /timed out/i,
  );
  assert.deepEqual(order, ["cancelled", "settled"], "rejected before the operation unwound");
});

test("withTimeout still rejects if a cancelled operation never unwinds", async () => {
  await assert.rejects(
    () => withTimeout(() => new Promise(() => {}), 10, "wedged phase", { graceMs: 40 }),
    /did not cancel within/i,
  );
});

test("withTimeout leaves successful operations unaffected", async () => {
  const value = await withTimeout(async (signal) => {
    assert.equal(signal.aborted, false);
    return "ok";
  }, 5000, "fast phase");
  assert.equal(value, "ok");
});

test("a timed-out extraction stops writing before the work directory is removed", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const workRoot = path.join(dir, "work");
  mkdirSync(workRoot, { recursive: true });
  const zipPath = writeFixture(dir);

  const order = [];
  let writesAfterCancel = 0;
  let stillWriting = false;

  // Simulates an extractor streaming into the work dir until cancelled.
  const extract = (_zip, dest, opts) =>
    withTimeout(
      (signal) =>
        new Promise((resolve) => {
          mkdirSync(dest, { recursive: true });
          let cancelled = false;
          const iv = setInterval(() => {
            if (cancelled) writesAfterCancel++;
            try {
              writeFileSync(path.join(dest, "chunk.bin"), String(Date.now()));
            } catch {
              stillWriting = true; // writing after the dir vanished
            }
          }, 2);
          signal.addEventListener("abort", () => {
            cancelled = true;
            clearInterval(iv);
            order.push("cancelled");
            setTimeout(() => {
              order.push("settled");
              resolve();
            }, 15);
          });
        }),
      opts.timeoutMs,
      "simulated extraction",
      { graceMs: 2000 },
    );

  await assert.rejects(
    () => installSource(baseInstallArgs(root, zipPath, { extract, workRoot, timeoutMs: 20 })),
    /timed out/i,
  );
  order.push("cleaned");

  assert.deepEqual(order, ["cancelled", "settled", "cleaned"]);
  assert.equal(writesAfterCancel, 0, "extractor kept writing after cancellation");
  assert.equal(stillWriting, false);
  assert.deepEqual(readdirSync(workRoot), [], "work directory not cleaned after timeout");
  assert.equal(existsSync(path.join(root, "resources")), false, "partial payload was published");
});

test("a timed-out download stops writing before cleanup", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const workRoot = path.join(dir, "work");
  mkdirSync(workRoot, { recursive: true });

  const order = [];
  let writesAfterCancel = 0;

  const downloadArchive = (_url, destPath) =>
    withTimeout(
      (signal) =>
        new Promise((resolve) => {
          let cancelled = false;
          const iv = setInterval(() => {
            if (cancelled) writesAfterCancel++;
            try {
              writeFileSync(destPath, "partial");
            } catch {
              /* dir gone */
            }
          }, 2);
          signal.addEventListener("abort", () => {
            cancelled = true;
            clearInterval(iv);
            order.push("cancelled");
            setTimeout(() => {
              order.push("settled");
              resolve(destPath);
            }, 15);
          });
        }),
      20,
      "simulated download",
      { graceMs: 2000 },
    );

  await assert.rejects(
    () => installSource(baseInstallArgs(root, "unused", { downloadArchive, workRoot })),
    /timed out/i,
  );
  order.push("cleaned");

  assert.deepEqual(order, ["cancelled", "settled", "cleaned"]);
  assert.equal(writesAfterCancel, 0);
  assert.deepEqual(readdirSync(workRoot), []);
});

test("a cancelled yauzl-style operation tears down its tracked resources", async () => {
  const closed = [];
  await assert.rejects(
    () =>
      withTimeout(
        (signal) =>
          new Promise((resolve, reject) => {
            const resources = { readStream: false, writeStream: false, zipfile: false };
            signal.addEventListener("abort", () => {
              resources.readStream = true;
              resources.writeStream = true;
              resources.zipfile = true;
              closed.push(resources);
              reject(new Error("cancelled"));
            });
          }),
        10,
        "yauzl-style extraction",
        { graceMs: 1000 },
      ),
    /timed out/i,
  );
  assert.equal(closed.length, 1);
  assert.deepEqual(closed[0], { readStream: true, writeStream: true, zipfile: true });
});

test(
  "PowerShell extraction timeout kills the child and removes its script dir",
  { skip: process.platform !== "win32" ? "windows only" : false },
  async () => {
    const dir = tmp();
    const zipPath = writeFixture(dir);
    const dest = path.join(dir, "extract");

    await assert.rejects(
      () => mod.extractWithPowerShell(zipPath, dest, { timeoutMs: 1, graceMs: 20000 }),
      /timed out/i,
    );

    // The script dir is created beside `dest` and removed in `finally`, which
    // only runs once the killed child has closed.
    const leftovers = readdirSync(dir).filter((n) => n.startsWith("ps-"));
    assert.deepEqual(leftovers, [], "PowerShell script directory left behind");
  },
);

test("runCli exits nonzero and prints no Complete after a timeout", async () => {
  const dir = tmp();
  const logs = [];
  const code = await runCli(["win"], {
    root: path.join(dir, "root"),
    workRoot: dir,
    log: (m) => logs.push(m),
    downloadArchive: async () => writeFixture(dir),
    extract: (_zip, _dest, opts) =>
      withTimeout(() => new Promise(() => {}), opts.timeoutMs, "wedged extraction", {
        graceMs: 50,
      }),
    timeoutMs: 20,
  });

  assert.notEqual(code, 0);
  const joined = logs.join("\n");
  assert.match(joined, /timed out/i);
  assert.ok(!joined.includes("Complete"), "success reported after a timeout");
});

// ---------------------------------------------------------------------------
// Codex repair loop 2: yauzl teardown must complete before rejection
// ---------------------------------------------------------------------------

/**
 * Controlled stand-in for a Node stream: `destroy()` does NOT close
 * synchronously — `close` is emitted only when the test says so, which is
 * exactly the race the fix has to close.
 */
function mockStream(name, events) {
  const s = new EventEmitter();
  s.name = name;
  s.closed = false;
  s.destroyed = false;
  s.destroy = () => {
    s.destroyed = true;
    events.push(`${name}:destroy`);
  };
  s.finishClose = () => {
    if (s.closed) return;
    s.closed = true;
    events.push(`${name}:close`);
    s.emit("close");
  };
  return s;
}

function mockZip(events) {
  const z = new EventEmitter();
  z.isOpen = true;
  z.close = () => {
    events.push("zipfile:close-called");
  };
  z.finishClose = () => {
    if (!z.isOpen) return;
    z.isOpen = false;
    events.push("zipfile:close");
    z.emit("close");
  };
  return z;
}

test("teardown destroys read stream, write stream and zip handle", async () => {
  const events = [];
  const readStream = mockStream("read", events);
  const writeStream = mockStream("write", events);
  const zipfile = mockZip(events);

  const done = closeExtractionResources({ readStream, writeStream, zipfile }, { deadlineMs: 2000 });

  // Close them in order as the real teardown walks the list.
  await sleep(5);
  assert.equal(readStream.destroyed, true, "read stream was not destroyed");
  readStream.finishClose();
  await sleep(5);
  assert.equal(writeStream.destroyed, true, "write stream was not destroyed");
  writeStream.finishClose();
  await sleep(5);
  assert.ok(events.includes("zipfile:close-called"), "zip handle close was not requested");
  zipfile.finishClose();

  const { order, unclosed } = await done;
  assert.deepEqual(order, ["read stream", "write stream", "zipfile"]);
  assert.deepEqual(unclosed, []);
});

test("teardown stays pending until the read stream closes", async () => {
  const events = [];
  const readStream = mockStream("read", events);
  let settled = false;
  const done = closeExtractionResources({ readStream }, { deadlineMs: 2000 }).then((r) => {
    settled = true;
    return r;
  });

  await sleep(30);
  assert.equal(settled, false, "teardown completed before the read stream closed");
  readStream.finishClose();
  const { order } = await done;
  assert.deepEqual(order, ["read stream"]);
});

test("teardown stays pending until the write stream closes", async () => {
  const events = [];
  const writeStream = mockStream("write", events);
  let settled = false;
  const done = closeExtractionResources({ writeStream }, { deadlineMs: 2000 }).then((r) => {
    settled = true;
    return r;
  });

  await sleep(30);
  assert.equal(settled, false, "teardown completed before the write stream closed");
  writeStream.finishClose();
  await done;
});

test("teardown stays pending until the zip handle closes", async () => {
  const events = [];
  const zipfile = mockZip(events);
  let settled = false;
  const done = closeExtractionResources({ zipfile }, { deadlineMs: 2000 }).then((r) => {
    settled = true;
    return r;
  });

  await sleep(30);
  assert.equal(settled, false, "teardown completed before the zip handle closed");
  zipfile.finishClose();
  await done;
});

test("teardown reports resources that refuse to close", async () => {
  const events = [];
  const readStream = mockStream("read", events); // never closes
  const { order, unclosed } = await closeExtractionResources(
    { readStream, writeStream: mockStream("write", events), zipfile: mockZip(events) },
    { deadlineMs: 40 },
  );
  assert.deepEqual(order, []);
  assert.ok(unclosed.includes("read stream"), "stuck read stream not named");
  assert.equal(unclosed.length, 3, "all unclosed resources should be reported");
});

test("late teardown errors do not become unhandled exceptions", async () => {
  const events = [];
  const readStream = mockStream("read", events);
  const done = closeExtractionResources({ readStream }, { deadlineMs: 2000 });

  await sleep(5);
  // A cancelled stream legitimately errors during teardown.
  readStream.emit("error", new Error("ECANCELED"));
  readStream.finishClose();
  await done; // would reject / crash the process if the error were unhandled
});

test("installSource waits for all tracked resources to close before cleanup", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const workRoot = path.join(dir, "work");
  mkdirSync(workRoot, { recursive: true });
  const zipPath = writeFixture(dir);

  const events = [];
  let extractDest = null;
  let writesAfterCleanup = 0;

  // Extractor that holds resources open past the abort, mirroring yauzl.
  const extract = (_zip, dest, opts) =>
    withTimeout(
      (signal) =>
        new Promise((resolve, reject) => {
          extractDest = dest;
          mkdirSync(dest, { recursive: true });
          const readStream = mockStream("read", events);
          const writeStream = mockStream("write", events);
          const zipfile = mockZip(events);

          signal.addEventListener("abort", () => {
            events.push("abort");
            closeExtractionResources(
              { readStream, writeStream, zipfile },
              { deadlineMs: 2000 },
            ).then(({ unclosed }) => {
              events.push("settle");
              reject(new Error(`cancelled; unclosed: ${unclosed.join(",") || "none"}`));
            });

            // Each resource closes only after a delay — cleanup must wait.
            setTimeout(() => readStream.finishClose(), 10);
            setTimeout(() => writeStream.finishClose(), 20);
            setTimeout(() => {
              // A write attempted just before the handle closes must still land
              // inside a directory that has NOT yet been removed.
              try {
                writeFileSync(path.join(dest, "late.bin"), "x");
              } catch {
                writesAfterCleanup++;
              }
              zipfile.finishClose();
            }, 30);
          });
        }),
      opts.timeoutMs,
      "mock yauzl extraction",
      { graceMs: 5000 },
    );

  await assert.rejects(
    () => installSource(baseInstallArgs(root, zipPath, { extract, workRoot, timeoutMs: 10 })),
    /timed out/i,
  );
  events.push("cleanup");

  assert.deepEqual(events, [
    "abort",
    "read:destroy",
    "read:close",
    "write:destroy",
    "write:close",
    "zipfile:close-called",
    "zipfile:close",
    "settle",
    "cleanup",
  ]);
  assert.equal(writesAfterCleanup, 0, "work directory was removed while a resource was still live");
  assert.deepEqual(readdirSync(workRoot), [], "work directory not cleaned after teardown");
  assert.equal(existsSync(path.join(extractDest, "late.bin")), false, "extraction dir survived");
  assert.equal(existsSync(path.join(root, "resources")), false);
});

// ---------------------------------------------------------------------------
// Codex repair loop 3: a late yauzl.open callback must not outlive teardown
// ---------------------------------------------------------------------------

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Controlled ZipFile stand-in whose close() completes only on demand. */
function controlledZip(events, label = "zipfile") {
  const z = new EventEmitter();
  z.isOpen = true;
  z.readEntryCalls = 0;
  z.readEntry = () => {
    z.readEntryCalls++;
    events.push(`${label}:readEntry`);
  };
  z.openReadStream = () => {
    events.push(`${label}:openReadStream`);
  };
  z.close = () => {
    events.push(`${label}:close-requested`);
  };
  z.finishClose = () => {
    if (!z.isOpen) return;
    z.isOpen = false;
    events.push(`${label}:close-emitted`);
    z.emit("close");
  };
  return z;
}

// Captures the most recently created controlled zip so a test body can drive
// its close after the extractor has taken ownership of it.
let lastControlledZip = null;
function makeControlledZip(events, label) {
  lastControlledZip = controlledZip(events, label);
  return lastControlledZip;
}

test("cancellation before the open callback does not settle immediately", async () => {
  const dir = tmp();
  const events = [];
  const gate = deferred();
  let settled = false;

  const promise = mod
    .extractWithYauzl(path.join(dir, "x.zip"), path.join(dir, "out"), {
      timeoutMs: 15,
      graceMs: 5000,
      teardownMs: 3000,
      // Callback is withheld until the test releases it.
      openZip: (_p, _o, cb) => {
        gate.promise.then(() => cb(null, makeControlledZip(events)));
      },
    })
    .catch((err) => {
      settled = true;
      return err;
    });

  await sleep(80); // well past the 15ms timeout
  assert.equal(settled, false, "settled while the open callback was still outstanding");

  gate.resolve();
  await sleep(20);
  assert.equal(settled, false, "settled before the late ZipFile finished closing");

  assert.ok(events.includes("zipfile:close-requested"), "late handle was not asked to close");
  assert.equal(events.includes("zipfile:readEntry"), false, "started reading after cancellation");
  assert.equal(events.includes("zipfile:openReadStream"), false, "opened a stream after cancel");

  lastControlledZip.finishClose();

  const err = await promise;
  assert.match(String(err.message), /timed out/i);
  assert.deepEqual(events, ["zipfile:close-requested", "zipfile:close-emitted"]);
});

test("a late open callback error settles cancellation safely", async () => {
  const dir = tmp();
  const gate = deferred();

  const promise = mod.extractWithYauzl(path.join(dir, "x.zip"), path.join(dir, "out"), {
    timeoutMs: 10,
    graceMs: 5000,
    teardownMs: 3000,
    openZip: (_p, _o, cb) => {
      gate.promise.then(() => cb(new Error("ENOENT: bad archive")));
    },
  });

  await sleep(50);
  gate.resolve();
  await assert.rejects(() => promise, /timed out/i);
});

test("a pending open callback that never arrives is bounded and names the pending open", async () => {
  const dir = tmp();
  await assert.rejects(
    () =>
      mod.extractWithYauzl(path.join(dir, "x.zip"), path.join(dir, "out"), {
        timeoutMs: 10,
        graceMs: 10000,
        teardownMs: 60,
        openZip: () => {
          /* callback never invoked */
        },
      }),
    (err) => {
      assert.match(String(err.message), /timed out/i);
      assert.match(String(err.cause?.message ?? ""), /pending ZIP open did not settle/i);
      return true;
    },
  );
});

test("late ZipFile errors during cancellation do not become unhandled exceptions", async () => {
  const dir = tmp();
  const events = [];
  const gate = deferred();

  const promise = mod.extractWithYauzl(path.join(dir, "x.zip"), path.join(dir, "out"), {
    timeoutMs: 10,
    graceMs: 5000,
    teardownMs: 3000,
    openZip: (_p, _o, cb) => {
      gate.promise.then(() => {
        const z = makeControlledZip(events);
        cb(null, z);
        // A handle that errors while being torn down.
        z.emit("error", new Error("EBADF during close"));
        setTimeout(() => z.finishClose(), 5);
      });
    },
  });

  await sleep(40);
  gate.resolve();
  await assert.rejects(() => promise, /timed out/i);
});

test("installSource waits for a late ZipFile to close before removing the work dir", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const workRoot = path.join(dir, "work");
  mkdirSync(workRoot, { recursive: true });
  const zipPath = writeFixture(dir);

  const events = [];
  const gate = deferred();
  let extractDest = null;
  let writesAfterCleanup = 0;

  const extract = (zip, dest, o) => {
    extractDest = dest;
    mkdirSync(dest, { recursive: true });
    return mod.extractWithYauzl(zip, dest, {
      timeoutMs: o.timeoutMs,
      graceMs: 5000,
      teardownMs: 3000,
      openZip: (_p, _opts, cb) => {
        gate.promise.then(() => {
          const z = makeControlledZip(events);
          const originalClose = z.close;
          z.close = () => {
            originalClose();
            // The handle is still open here: the work dir must still exist.
            try {
              writeFileSync(path.join(dest, "late.bin"), "x");
            } catch {
              writesAfterCleanup++;
            }
            setTimeout(() => z.finishClose(), 15);
          };
          cb(null, z);
        });
      },
    });
  };

  const running = installSource(
    baseInstallArgs(root, zipPath, { extract, workRoot, timeoutMs: 15 }),
  );
  await sleep(60);
  gate.resolve();

  await assert.rejects(() => running, /timed out/i);
  events.push("cleanup");

  assert.deepEqual(events, [
    "zipfile:close-requested",
    "zipfile:close-emitted",
    "cleanup",
  ]);
  assert.equal(writesAfterCleanup, 0, "work dir removed while the late handle was open");
  assert.equal(events.includes("zipfile:readEntry"), false);
  assert.deepEqual(readdirSync(workRoot), [], "work directory not cleaned");
  assert.equal(existsSync(path.join(extractDest, "late.bin")), false);
  assert.equal(existsSync(path.join(root, "resources")), false);
});

test("real yauzl extraction resolves on a valid archive", async () => {
  const dir = tmp();
  const zipPath = writeFixture(dir);
  const dest = path.join(dir, "yauzl-out");

  await mod.extractWithYauzl(zipPath, dest, { timeoutMs: 30000 });

  assert.equal(
    readFileSync(path.join(dest, "bin", "anime-tool.exe"), "utf8"),
    "ANIME-BINARY-CONTENT".repeat(64),
  );
  assert.ok(existsSync(path.join(dest, "models", "photo", "model.param")));
});

test("real yauzl extraction rejects on a corrupt archive", async () => {
  const dir = tmp();
  const bad = path.join(dir, "bad.zip");
  writeFileSync(bad, buildZip(standardFixtureEntries()).subarray(0, 200));
  await assert.rejects(() => mod.extractWithYauzl(bad, path.join(dir, "out"), { timeoutMs: 30000 }));
});

test("the Linux manifest does not require Windows-only files", () => {
  const esrgan = requiredRelPaths(PLATFORMS.linux, SOURCES.realesrgan);
  assert.ok(esrgan.bin.includes("realesrgan-ncnn-vulkan"));
  assert.ok(!esrgan.bin.some((p) => p.endsWith(".exe")), "Linux manifest requires a .exe");
  assert.ok(!esrgan.bin.some((p) => p.endsWith(".dll")), "Linux manifest requires a .dll");
});

// ---------------------------------------------------------------------------
// symlink hardening: validation walk
// ---------------------------------------------------------------------------

/**
 * Creates a real symlink, or returns the errno string when the platform will
 * not allow one (Windows without Developer Mode / SeCreateSymbolicLink).
 * Callers skip the individual test explicitly rather than passing silently.
 */
function trySymlink(target, linkPath, type) {
  try {
    symlinkSync(target, linkPath, type);
    return true;
  } catch (err) {
    if (err.code === "EPERM" || err.code === "EACCES" || err.code === "ENOSYS") return err.code;
    throw err;
  }
}

function skipReason(code) {
  return `symlink creation unavailable: ${code}; Windows Developer Mode or symbolic-link privilege may be required`;
}

test("validateTree rejects a required file that is a symlink to an external file", (t) => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const outside = path.join(dir, "outside.exe");
  mkdirSync(path.join(root, "bin"), { recursive: true });
  writeFileSync(outside, "EXTERNAL");
  const made = trySymlink(outside, path.join(root, "bin", "a.exe"), "file");
  if (made !== true) return t.skip(skipReason(made));

  const result = validateTree(root, ["bin/a.exe"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.symlink, [{ rel: "bin/a.exe", at: "bin/a.exe" }]);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.invalidType, []);
});

test("validateTree rejects a required file that is a symlink to an in-tree file", (t) => {
  const dir = tmp();
  const root = path.join(dir, "root");
  mkdirSync(path.join(root, "bin"), { recursive: true });
  writeFileSync(path.join(root, "bin", "real.exe"), "REAL");
  const made = trySymlink(path.join(root, "bin", "real.exe"), path.join(root, "bin", "a.exe"), "file");
  if (made !== true) return t.skip(skipReason(made));

  const result = validateTree(root, ["bin/a.exe"]);
  assert.equal(result.ok, false);
  assert.equal(result.symlink.length, 1);
});

test("validateTree rejects a required model file that is a symlink", (t) => {
  const dir = tmp();
  const root = path.join(dir, "models-root");
  const outside = path.join(dir, "external.param");
  mkdirSync(path.join(root, "photo"), { recursive: true });
  writeFileSync(outside, "EXTERNAL-MODEL");
  const made = trySymlink(outside, path.join(root, "photo", "model.param"), "file");
  if (made !== true) return t.skip(skipReason(made));

  const result = validateTree(root, ["photo/model.param"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.symlink, [{ rel: "photo/model.param", at: "photo/model.param" }]);
});

test("validateTree rejects a required file beneath a symlinked parent directory", (t) => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const outsideBin = path.join(dir, "outside-bin");
  mkdirSync(root, { recursive: true });
  mkdirSync(outsideBin, { recursive: true });
  writeFileSync(path.join(outsideBin, "a.exe"), "EXTERNAL");
  const made = trySymlink(outsideBin, path.join(root, "bin"), "dir");
  if (made !== true) return t.skip(skipReason(made));

  const result = validateTree(root, ["bin/a.exe"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.symlink, [{ rel: "bin/a.exe", at: "bin" }]);
  assert.deepEqual(result.missing, []);
});

test("validateTree rejects a symlinked model subtree", (t) => {
  const dir = tmp();
  const root = path.join(dir, "models-root");
  const outside = path.join(dir, "external-se");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "up2x-denoise2x.param"), "SE");
  const made = trySymlink(outside, path.join(root, "models-se"), "dir");
  if (made !== true) return t.skip(skipReason(made));

  const result = validateTree(root, ["models-se/up2x-denoise2x.param"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.symlink, [
    { rel: "models-se/up2x-denoise2x.param", at: "models-se" },
  ]);
});

test("validateTree reports a broken symlink as a symlink, not as missing", (t) => {
  const dir = tmp();
  const root = path.join(dir, "root");
  mkdirSync(path.join(root, "bin"), { recursive: true });
  const made = trySymlink(path.join(dir, "gone.exe"), path.join(root, "bin", "a.exe"), "file");
  if (made !== true) return t.skip(skipReason(made));

  const result = validateTree(root, ["bin/a.exe"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.symlink, [{ rel: "bin/a.exe", at: "bin/a.exe" }]);
  assert.deepEqual(result.missing, [], "a broken symlink must not be reported as merely missing");
});

test("validateTree reports a symlink to a directory as a symlink, not an invalid type", (t) => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const outside = path.join(dir, "outside-dir");
  mkdirSync(path.join(root, "bin"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  const made = trySymlink(outside, path.join(root, "bin", "a.exe"), "dir");
  if (made !== true) return t.skip(skipReason(made));

  const result = validateTree(root, ["bin/a.exe"]);
  assert.equal(result.ok, false);
  assert.equal(result.symlink.length, 1);
  assert.deepEqual(result.invalidType, []);
});

test("validateTree still passes ordinary real nonempty files in nested real directories", () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  mkdirSync(path.join(root, "models", "photo"), { recursive: true });
  writeFileSync(path.join(root, "models", "photo", "model.param"), "M");
  const result = validateTree(root, ["models/photo/model.param"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.symlink, []);
});

test("validateTree accepts a root reached through a symlinked ancestor", (t) => {
  const dir = tmp();
  const real = path.join(dir, "real");
  mkdirSync(path.join(real, "root", "bin"), { recursive: true });
  writeFileSync(path.join(real, "root", "bin", "a.exe"), "X");
  const made = trySymlink(real, path.join(dir, "link"), "dir");
  if (made !== true) return t.skip(skipReason(made));

  const result = validateTree(path.join(dir, "link", "root"), ["bin/a.exe"]);
  assert.equal(result.ok, true, "a symlink at or above the root must stay legal");
});

test("validateTree accepts a root that is itself a symlink", (t) => {
  const dir = tmp();
  const real = path.join(dir, "real-root");
  mkdirSync(path.join(real, "bin"), { recursive: true });
  writeFileSync(path.join(real, "bin", "a.exe"), "X");
  const made = trySymlink(real, path.join(dir, "root-link"), "dir");
  if (made !== true) return t.skip(skipReason(made));

  assert.equal(validateTree(path.join(dir, "root-link"), ["bin/a.exe"]).ok, true);
});

test("symlink diagnostics name the manifest path and the offending component", async (t) => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const outside = path.join(dir, "external-se");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "up2x-denoise2x.param"), "SE");
  const made = trySymlink(outside, path.join(root, "models-se"), "dir");
  if (made !== true) return t.skip(skipReason(made));

  // The staged/installed assertions surface this text through installSource;
  // here the message itself is checked against a known symlinked parent.
  const zipPath = writeFixture(dir);
  const extract = async (zip, outDir) => {
    mkdirSync(path.join(outDir, "bin"), { recursive: true });
    writeFileSync(path.join(outDir, "bin", "photo-tool.exe"), "P");
    mkdirSync(path.join(outDir, "models"), { recursive: true });
    trySymlink(outside, path.join(outDir, "models", "photo"), "dir");
    mkdirSync(path.join(outDir, "models", "anime"), { recursive: true });
    writeFileSync(path.join(outDir, "models", "anime", "model.param"), "M");
  };

  await assert.rejects(
    () =>
      installSource(
        baseInstallArgs(root, zipPath, {
          extract,
          spec: { ...FAKE_SPEC, requiredModels: ["photo/up2x-denoise2x.param"] },
        }),
      ),
    /symlinked path: photo\/up2x-denoise2x\.param via photo/,
  );
});

// ---------------------------------------------------------------------------
// symlink hardening: idempotence and repair
// ---------------------------------------------------------------------------

test("an installed binary symlink does not satisfy the idempotent skip and is repaired", async (t) => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const zipPath = writeFixture(dir);
  await installSource(baseInstallArgs(root, zipPath));

  const binDir = path.join(root, "resources", "bin", "win");
  const dest = path.join(binDir, "photo-tool.exe");
  const external = path.join(dir, "external-tool.exe");
  writeFileSync(external, "EXTERNAL-TOOL");
  await rm(dest, { force: true });
  const made = trySymlink(external, dest, "file");
  if (made !== true) return t.skip(skipReason(made));

  assert.equal(validateTree(binDir, ["photo-tool.exe"]).ok, false, "a symlink must not satisfy the skip");

  const result = await installSource(baseInstallArgs(root, zipPath));
  assert.equal(result.skipped, false);
  assert.equal(result.installed, true);
  assert.equal(lstatSync(dest).isSymbolicLink(), false, "repaired binary is still a symlink");
  assert.equal(lstatSync(dest).isFile(), true);
  assert.equal(readFileSync(dest, "utf8"), "PHOTO-BINARY-CONTENT");
  assert.equal(readFileSync(external, "utf8"), "EXTERNAL-TOOL", "external target was modified");
});

test("a symlinked model destination is repaired without touching the external target", async (t) => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const zipPath = writeFixture(dir);
  await installSource(baseInstallArgs(root, zipPath));

  const modelDest = path.join(root, "resources", "models", "photo");
  const external = path.join(dir, "external-models");
  mkdirSync(path.join(external, "photo"), { recursive: true });
  writeFileSync(path.join(external, "photo", "model.param"), "EXTERNAL-MODEL");
  await rm(modelDest, { recursive: true, force: true });
  const made = trySymlink(external, modelDest, "dir");
  if (made !== true) return t.skip(skipReason(made));

  // `validateTree` anchors on its supplied root, so a symlinked modelDest
  // passes on its target's contents; installSource must still refuse the skip
  // because modelDest is a managed directory, not a supplied root.
  assert.equal(validateTree(modelDest, ["photo/model.param"]).ok, true);

  const result = await installSource(baseInstallArgs(root, zipPath));
  assert.equal(result.skipped, false, "a symlinked model dest must not satisfy the skip");
  assert.equal(result.installed, true);
  assert.equal(lstatSync(modelDest).isSymbolicLink(), false, "repaired model dest is still a symlink");
  assert.equal(lstatSync(modelDest).isDirectory(), true);
  assert.ok(existsSync(path.join(modelDest, "photo", "model.param")));
  assert.equal(lstatSync(external).isDirectory(), true, "external model dir was removed");
  assert.equal(
    readFileSync(path.join(external, "photo", "model.param"), "utf8"),
    "EXTERNAL-MODEL",
    "external model contents were modified",
  );
});

test("a symlinked resources/bin/<os> directory is replaced with a real managed directory", async (t) => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const zipPath = writeFixture(dir);
  const binDir = path.join(root, "resources", "bin", "win");
  const external = path.join(dir, "external-bin");
  mkdirSync(path.join(root, "resources", "bin"), { recursive: true });
  mkdirSync(external, { recursive: true });
  writeFileSync(path.join(external, "keep.txt"), "KEEP");
  const made = trySymlink(external, binDir, "dir");
  if (made !== true) return t.skip(skipReason(made));

  const result = await installSource(baseInstallArgs(root, zipPath));
  assert.equal(result.installed, true);
  assert.equal(lstatSync(binDir).isSymbolicLink(), false, "bin dir is still a symlink");
  assert.equal(lstatSync(binDir).isDirectory(), true);
  assert.ok(existsSync(path.join(binDir, "photo-tool.exe")));
  assert.equal(readdirSync(external).join(","), "keep.txt", "external bin dir was modified");
  assert.equal(readFileSync(path.join(external, "keep.txt"), "utf8"), "KEEP");
});

test("a symlinked intermediate resources/models directory is replaced safely", async (t) => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const zipPath = writeFixture(dir);
  const modelsDir = path.join(root, "resources", "models");
  const external = path.join(dir, "external-models-parent");
  mkdirSync(path.join(root, "resources"), { recursive: true });
  mkdirSync(external, { recursive: true });
  writeFileSync(path.join(external, "keep.txt"), "KEEP");
  const made = trySymlink(external, modelsDir, "dir");
  if (made !== true) return t.skip(skipReason(made));

  const result = await installSource(baseInstallArgs(root, zipPath));
  assert.equal(result.installed, true);
  assert.equal(lstatSync(modelsDir).isSymbolicLink(), false);
  assert.equal(lstatSync(modelsDir).isDirectory(), true);
  assert.ok(existsSync(path.join(modelsDir, "photo", "photo", "model.param")));
  assert.equal(readdirSync(external).join(","), "keep.txt", "external models parent was modified");
});

test("staged validation rejects symlink traversal and publishes nothing", async (t) => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const zipPath = writeFixture(dir);
  const external = path.join(dir, "external-stage-target.exe");
  writeFileSync(external, "EXTERNAL");

  let linkCode = true;
  const extract = async (zip, outDir) => {
    mkdirSync(path.join(outDir, "bin"), { recursive: true });
    mkdirSync(path.join(outDir, "models", "photo"), { recursive: true });
    mkdirSync(path.join(outDir, "models", "anime"), { recursive: true });
    writeFileSync(path.join(outDir, "models", "photo", "model.param"), "M");
    writeFileSync(path.join(outDir, "models", "anime", "model.param"), "M");
    linkCode = trySymlink(external, path.join(outDir, "bin", "photo-tool.exe"), "file");
  };

  await assert.rejects(
    () => installSource(baseInstallArgs(root, zipPath, { extract })),
    /symlinked path: photo-tool\.exe via photo-tool\.exe/,
  );
  if (linkCode !== true) return t.skip(skipReason(linkCode));

  assert.equal(
    existsSync(path.join(root, "resources", "bin", "win", "photo-tool.exe")),
    false,
    "a failed staged validation must publish nothing",
  );
  assert.equal(existsSync(path.join(root, "resources", "models", "photo")), false);
  assert.equal(readFileSync(external, "utf8"), "EXTERNAL");
});

test("installed validation rejects symlink traversal in the published tree", async (t) => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const zipPath = writeFixture(dir);
  const external = path.join(dir, "external.param");
  writeFileSync(external, "EXTERNAL");

  await installSource(baseInstallArgs(root, zipPath));
  const leaf = path.join(root, "resources", "models", "photo", "photo", "model.param");
  await rm(leaf, { force: true });
  const made = trySymlink(external, leaf, "file");
  if (made !== true) return t.skip(skipReason(made));

  const result = validateTree(path.join(root, "resources", "models", "photo"), [
    "photo/model.param",
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.symlink, [{ rel: "photo/model.param", at: "photo/model.param" }]);
});

// ---------------------------------------------------------------------------
// unsafe cleanup: never delete a work directory under a live resource
// ---------------------------------------------------------------------------

/** A yauzl-like handle that hands back one entry and never reaches `end`. */
function stalledZip(events, opts = {}) {
  const z = mockZip(events);
  z.readEntry = () => {
    if (opts.entry && !z.sentEntry) {
      z.sentEntry = true;
      queueMicrotask(() => z.emit("entry", { fileName: opts.entry }));
    }
  };
  z.openReadStream = (entry, cb) => {
    // A read stream that is destroyed but never emits `close`. `pipe` is a
    // no-op so the mock never feeds the real write stream.
    const rs = opts.readStream;
    rs.pipe = () => rs;
    cb(null, rs);
  };
  return z;
}

/** Reads back the single work directory `installSource` created under a root. */
function soleWorkDir(workRoot) {
  const entries = readdirSync(workRoot);
  assert.equal(entries.length, 1, `expected one work directory, saw ${entries.join(", ")}`);
  return path.join(workRoot, entries[0]);
}

/**
 * Rejects exactly as a cancelled extraction that could not prove closure does:
 * marked unsafe, naming its resources, with a controllable closure promise.
 */
function unsafeExtract(names, resourcesClosed) {
  return async (zipPath, destDir) => {
    mkdirSync(destDir, { recursive: true });
    writeFileSync(path.join(destDir, "half-written.bin"), "PARTIAL");
    const err = new Error(`extraction was cancelled but teardown timed out; unclosed: ${names.join(", ")}`);
    err.preserveWorkDir = true;
    err.unclosedResources = names;
    err.resourcesClosed = resourcesClosed;
    throw err;
  };
}

test("teardown reports eventual closure for a resource that missed the deadline", async () => {
  const events = [];
  const readStream = mockStream("read", events);
  const { order, unclosed, allClosed } = await closeExtractionResources(
    { readStream },
    { deadlineMs: 30 },
  );
  assert.deepEqual(order, []);
  assert.deepEqual(unclosed, ["read stream"]);

  let settled = false;
  allClosed.then(() => {
    settled = true;
  });
  await sleep(20);
  assert.equal(settled, false, "allClosed resolved before the resource closed");

  readStream.finishClose();
  await allClosed;
  assert.equal(events.filter((e) => e === "read:destroy").length, 1, "destroy was called twice");
});

test("teardown that closes everything in time reports allClosed already resolved", async () => {
  const events = [];
  const readStream = mockStream("read", events);
  const done = closeExtractionResources({ readStream }, { deadlineMs: 2000 });
  await sleep(5);
  readStream.finishClose();
  const { unclosed, allClosed } = await done;
  assert.deepEqual(unclosed, []);
  await allClosed; // resolves immediately; nothing was left pending
});

test("a zip handle that misses the teardown deadline marks cleanup unsafe", async () => {
  const dir = tmp();
  const events = [];
  const zip = stalledZip(events);

  const err = await mod.extractWithYauzl(path.join(dir, "any.zip"), path.join(dir, "out"), {
    timeoutMs: 20,
    graceMs: 600,
    teardownMs: 40,
    openZip: (p, o, cb) => cb(null, zip),
  }).then(
    () => null,
    (e) => e,
  );

  assert.ok(err, "extraction should reject");
  assert.equal(err.preserveWorkDir, true, "marker did not survive withTimeout wrapping");
  assert.deepEqual(err.unclosedResources, ["zipfile"]);
  assert.ok(err.resourcesClosed, "eventual-closure promise was lost");
  assert.match(err.cause.message, /unclosed: zipfile/);

  let closed = false;
  err.resourcesClosed.then(() => {
    closed = true;
  });
  await sleep(20);
  assert.equal(closed, false);
  zip.finishClose();
  await err.resourcesClosed;
});

test("a read stream that misses the teardown deadline is named in the marker", async () => {
  const dir = tmp();
  const events = [];
  const readStream = mockStream("read", events); // never emits close
  const zip = stalledZip(events, { entry: "a.bin", readStream });

  const err = await mod.extractWithYauzl(path.join(dir, "any.zip"), path.join(dir, "out"), {
    timeoutMs: 30,
    graceMs: 600,
    teardownMs: 40,
    openZip: (p, o, cb) => cb(null, zip),
  }).then(
    () => null,
    (e) => e,
  );

  assert.equal(err.preserveWorkDir, true);
  assert.ok(err.unclosedResources.includes("read stream"), "stuck read stream not named");
  readStream.finishClose();
  zip.finishClose();
  await err.resourcesClosed;
});

for (const names of [["read stream"], ["write stream"], ["zipfile"], ["read stream", "zipfile"]]) {
  test(`installSource preserves the work directory when ${names.join(" + ")} stay open`, async () => {
    const dir = tmp();
    const root = path.join(dir, "root");
    const workRoot = path.join(dir, "work");
    const zipPath = writeFixture(dir);
    const gate = deferred();

    const err = await installSource(
      baseInstallArgs(root, zipPath, { workRoot, extract: unsafeExtract(names, gate.promise) }),
    ).then(
      () => null,
      (e) => e,
    );

    assert.ok(err, "install should fail");
    const workDir = soleWorkDir(workRoot);
    assert.equal(existsSync(workDir), true, "work directory was removed under a live resource");
    assert.equal(err.preservedWorkDir, workDir);
    for (const name of names) {
      assert.ok(err.message.includes(name), `error does not name ${name}`);
    }
    assert.ok(err.message.includes(workDir), "error does not name the preserved work directory");
    assert.equal(
      existsSync(path.join(root, "resources", "bin", "win", "photo-tool.exe")),
      false,
      "nothing may be published on this path",
    );

    // Deferred cleanup runs only after the resources actually close.
    await sleep(20);
    assert.equal(existsSync(workDir), true, "cleanup ran before eventual closure");
    gate.resolve();
    await err.deferredCleanup;
    assert.equal(existsSync(workDir), false, "deferred cleanup did not remove the work directory");
  });
}

test("a resource that never closes leaves the work directory preserved and the run failed", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const workRoot = path.join(dir, "work");
  const zipPath = writeFixture(dir);
  const never = new Promise(() => {});

  const err = await installSource(
    baseInstallArgs(root, zipPath, {
      workRoot,
      extract: unsafeExtract(["read stream"], never),
    }),
  ).then(
    () => null,
    (e) => e,
  );

  assert.ok(err, "install must not report success");
  const workDir = soleWorkDir(workRoot);
  await sleep(30);
  assert.equal(existsSync(workDir), true, "work directory must stay preserved for diagnosis");
  assert.equal(existsSync(path.join(workDir, "extract", "half-written.bin")), true);
});

test("an ordinary failure still removes the work directory", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const workRoot = path.join(dir, "work");
  const zipPath = writeFixture(dir);

  await assert.rejects(() =>
    installSource(
      baseInstallArgs(root, zipPath, {
        workRoot,
        extract: async () => {
          throw new Error("plain extraction failure");
        },
      }),
    ),
  );
  assert.deepEqual(readdirSync(workRoot), [], "an ordinary failure must not preserve workDir");
});

test("a cancellation that closes everything in time removes the work directory", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const workRoot = path.join(dir, "work");
  const zipPath = writeFixture(dir);
  const events = [];

  const err = await installSource(
    baseInstallArgs(root, zipPath, {
      workRoot,
      timeoutMs: 20,
      graceMs: 600,
      extract: (zip, dest, o) => {
        const zipHandle = stalledZip(events);
        // Closes as soon as teardown asks, i.e. within the deadline.
        zipHandle.close = () => {
          events.push("zipfile:close-called");
          queueMicrotask(() => zipHandle.finishClose());
        };
        return mod.extractWithYauzl(zip, dest, {
          ...o,
          teardownMs: 200,
          openZip: (p, oo, cb) => cb(null, zipHandle),
        });
      },
    }),
  ).then(
    () => null,
    (e) => e,
  );

  assert.ok(err, "install should fail");
  assert.equal(err.preserveWorkDir, undefined, "safe teardown must not mark cleanup unsafe");
  assert.equal(err.preservedWorkDir, undefined);
  assert.deepEqual(readdirSync(workRoot), [], "safe teardown must remove the work directory");
});

test("runCli prints no Complete when cleanup is unsafe", async () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const workRoot = path.join(dir, "work");
  const zipPath = writeFixture(dir);
  const lines = [];

  const code = await runCli(["linux"], {
    log: (m) => lines.push(String(m)),
    root,
    workRoot,
    downloadArchive: async () => zipPath,
    extract: unsafeExtract(["read stream"], new Promise(() => {})),
  });

  assert.notEqual(code, 0, "an unsafe-cleanup failure must exit nonzero");
  assert.ok(!lines.some((l) => /Complete/i.test(l)), "Complete was printed after a failure");
  assert.ok(
    lines.some((l) => l.includes("preserving work directory")),
    "the preserved work directory was not surfaced",
  );
});
