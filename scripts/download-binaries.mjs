#!/usr/bin/env node
// Fetches NCNN Vulkan binaries (realesrgan + realcugan) and shared model
// files for the host OS into resources/bin/<os>/ and resources/models/.
//
// Defaults to the host OS so `npm install` on Linux only pulls the Linux
// zip, not the Windows/macOS ones. CI passes `--all` to populate all three
// before the per-platform `electron-builder` step.
//
// Flow, per source archive:
//   download → temp work dir → extract → stage → validate staged payload
//   → publish into resources/ → validate installed payload → drop temp dir
//
// Nothing is published until the staged payload satisfies the explicit
// per-platform manifest below, so a partial or empty extraction can never
// masquerade as a successful install. Every extraction has a finite timeout
// that keeps the event loop alive, so a stalled extractor fails loudly
// instead of letting the process exit 0 with nothing installed.
//
// Windows uses Expand-Archive via PowerShell: the yauzl stream path stalls
// indefinitely on the first DEFLATE entry there (no data, no `end`, no
// error). Non-Windows keeps the working yauzl path.
//
// Idempotent: a run whose manifest is already satisfied skips that source.
// `postinstall` tolerates a nonzero exit so a flaky network does not break
// `npm install`; direct invocation and CI see the real exit code.

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  realpathSync,
  unlinkSync,
  rmSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { cp, readdir, rm, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
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

/** Extraction is capped so a stalled extractor rejects instead of hanging. */
const EXTRACT_TIMEOUT_MS = 5 * 60 * 1000;
/** Download is capped separately; the archives are ~45 MB. */
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

export const PLATFORMS = {
  linux: {
    key: "linux",
    suffix: "ubuntu",
    binExt: "",
    libExts: [".so", ".so.1"],
    // The Ubuntu archives link against the system Vulkan loader; no bundled
    // library is required for the binary to resolve.
    requiredLibs: [],
  },
  mac: {
    key: "mac",
    suffix: "macos",
    binExt: "",
    libExts: [".dylib"],
    requiredLibs: [],
  },
  win: {
    key: "win",
    suffix: "windows",
    binExt: ".exe",
    libExts: [".dll"],
    // Both Windows archives ship vcomp140.dll beside the executable; without
    // it the binary fails to start.
    requiredLibs: ["vcomp140.dll"],
  },
};

export const SOURCES = {
  realesrgan: {
    urlBase: REALESRGAN_BASE,
    binary: "realesrgan-ncnn-vulkan",
    modelSubdir: "realesrgan",
    // Photo mode runs `-n realesrgan-x4plus -m <models>/realesrgan`.
    requiredModels: ["realesrgan-x4plus.param", "realesrgan-x4plus.bin"],
  },
  realcugan: {
    urlBase: REALCUGAN_BASE,
    binary: "realcugan-ncnn-vulkan",
    modelSubdir: "realcugan",
    // Anime mode resolves `<models>/realcugan/models-se` and picks denoise 2
    // at 2x, denoise 0 at 3x/4x.
    requiredModels: [
      "models-se/up2x-denoise2x.param",
      "models-se/up2x-denoise2x.bin",
      "models-se/up3x-no-denoise.param",
      "models-se/up3x-no-denoise.bin",
      "models-se/up4x-no-denoise.param",
      "models-se/up4x-no-denoise.bin",
    ],
  },
};

// ---------------------------------------------------------------------------
// manifest + validation
// ---------------------------------------------------------------------------

/**
 * Required payload for one platform/source pair, as paths relative to the
 * bin directory and to the source's models directory respectively.
 */
export function requiredRelPaths(platform, spec) {
  return {
    bin: [spec.binary + platform.binExt, ...platform.requiredLibs],
    models: [...spec.requiredModels],
  };
}

/**
 * Checks that every `relPaths` entry stays inside `root`, exists, is a
 * *regular file*, and is nonzero.
 *
 * Every entry in the manifests above names a regular file, so a directory,
 * a socket or a FIFO at one of these paths is a broken install, not a
 * satisfied requirement. Symlinks are rejected outright: a following stat
 * would let a link at (or above) a required path point anywhere on disk and
 * still report a nonempty regular file, so the walk below uses `lstatSync`
 * and never follows a link.
 *
 * Trust anchor: the supplied root is resolved once with `realpathSync`, so
 * symlinks at or above the root stay legal (a repo under a symlinked home,
 * macOS /var -> /private/var, a Windows junction above the root). Every
 * component strictly below that anchor must be a real directory, and the
 * final component a real nonempty file. Containment then follows from the
 * component walk itself, so no per-file `realpathSync` is needed.
 *
 * `lstatSync(...).isSymbolicLink()` covers file symlinks, directory symlinks
 * and Windows directory junctions, so no platform-native API is involved.
 *
 * Residual TOCTOU: the walk removes pre-existing static symlink bypasses, but
 * the checks are not atomic. An attacker with write access to the managed
 * tree could still swap an entry between validation and publication. Closing
 * that window would need directory-handle/openat-style APIs or native code,
 * which is out of scope here.
 */
export function validateTree(root, relPaths) {
  const resolvedRoot = path.resolve(root);
  const missing = [];
  const empty = [];
  const escaped = [];
  const invalidType = [];
  const symlink = [];

  const done = () => ({
    ok:
      !missing.length &&
      !empty.length &&
      !escaped.length &&
      !invalidType.length &&
      !symlink.length,
    missing,
    empty,
    escaped,
    invalidType,
    symlink,
  });

  let anchor;
  try {
    anchor = realpathSync(resolvedRoot);
  } catch {
    // No root at all: every requirement is simply absent.
    missing.push(...relPaths);
    return done();
  }
  if (!lstatSync(anchor).isDirectory()) {
    invalidType.push(...relPaths);
    return done();
  }

  for (const rel of relPaths) {
    const full = path.resolve(resolvedRoot, rel);
    if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) {
      escaped.push(rel);
      continue;
    }
    const parts = path.relative(resolvedRoot, full).split(path.sep).filter(Boolean);
    if (!parts.length) {
      // The manifest entry names the root itself, which is never a file.
      invalidType.push(rel);
      continue;
    }

    let current = anchor;
    for (let i = 0; i < parts.length; i += 1) {
      current = path.join(current, parts[i]);
      let entry;
      try {
        entry = lstatSync(current);
      } catch (err) {
        // ENOENT is a plain absence. Anything else (EACCES, ENOTDIR, ELOOP)
        // leaves the path unusable rather than merely absent, so it is
        // reported as an unusable type instead of being hidden as "missing".
        if (err && err.code === "ENOENT") missing.push(rel);
        else invalidType.push(rel);
        break;
      }
      if (entry.isSymbolicLink()) {
        symlink.push({ rel, at: parts.slice(0, i + 1).join(path.posix.sep) });
        break;
      }
      if (i < parts.length - 1) {
        if (!entry.isDirectory()) {
          invalidType.push(rel);
          break;
        }
      } else if (!entry.isFile()) {
        invalidType.push(rel);
      } else if (entry.size === 0) {
        empty.push(rel);
      }
    }
  }

  return done();
}

function describeValidation(label, root, result) {
  const parts = [];
  if (result.missing.length) parts.push(`missing: ${result.missing.join(", ")}`);
  if (result.invalidType.length) {
    parts.push(`not a regular file: ${result.invalidType.join(", ")}`);
  }
  if (result.empty.length) parts.push(`empty (zero-byte): ${result.empty.join(", ")}`);
  if (result.escaped.length) parts.push(`outside root: ${result.escaped.join(", ")}`);
  if (result.symlink?.length) {
    parts.push(
      `symlinked path: ${result.symlink.map((s) => `${s.rel} via ${s.at}`).join(", ")}`,
    );
  }
  return `${label} validation failed under ${root} — ${parts.join("; ")}`;
}

/**
 * Walks from a canonical managed root down to `targetDir`, making every
 * component below the root a *real* directory.
 *
 * A symlink below the root is unlinked (the link itself, never its target)
 * and replaced with a real directory; a non-directory entry is removed the
 * same way. Real directories are left untouched. Nothing above `managedRoot`
 * is inspected or modified, so symlinks at or above it stay legal.
 */
/**
 * True when every component of `dir` strictly below the managed root exists
 * and is a real directory (never a symlink or junction).
 *
 * `validateTree` resolves its *own* root with `realpathSync`, which is right
 * for a root supplied from outside but means a symlinked `resources/bin/<os>`
 * or `resources/models/<source>` would be accepted as its own anchor. Those
 * two directories are managed, not supplied, so the caller checks them here
 * before trusting a validation result.
 */
function isRealManagedDir(managedRoot, dir) {
  const resolvedRoot = path.resolve(managedRoot);
  let current;
  try {
    current = realpathSync(resolvedRoot);
  } catch {
    return false;
  }
  const rel = path.relative(resolvedRoot, path.resolve(dir));
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return false;

  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let entry;
    try {
      entry = lstatSync(current);
    } catch {
      return false;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
  }
  return true;
}

function ensureRealDir(managedRoot, targetDir) {
  const resolvedRoot = path.resolve(managedRoot);
  mkdirSync(resolvedRoot, { recursive: true });
  let current = realpathSync(resolvedRoot);

  const rel = path.relative(resolvedRoot, path.resolve(targetDir));
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`refusing to prepare ${targetDir} outside managed root ${managedRoot}`);
  }

  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let entry;
    try {
      entry = lstatSync(current);
    } catch {
      entry = null;
    }
    if (entry) {
      if (entry.isDirectory()) continue;
      // Unlink the link itself so an external target is never touched.
      if (entry.isSymbolicLink()) unlinkSync(current);
      else rmSync(current, { recursive: true, force: true });
    }
    mkdirSync(current);
  }
  return current;
}

function assertTree(label, root, relPaths) {
  const result = validateTree(root, relPaths);
  if (!result.ok) throw new Error(describeValidation(label, root, result));
  return result;
}

// ---------------------------------------------------------------------------
// timeout
// ---------------------------------------------------------------------------

/** How long to wait for a cancelled operation to actually finish unwinding. */
const CANCEL_GRACE_MS = 30 * 1000;

/**
 * Runs `factory(signal)` under a deadline.
 *
 * On expiry the signal is aborted and — crucially — this does *not* reject
 * until the underlying operation has actually settled. Callers may therefore
 * treat rejection as proof that the operation has stopped touching its
 * working directory, which is what makes `installSource`'s cleanup safe.
 *
 * Timers stay referenced while pending, so a stalled operation can never let
 * Node drain its event loop and exit 0. If a cancelled operation refuses to
 * unwind within the grace window we reject anyway, saying so, rather than
 * hanging forever.
 */
export function withTimeout(factory, ms, label, opts = {}) {
  const graceMs = opts.graceMs ?? CANCEL_GRACE_MS;
  const controller = new AbortController();

  return new Promise((resolve, reject) => {
    let timedOut = false;
    let graceTimer;
    const timeoutError = new Error(`${label} timed out after ${ms}ms`);

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort(timeoutError);
      } catch {
        /* best effort — settling below is what matters */
      }
      // Keep the loop alive while the operation unwinds.
      graceTimer = setTimeout(() => {
        timeoutError.message += ` and did not cancel within ${graceMs}ms`;
        // The operation never settled, so it may still be writing. Cleanup is
        // unsafe until it does settle, whenever that turns out to be.
        markUnsafeCleanup(
          timeoutError,
          ["unsettled operation"],
          op ? op.then(() => {}, () => {}) : Promise.resolve(),
        );
        reject(timeoutError);
      }, graceMs);
    }, ms);

    let op;
    try {
      op = Promise.resolve(factory(controller.signal));
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }

    op.then(
      (value) => {
        clearTimeout(timer);
        clearTimeout(graceTimer);
        if (timedOut) reject(timeoutError);
        else resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        clearTimeout(graceTimer);
        if (timedOut) {
          // Keep the operation's own teardown detail (e.g. which resource
          // refused to close) attached to the timeout we report.
          if (timeoutError.cause === undefined) timeoutError.cause = err;
          // An unsafe-cleanup marker must survive this wrapping, or the caller
          // would delete a work directory that is still in use.
          if (err && err.preserveWorkDir === true) {
            markUnsafeCleanup(timeoutError, err.unclosedResources, err.resourcesClosed);
          }
          reject(timeoutError);
        } else {
          reject(err);
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------
// extraction
// ---------------------------------------------------------------------------

function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Windows extraction via Expand-Archive. Paths are embedded as single-quoted
 * PowerShell literals in a throwaway script inside the temp work directory,
 * so no file path is ever parsed as part of a command line.
 */
export async function extractWithPowerShell(zipPath, destDir, opts = {}) {
  const { timeoutMs = EXTRACT_TIMEOUT_MS, log } = opts;
  mkdirSync(destDir, { recursive: true });
  const scriptDir = mkdtempSync(path.join(path.dirname(destDir), "ps-"));
  const scriptPath = path.join(scriptDir, "expand.ps1");

  writeFileSync(
    scriptPath,
    [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      `Expand-Archive -LiteralPath ${psLiteral(zipPath)} -DestinationPath ${psLiteral(destDir)} -Force`,
    ].join("\n"),
    "utf8",
  );

  try {
    // Settles only on the child's `close` event, so a timeout kills the child
    // and waits for it to actually exit before rejecting. Nothing below —
    // including the script-directory removal in `finally` — can run while
    // PowerShell is still writing.
    await withTimeout(
      (signal) =>
        new Promise((resolve, reject) => {
          const child = spawn(
            "powershell.exe",
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              scriptPath,
            ],
            { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
          );

          let stderr = "";
          let killed = false;
          child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
          });
          child.stdout.resume();

          const onAbort = () => {
            killed = true;
            try {
              child.kill("SIGKILL");
            } catch {
              /* already gone */
            }
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });

          child.on("error", reject);
          child.on("close", (code) => {
            if (killed) {
              reject(new Error(`Expand-Archive of ${zipPath} was cancelled (child terminated)`));
            } else if (code === 0) {
              resolve();
            } else {
              reject(
                new Error(
                  `Expand-Archive exited with code ${code} for ${zipPath}` +
                    (stderr.trim() ? `\n${stderr.trim()}` : ""),
                ),
              );
            }
          });
        }),
      timeoutMs,
      `Expand-Archive of ${zipPath}`,
      { graceMs: opts.graceMs },
    );
  } finally {
    await rm(scriptDir, { recursive: true, force: true });
  }

  log?.("[cove] extracted with Expand-Archive");
}

/** Destroys a stream and resolves only once it has actually emitted `close`. */
function closeStream(stream) {
  return new Promise((resolve) => {
    // Teardown of a mid-flight stream legitimately raises ECANCELED/EPIPE-style
    // errors; swallow them here so they never surface as unhandled.
    stream.on("error", () => {});
    if (stream.closed) return resolve();
    stream.once("close", resolve);
    try {
      stream.destroy();
    } catch {
      resolve();
    }
  });
}

/** Closes a yauzl ZipFile and resolves only once it has emitted `close`. */
function closeZipHandle(zipfile) {
  return new Promise((resolve) => {
    zipfile.on("error", () => {});
    if (zipfile.isOpen === false) return resolve();
    zipfile.once("close", resolve);
    try {
      zipfile.close();
    } catch {
      resolve();
    }
  });
}

/**
 * Shuts down the resources a yauzl extraction may hold, in the order
 * read stream → write stream → ZIP handle, awaiting each one's terminal
 * event rather than assuming `destroy()`/`close()` is synchronous proof the
 * descriptor is gone.
 *
 * Returns the resources that closed (in order), any that refused to close
 * before `deadlineMs`, and `allClosed` — a promise that settles only once
 * every resource that missed the deadline has *eventually* emitted its
 * terminal `close`. The deadline bounds how long a caller waits; it is not
 * proof that a descriptor is gone, so a caller that is about to delete the
 * work directory must wait on `allClosed` instead of on the deadline.
 *
 * Each resource is destroyed/closed exactly once, whether or not the deadline
 * has already passed. Deliberately narrow — this is a teardown helper, not a
 * resource-management framework.
 */
export async function closeExtractionResources(resources, opts = {}) {
  const deadlineMs = opts.deadlineMs ?? 10_000;
  const order = [];
  const unclosed = [];
  const pending = [];

  let expired = false;
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve("deadline");
    }, deadlineMs);
  });

  const steps = [
    ["read stream", resources.readStream, closeStream],
    ["write stream", resources.writeStream, closeStream],
    ["zipfile", resources.zipfile, closeZipHandle],
  ];

  for (const [name, resource, closer] of steps) {
    if (!resource) continue;
    // Initiated once, even past the deadline: skipping the call would leak the
    // descriptor entirely, which is worse than reporting it as still open.
    const closing = Promise.resolve(closer(resource));
    // The closers swallow expected teardown errors, but a late rejection here
    // must never surface as an unhandled rejection.
    closing.catch(() => {});
    if (expired) {
      unclosed.push(name);
      pending.push(closing);
      continue;
    }
    const outcome = await Promise.race([closing.then(() => "closed"), deadline]);
    if (outcome === "closed") order.push(name);
    else {
      unclosed.push(name);
      pending.push(closing);
    }
  }

  clearTimeout(timer);
  const allClosed = pending.length
    ? Promise.all(pending).then(
        () => {},
        () => {},
      )
    : Promise.resolve();
  return { order, unclosed, allClosed };
}

/**
 * Marks an error as "cancellation finished, but resources may still be live".
 *
 * A caller seeing this must not delete the working directory yet: the named
 * resources missed their teardown deadline and could still write into it.
 * `resourcesClosed` resolves if and when they eventually close; if they never
 * do, it never resolves and the directory stays preserved.
 */
function markUnsafeCleanup(err, unclosedResources, resourcesClosed) {
  err.preserveWorkDir = true;
  err.unclosedResources = unclosedResources;
  err.resourcesClosed = resourcesClosed;
  return err;
}

/** Finds the unsafe-cleanup marker on an error or anywhere in its cause chain. */
export function findUnsafeCleanup(err) {
  const seen = new Set();
  let current = err;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current.preserveWorkDir === true) return current;
    current = current.cause;
  }
  return null;
}

/**
 * Non-Windows extraction: the existing, working yauzl stream path, with its
 * live resources tracked so a timeout can tear them down.
 *
 * The cancellation contract is that this promise settles only *after* the
 * active read stream, write stream and ZIP handle have finished closing —
 * so by the time `installSource` reaches its `finally`, nothing can still be
 * writing into the work directory it is about to remove.
 */
export function extractWithYauzl(zipPath, destDir, opts = {}) {
  const { timeoutMs = EXTRACT_TIMEOUT_MS } = opts;
  // Finish teardown before withTimeout's grace window elapses, so a stuck
  // resource is reported by name rather than as a bare grace expiry.
  const graceMs = opts.graceMs ?? CANCEL_GRACE_MS;
  const teardownMs = opts.teardownMs ?? Math.max(250, Math.floor(graceMs * 0.8));

  // Narrowly scoped seam so the open callback can be driven deterministically
  // in tests. Production always uses the real yauzl.open; nothing is disabled
  // and there is no environment-variable bypass.
  let openZip = opts.openZip;
  if (!openZip) {
    try {
      const yauzl = require("yauzl");
      openZip = (p, o, cb) => yauzl.open(p, o, cb);
    } catch {
      return Promise.reject(new Error("yauzl is not installed — run `npm install` first"));
    }
  }

  mkdirSync(destDir, { recursive: true });

  return withTimeout(
    (signal) =>
      new Promise((resolve, reject) => {
        // opening → open → extracting → cancelling → settled
        let state = "opening";
        let zipfile = null;
        let readStream = null;
        let writeStream = null;

        // The open callback is asynchronous: a timeout can fire while it is
        // still outstanding, and it may then hand back a live ZipFile that
        // would otherwise leak past cleanup. Track it explicitly.
        let openCallbackFired = false;
        let resolveOpen;
        const openCallbackDone = new Promise((r) => {
          resolveOpen = r;
        });

        // Resolves once a *late* open callback has arrived and any ZipFile it
        // produced has finished closing. If the callback never fires it never
        // resolves, which is exactly the signal a caller needs to keep the work
        // directory preserved rather than deleting it under a live handle.
        let resolveLateClosed;
        const lateResourceClosed = new Promise((r) => {
          resolveLateClosed = r;
        });

        const isFinished = () => state === "settled";
        const isCancelling = () => state === "cancelling" || state === "settled";

        const settle = (err) => {
          if (state === "settled") return;
          state = "settled";
          signal.removeEventListener("abort", onAbort);
          if (err) reject(err);
          else resolve();
        };

        /**
         * Bounded wait. The timer is left referenced on purpose, so a pending
         * open cannot let Node drain its event loop and exit 0.
         */
        const deadline = (ms, sentinel) =>
          new Promise((r) => {
            setTimeout(() => r(sentinel), ms);
          });

        async function onAbort() {
          if (isCancelling()) return;
          state = "cancelling"; // stops new entries, streams and readEntry calls

          let lateZip = null;
          if (!openCallbackFired) {
            const OPEN_TIMED_OUT = Symbol("pending-open-timeout");
            const outcome = await Promise.race([
              openCallbackDone,
              deadline(teardownMs, OPEN_TIMED_OUT),
            ]);
            if (outcome === OPEN_TIMED_OUT) {
              // The callback may still arrive and hand back a live ZipFile
              // over this work directory, so cleanup is not safe yet. It
              // becomes safe once that late handle has closed.
              settle(
                markUnsafeCleanup(
                  new Error(
                    `yauzl extraction of ${zipPath} was cancelled but the pending ZIP open ` +
                      `did not settle within ${teardownMs}ms`,
                  ),
                  ["pending zip open"],
                  lateResourceClosed,
                ),
              );
              return;
            }
            // An open error means there is simply no handle to close.
            if (outcome && outcome.zip) lateZip = outcome.zip;
          }

          const { unclosed, allClosed } = await closeExtractionResources(
            { readStream, writeStream, zipfile: zipfile ?? lateZip },
            { deadlineMs: teardownMs },
          );
          settle(
            unclosed.length
              ? markUnsafeCleanup(
                  new Error(
                    `yauzl extraction of ${zipPath} was cancelled but teardown timed out; ` +
                      `unclosed: ${unclosed.join(", ")}`,
                  ),
                  unclosed,
                  allClosed,
                )
              : new Error(`yauzl extraction of ${zipPath} was cancelled`),
          );
        }

        if (signal.aborted) {
          void onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });

        // Genuine extraction errors also close their resources before the
        // promise rejects, so cleanup is safe on that path too.
        const failWith = (err) => {
          if (isCancelling()) return;
          state = "cancelling";
          closeExtractionResources(
            { readStream, writeStream, zipfile },
            { deadlineMs: teardownMs },
          ).then(() => settle(err));
        };

        openZip(zipPath, { lazyEntries: true }, (err, zip) => {
          openCallbackFired = true;

          if (err) {
            // Hand the waiting canceller a settled result either way.
            resolveOpen({ err });
            // An open error leaves no handle, so nothing can still be in use.
            resolveLateClosed();
            if (!isCancelling()) settle(err);
            return;
          }

          // Attach expected-teardown error handling before anything else, so a
          // handle that errors while closing never goes unhandled.
          zip.on("error", (e) => {
            if (isCancelling()) return; // expected during teardown
            failWith(e);
          });

          if (isCancelling()) {
            // Cancellation is already awaiting this callback; hand the handle
            // over and start no work. onAbort closes it and awaits `close`.
            resolveOpen({ zip });
            if (isFinished()) {
              // Settled without us (the pending-open deadline expired). Close
              // the late handle and report *when* it is actually closed, so
              // deferred cleanup cannot race this descriptor.
              closeZipHandle(zip).then(resolveLateClosed, resolveLateClosed);
            } else {
              // onAbort is still waiting on this handle and will close it.
              resolveLateClosed();
            }
            return;
          }

          zipfile = zip;
          state = "extracting";
          resolveOpen({ zip });
          resolveLateClosed();

          zip.on("end", () => settle());
          zip.readEntry();
          zip.on("entry", (entry) => {
            if (isCancelling()) return;
            const outPath = path.join(destDir, entry.fileName);
            if (/\/$/.test(entry.fileName)) {
              mkdirSync(outPath, { recursive: true });
              zip.readEntry();
            } else {
              mkdirSync(path.dirname(outPath), { recursive: true });
              zip.openReadStream(entry, (err2, rs) => {
                if (err2) return failWith(err2);
                if (isCancelling()) {
                  try {
                    rs.destroy();
                  } catch {
                    /* best effort */
                  }
                  return;
                }
                readStream = rs;
                const ws = createWriteStream(outPath);
                writeStream = ws;
                rs.on("error", (e) => failWith(e));
                ws.on("error", (e) => failWith(e));
                ws.on("finish", () => {
                  readStream = null;
                  writeStream = null;
                  if (!isCancelling()) zip.readEntry();
                });
                rs.pipe(ws);
              });
            }
          });
        });
      }),
    timeoutMs,
    `yauzl extraction of ${zipPath}`,
    { graceMs: opts.graceMs },
  );
}

/** Platform-dispatching extraction with a mandatory finite timeout. */
export function extractArchive(zipPath, destDir, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const platform = opts.platform ?? process.platform;
  const { graceMs, log } = opts;
  if (platform === "win32") {
    return extractWithPowerShell(zipPath, destDir, { timeoutMs, graceMs, log });
  }
  return extractWithYauzl(zipPath, destDir, { timeoutMs, graceMs });
}

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

/**
 * Both phases are signal-aware: `fetch` aborts its request, and `pipeline`
 * destroys source and destination on abort and rejects. Because `withTimeout`
 * waits for the operation to settle, a timed-out download is guaranteed to
 * have stopped writing before the caller cleans up the work directory. The
 * partial archive lives inside that directory and goes with it.
 */
async function downloadArchiveDefault(url, destPath) {
  mkdirSync(path.dirname(destPath), { recursive: true });
  const res = await withTimeout(
    (signal) => fetch(url, { redirect: "follow", signal }),
    DOWNLOAD_TIMEOUT_MS,
    `download of ${url}`,
  );
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  await withTimeout(
    (signal) => pipeline(Readable.fromWeb(res.body), createWriteStream(destPath), { signal }),
    DOWNLOAD_TIMEOUT_MS,
    `download of ${url}`,
  );
  return destPath;
}

// ---------------------------------------------------------------------------
// staging
// ---------------------------------------------------------------------------

async function findSingleRoot(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) return path.join(dir, entries[0].name);
  return null;
}

async function findFile(root, fileName) {
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    const entries = await readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === fileName) return full;
    }
  }
  return null;
}

/**
 * Builds `stageDir/{bin,models}` from an extracted archive, laid out exactly
 * as it will appear under resources/, so one manifest validates both the
 * staged and the installed payload.
 */
async function stagePayload(extractRoot, stageDir, spec, platform) {
  const topLevel = await findSingleRoot(extractRoot);
  const sourceRoot = topLevel ?? extractRoot;

  const binName = spec.binary + platform.binExt;
  const stageBin = path.join(stageDir, "bin");
  const stageModels = path.join(stageDir, "models");
  mkdirSync(stageBin, { recursive: true });

  const sourceBin = await findFile(sourceRoot, binName);
  if (!sourceBin) throw new Error(`Binary ${binName} not found in archive`);
  await cp(sourceBin, path.join(stageBin, binName), { force: true });

  // Sibling shared libraries the binary needs (vcomp DLLs on Windows,
  // libomp.dylib on macOS, occasional .so on Linux).
  const binSrcDir = path.dirname(sourceBin);
  for (const e of await readdir(binSrcDir, { withFileTypes: true })) {
    if (!e.isFile() || e.name === binName) continue;
    const lower = e.name.toLowerCase();
    if (platform.libExts.some((ext) => lower.endsWith(ext))) {
      await cp(path.join(binSrcDir, e.name), path.join(stageBin, e.name), { force: true });
    }
  }

  const sourceModels = path.join(sourceRoot, "models");
  if (existsSync(sourceModels)) {
    await cp(sourceModels, stageModels, { recursive: true, force: true });
    return;
  }

  // realcugan ships top-level models-se / models-pro / models-nose dirs.
  const subdirs = await readdir(sourceRoot, { withFileTypes: true });
  const modelDirs = subdirs.filter((d) => d.isDirectory() && d.name.startsWith("models"));
  if (modelDirs.length === 0) throw new Error("No models directory found in archive");
  mkdirSync(stageModels, { recursive: true });
  for (const d of modelDirs) {
    await cp(path.join(sourceRoot, d.name), path.join(stageModels, d.name), {
      recursive: true,
      force: true,
    });
  }
}

/**
 * Publishes a validated stage into resources/. Binaries are copied in so
 * unrelated files already in the bin directory survive; the source's own
 * models directory — and only that directory — is replaced wholesale.
 */
async function publishPayload(stageDir, binDir, modelDest, platform, managedRoot) {
  const stageBin = path.join(stageDir, "bin");
  // Not plain recursive mkdir: an existing `resources/bin/<os>` symlink would
  // otherwise be followed and the copy would land in an external tree.
  ensureRealDir(managedRoot, binDir);
  for (const e of await readdir(stageBin, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const dest = path.join(binDir, e.name);
    // A previously broken install may have left a symlink, a directory or
    // another non-regular object here; `cp` refuses to overwrite one with a
    // file — and would follow a symlink out of the managed tree — so clear it
    // first. Only paths this bootstrap manages are touched.
    try {
      const entry = lstatSync(dest);
      if (entry.isSymbolicLink()) unlinkSync(dest);
      else if (!entry.isFile()) await rm(dest, { recursive: true, force: true });
    } catch {
      /* nothing there — nothing to clear */
    }
    await cp(path.join(stageBin, e.name), dest, { force: true });
    if (platform.key !== "win") chmodSync(dest, 0o755);
  }

  const stageModels = path.join(stageDir, "models");
  ensureRealDir(managedRoot, path.dirname(modelDest));
  // `fs.rm` does not follow a directory symlink (probed: the link goes, the
  // target survives), but the destination is unlinked explicitly rather than
  // relying on that as the only safeguard.
  try {
    if (lstatSync(modelDest).isSymbolicLink()) unlinkSync(modelDest);
  } catch {
    /* nothing there */
  }
  await rm(modelDest, { recursive: true, force: true });
  try {
    await rename(stageModels, modelDest);
  } catch {
    // Different volume (temp dir vs. repo): fall back to a copy.
    await cp(stageModels, modelDest, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

/**
 * Downloads, extracts, validates, publishes and re-validates one
 * platform/source pair. Rejects — leaving nothing published and no temp
 * directory behind — if any phase or postcondition fails.
 */
export async function installSource(opts) {
  const {
    platformKey,
    platform,
    sourceKey,
    spec,
    root = ROOT,
    downloadArchive = downloadArchiveDefault,
    extract = extractArchive,
    workRoot = tmpdir(),
    timeoutMs = EXTRACT_TIMEOUT_MS,
    graceMs,
    log = console.log,
  } = opts;

  const tag = `${platformKey}/${sourceKey}`;
  const required = requiredRelPaths(platform, spec);
  // Everything this bootstrap publishes lives under resources/. That is the
  // managed root: symlinks at or above it (a symlinked checkout, a junction)
  // are legitimate, anything below it is ours to repair.
  const managedRoot = path.join(root, "resources");
  const binDir = path.join(managedRoot, "bin", platformKey);
  const modelDest = path.join(managedRoot, "models", spec.modelSubdir);

  // Idempotency: a complete existing payload is left untouched. An incomplete
  // one is repaired rather than skipped.
  // A symlinked binDir/modelDest is a broken install, not a satisfied one, so
  // the managed directories are checked before their contents are trusted.
  if (
    isRealManagedDir(managedRoot, binDir) &&
    isRealManagedDir(managedRoot, modelDest) &&
    validateTree(binDir, required.bin).ok &&
    validateTree(modelDest, required.models).ok
  ) {
    log(`[cove] ${tag}: already installed, skipping`);
    return { skipped: true, installed: false };
  }

  mkdirSync(workRoot, { recursive: true });
  const workDir = mkdtempSync(path.join(workRoot, `cove-${platformKey}-${sourceKey}-`));
  const extractDir = path.join(workDir, "extract");
  const stageDir = path.join(workDir, "stage");
  // Set only when cancellation could not prove every extraction resource shut.
  let preserveWorkDir = false;
  const url = `${spec.urlBase}-${platform.suffix}.zip`;

  try {
    log(`[cove] ${tag}: Downloading ${url}`);
    const zipPath = await downloadArchive(url, path.join(workDir, "archive.zip"));
    log(`[cove] ${tag}: Downloaded ${zipPath}`);

    log(`[cove] ${tag}: Extracting into ${extractDir}`);
    // `extract` only settles once any cancelled work has unwound, so the
    // work-directory removal in `finally` cannot race a live extractor.
    await extract(zipPath, extractDir, { timeoutMs, graceMs, log });

    log(`[cove] ${tag}: Validating extracted payload`);
    // An extractor that resolves without writing anything must not be able to
    // fall through to an opaque ENOENT later; name the failure here.
    if (!existsSync(extractDir) || (await readdir(extractDir)).length === 0) {
      throw new Error(`extraction produced no files in ${extractDir}`);
    }
    mkdirSync(stageDir, { recursive: true });
    await stagePayload(extractDir, stageDir, spec, platform);
    assertTree(`${tag} staged payload`, path.join(stageDir, "bin"), required.bin);
    assertTree(`${tag} staged payload`, path.join(stageDir, "models"), required.models);

    log(`[cove] ${tag}: Publishing to ${binDir} and ${modelDest}`);
    await publishPayload(stageDir, binDir, modelDest, platform, managedRoot);

    log(`[cove] ${tag}: Validating installed payload`);
    for (const dir of [binDir, modelDest]) {
      if (!isRealManagedDir(managedRoot, dir)) {
        throw new Error(
          `${tag} installed payload: ${dir} is not a real directory inside ${managedRoot}`,
        );
      }
    }
    assertTree(`${tag} installed payload`, binDir, required.bin);
    assertTree(`${tag} installed payload`, modelDest, required.models);

    log(`[cove] ${tag}: installed`);
    return { skipped: false, installed: true };
  } catch (err) {
    err.message = `${tag}: ${err.message} (archive: ${url}, extraction root: ${extractDir})`;
    // Cancellation that could not prove its resources are closed must not be
    // followed by a recursive delete: a stream or ZIP handle may still be
    // writing into workDir. Preserve it instead, and remove it later only if
    // those resources do eventually close.
    const unsafe = findUnsafeCleanup(err);
    if (unsafe) {
      preserveWorkDir = true;
      err.preservedWorkDir = workDir;
      err.unclosedResources = unsafe.unclosedResources;
      err.message +=
        ` — unclosed: ${(unsafe.unclosedResources ?? ["unknown"]).join(", ")};` +
        ` preserving work directory: ${workDir}`;
      // Exposed so callers (and tests) can observe deferred cleanup. A never
      // closing resource means this never settles and the directory stays.
      err.deferredCleanup = Promise.resolve(unsafe.resourcesClosed)
        .then(() => rm(workDir, { recursive: true, force: true }))
        .then(
          () => true,
          () => false,
        );
    }
    throw err;
  } finally {
    if (!preserveWorkDir) await rm(workDir, { recursive: true, force: true });
  }
}

function hostPlatformKey() {
  if (process.platform === "win32") return "win";
  if (process.platform === "darwin") return "mac";
  return "linux";
}

export function targetsFromArgs(argv) {
  if (argv.includes("--all")) return Object.keys(PLATFORMS);
  const wanted = argv.filter((a) => Object.keys(PLATFORMS).includes(a));
  return wanted.length ? wanted : [hostPlatformKey()];
}

/**
 * Top-level entry point. Returns the process exit code; never throws, and
 * never reports success unless every source passed its postcondition
 * validation.
 */
export async function runCli(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? console.log;
  const targets = targetsFromArgs(argv);
  log(`[cove] downloading binaries for: ${targets.join(", ")}`);

  try {
    for (const platformKey of targets) {
      for (const [sourceKey, spec] of Object.entries(SOURCES)) {
        await installSource({
          platformKey,
          platform: PLATFORMS[platformKey],
          sourceKey,
          spec,
          ...deps,
          log,
        });
      }
    }
  } catch (err) {
    log(`[cove] binary setup FAILED — ${err.message}`);
    return 1;
  }

  log("[cove] Complete — all required binaries and models are installed");
  return 0;
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  process.exitCode = await runCli();
}
