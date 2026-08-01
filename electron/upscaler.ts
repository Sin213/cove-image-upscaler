import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nativeImage } from "electron";
import {
  realcuganBinary,
  realcuganModelsDir,
  realesrganBinary,
  realesrganModelsDir,
} from "./paths";
import { PixelCancelledError, processPixelImage } from "./pixel";
import type { JobProgress, PixelUpscaleJob, UpscaleJob } from "./types";

const PROGRESS_RE = /(\d+(?:\.\d+)?)%/;
const PROGRESS_THROTTLE_MS = 100;

interface ResolvedJob {
  job: UpscaleJob;
  outputPath: string;
}

// Photo/anime run as NCNN child processes; pixel runs locally in-process. The
// tag keeps `child` off the local variant instead of making it optional on one
// broad object, so cancellation can't silently no-op on a pixel job.
type AiUpscaleJob = Exclude<UpscaleJob, PixelUpscaleJob>;

type ActiveJob =
  | {
      kind: "process";
      job: AiUpscaleJob;
      outputPath: string;
      child: ChildProcess;
      tempPath: string | null;
    }
  | {
      kind: "local";
      job: PixelUpscaleJob;
      outputPath: string;
      cancelled: boolean;
    };

export class Upscaler extends EventEmitter {
  private queue: ResolvedJob[] = [];
  private active: ActiveJob | null = null;
  private cancelAllFlag = false;
  private cancelledIds = new Set<string>();

  enqueue(jobs: UpscaleJob[]): void {
    for (const job of jobs) {
      const outputPath = resolveOutputPath(job);
      this.queue.push({ job, outputPath });
      this.emitProgress({ id: job.id, percent: 0, status: "queued" });
    }
    this.drain();
  }

  cancelAll(): void {
    this.cancelAllFlag = true;
    const pending = [...this.queue];
    this.queue = [];
    for (const { job } of pending) {
      this.emitProgress({ id: job.id, percent: 0, status: "cancelled" });
    }
    if (this.active) this.requestActiveCancel();
  }

  cancelOne(jobId: string): void {
    const queuedIdx = this.queue.findIndex((q) => q.job.id === jobId);
    if (queuedIdx >= 0) {
      const [{ job }] = this.queue.splice(queuedIdx, 1);
      this.emitProgress({ id: job.id, percent: 0, status: "cancelled" });
      return;
    }
    if (this.active && this.active.job.id === jobId) {
      this.cancelledIds.add(jobId);
      this.requestActiveCancel();
    }
  }

  // Cancellation is a request, not a completion: the active job's own terminal
  // path still settles it exactly once.
  private requestActiveCancel(): void {
    const active = this.active;
    if (!active) return;
    if (active.kind === "local") {
      active.cancelled = true;
      return;
    }
    try {
      active.child.kill("SIGTERM");
    } catch {
      // process may already be dead
    }
  }

  private emitProgress(p: JobProgress): void {
    this.emit("progress", p);
  }

  private drain(): void {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) {
      this.cancelAllFlag = false;
      return;
    }
    this.runJob(next);
  }

  private runJob(resolved: ResolvedJob): void {
    const { job, outputPath } = resolved;
    // Dispatch before any binary resolution or command construction: pixel jobs
    // must never spawn Real-ESRGAN or Real-CUGAN.
    if (job.mode === "pixel") {
      this.runPixelJob(job, outputPath);
      return;
    }
    this.runAiJob(job, outputPath);
  }

  // Local, in-process pixel job. Reserves the active slot before any async work
  // so queue concurrency stays at one, and settles through finishJob exactly
  // once on success, failure or cancellation.
  private runPixelJob(job: PixelUpscaleJob, outputPath: string): void {
    const active: ActiveJob = { kind: "local", job, outputPath, cancelled: false };
    this.active = active;
    this.emitProgress({ id: job.id, percent: 0, status: "running" });

    let lastEmit = 0;
    // Only this job's own output may be removed. processPixelImage publishes by
    // renaming a temp file into place, so it publishes on the resolve path and
    // never on the reject path: cleaning up unconditionally would delete a file
    // another writer put at outputPath after resolveOutputPath ran.
    const settleCancelled = (published: boolean) => {
      this.cancelledIds.delete(job.id);
      if (published) this.removeFile(outputPath);
      this.finishJob(job, outputPath, "cancelled");
    };

    void processPixelImage(job.inputPath, outputPath, job.scale, {
      cancellation: {
        isCancelled: () =>
          active.cancelled || this.cancelAllFlag || this.cancelledIds.has(job.id),
      },
      onProgress: (percent) => {
        const now = Date.now();
        if (now - lastEmit < PROGRESS_THROTTLE_MS) return;
        lastEmit = now;
        this.emitProgress({
          id: job.id,
          percent: Math.min(99, Math.max(0, percent)),
          status: "running",
        });
      },
    }).then(
      () => {
        // A cancel that lands after the rename still must not publish output.
        if (active.cancelled || this.cancelAllFlag || this.cancelledIds.has(job.id)) {
          settleCancelled(true);
          return;
        }
        this.finishJob(job, outputPath, "done");
      },
      (err: unknown) => {
        if (err instanceof PixelCancelledError || active.cancelled || this.cancelAllFlag) {
          settleCancelled(false);
          return;
        }
        this.cancelledIds.delete(job.id);
        // Pixel failures are local: they never go through NCNN/Vulkan
        // error humanization.
        const message = err instanceof Error ? err.message : String(err);
        this.finishJob(job, outputPath, "error", `Pixel upscaling failed — ${message}`);
      },
    );
  }

  private runAiJob(job: AiUpscaleJob, outputPath: string): void {
    // realesrgan-x4plus is x4-only; passing -s 2 / -s 3 produces tile-stitch
    // artifacts. For photo mode at non-4x, run the model at native 4x to a
    // temp file, then resize down to the requested scale ourselves.
    const needsDownscale = job.mode === "photo" && job.scale !== 4;
    const tempPath = needsDownscale
      ? path.join(os.tmpdir(), `cove-upscale-${job.id}.png`)
      : null;
    const binaryOutPath = tempPath ?? outputPath;

    const { binary, args, label } = buildCommand(job, binaryOutPath);
    if (!fs.existsSync(binary)) {
      this.emitProgress({
        id: job.id,
        percent: 0,
        status: "error",
        error: `Missing binary: ${binary}. Run: npm run postinstall`,
      });
      this.drain();
      return;
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    this.emitProgress({ id: job.id, percent: 0, status: "running" });

    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.active = { kind: "process", job, outputPath, child, tempPath };

    let lastEmit = 0;
    let stderrPartial = "";
    const recentLines: string[] = [];
    const RECENT_MAX = 10;

    const ingestLine = (line: string) => {
      if (!line.trim()) return;
      const m = line.match(PROGRESS_RE);
      if (m) {
        const now = Date.now();
        if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
          lastEmit = now;
          // Cap at 95% so the post-binary resize step has somewhere to land.
          const raw = parseFloat(m[1]);
          const pct = needsDownscale
            ? Math.min(95, Math.max(0, raw * 0.95))
            : Math.min(99, Math.max(0, raw));
          this.emitProgress({ id: job.id, percent: pct, status: "running" });
        }
        return; // progress lines aren't useful as error context
      }
      recentLines.push(line.trim());
      if (recentLines.length > RECENT_MAX) recentLines.shift();
    };

    const onStderr = (buf: Buffer) => {
      // NCNN binaries emit progress on stderr in chunks that often split
      // mid-line. Accumulate until newlines arrive so each `line` we look at
      // is actually complete.
      stderrPartial += buf.toString();
      let nl: number;
      while ((nl = stderrPartial.search(/\r?\n/)) >= 0) {
        const line = stderrPartial.slice(0, nl);
        const skip = stderrPartial[nl] === "\r" && stderrPartial[nl + 1] === "\n" ? 2 : 1;
        stderrPartial = stderrPartial.slice(nl + skip);
        ingestLine(line);
      }
    };
    child.stderr?.on("data", onStderr);
    child.stdout?.on("data", onStderr);

    const flushPartial = () => {
      if (stderrPartial.trim()) {
        ingestLine(stderrPartial);
        stderrPartial = "";
      }
    };

    child.on("error", (err) => {
      this.cleanupTemp(tempPath);
      this.finishJob(job, outputPath, "error", err.message);
    });

    child.on("close", async (code, signal) => {
      flushPartial();
      const wasCancelled =
        this.cancelAllFlag ||
        this.cancelledIds.has(job.id) ||
        signal === "SIGTERM";
      this.cancelledIds.delete(job.id);
      if (wasCancelled) {
        this.cleanupTemp(tempPath);
        this.finishJob(job, outputPath, "cancelled");
        return;
      }
      if (code !== 0 || !fs.existsSync(binaryOutPath)) {
        this.cleanupTemp(tempPath);
        this.finishJob(
          job,
          outputPath,
          "error",
          humanizeError(recentLines, code, signal, label, job),
        );
        return;
      }

      // Post-binary downscale for photo non-4x.
      if (needsDownscale && tempPath) {
        try {
          this.emitProgress({ id: job.id, percent: 97, status: "running" });
          await downscalePng(tempPath, outputPath, job.scale / 4);
          this.cleanupTemp(tempPath);
          this.finishJob(job, outputPath, "done");
        } catch (err) {
          this.cleanupTemp(tempPath);
          const message = err instanceof Error ? err.message : String(err);
          this.finishJob(job, outputPath, "error", `Resize failed: ${message}`);
        }
        return;
      }

      this.finishJob(job, outputPath, "done");
    });
  }

  private cleanupTemp(tempPath: string | null): void {
    if (!tempPath) return;
    this.removeFile(tempPath);
  }

  private removeFile(target: string): void {
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    } catch {
      // best effort
    }
  }

  private finishJob(
    job: UpscaleJob,
    outputPath: string,
    status: "done" | "error" | "cancelled",
    error?: string,
  ): void {
    this.active = null;
    const payload: JobProgress = {
      id: job.id,
      percent: status === "done" ? 100 : 0,
      status,
    };
    if (error) payload.error = error;
    if (status === "done") payload.outputPath = outputPath;
    this.emitProgress(payload);
    // The job is fully settled above; only the queue continuation is deferred.
    // Jobs that finish synchronously (the pixel guard, early failures) would
    // otherwise recurse finishJob -> drain -> runJob once per queued job. If an
    // enqueue starts the next job first, drain's active check makes this a
    // no-op.
    setImmediate(() => {
      this.drain();
    });
  }
}

async function downscalePng(srcPath: string, destPath: string, ratio: number): Promise<void> {
  const img = nativeImage.createFromPath(srcPath);
  if (img.isEmpty()) throw new Error("source image is empty");
  const size = img.getSize();
  const targetWidth = Math.max(1, Math.round(size.width * ratio));
  const targetHeight = Math.max(1, Math.round(size.height * ratio));
  const resized = img.resize({
    width: targetWidth,
    height: targetHeight,
    quality: "best",
  });
  const buf = resized.toPNG();
  if (!buf || buf.length === 0) throw new Error("PNG encode produced no data");
  await fs.promises.writeFile(destPath, buf);
}

function resolveOutputPath(job: UpscaleJob): string {
  const dir = job.outputDir ?? path.dirname(job.inputPath);
  const ext = path.extname(job.inputPath);
  const base = path.basename(job.inputPath, ext);
  const stem = `${base}_${job.scale}x_${job.mode}`;

  let candidate = path.join(dir, `${stem}.png`);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${n}).png`);
    n++;
  }
  return candidate;
}

interface BuiltCommand {
  binary: string;
  args: string[];
  label: string;
}

function humanizeError(
  lines: string[],
  code: number | null,
  signal: NodeJS.Signals | null,
  label: string,
  job: UpscaleJob,
): string {
  const blob = lines.join(" ").toLowerCase();

  // GPU memory exhaustion — the most common failure mode at higher scales.
  if (
    blob.includes("vkallocatememory") ||
    blob.includes("vk_error_out_of_device_memory") ||
    blob.includes("vk_error_out_of_host_memory") ||
    blob.includes("allocator allocate") ||
    blob.includes("out of memory") ||
    blob.includes("memory not enough") ||
    /try\s+(a\s+)?smaller\s+tile/.test(blob)
  ) {
    const suggest =
      job.scale === 4
        ? "Try 2× or 3×, or use a smaller image."
        : job.scale === 3
          ? "Try 2×, or use a smaller image."
          : "Use a smaller image — even 2× is too large for this image on this GPU.";
    return `Out of GPU memory at ${job.scale}× — image is too large for ${label} on this device. ${suggest}`;
  }

  // Vulkan device problems — driver / GPU not available.
  if (
    blob.includes("no vulkan") ||
    blob.includes("vulkan device not") ||
    blob.includes("cannot find vulkan") ||
    blob.includes("get_default_gpu_index")
  ) {
    return `No Vulkan-capable GPU detected. NCNN Vulkan needs a working Vulkan driver — install the right Vulkan runtime for your GPU.`;
  }

  // Model-architecture mismatch — Real-CUGAN throws this when the requested
  // -n level isn't shipped for the chosen -s scale, so it falls through to
  // a model with a different layer graph and dies looking for `gap3`.
  if (blob.includes("find_blob_index_by_name") || blob.includes("blob not found")) {
    return `Model / scale mismatch — the binary couldn't load a model that supports ${job.scale}× at this denoise level. This usually means the install is incomplete; try reinstalling to refresh the models.`;
  }

  // Image decode / write failures.
  if (blob.includes("decode image") || blob.includes("invalid image") || blob.includes("not a valid")) {
    return `Couldn't read the input image — file may be corrupt or unsupported. Try re-saving as PNG.`;
  }
  if (blob.includes("encode image") || blob.includes("write png") || blob.includes("permission denied")) {
    return `Couldn't write the output file — check that the output folder exists and is writable.`;
  }

  // Model file missing.
  if (blob.includes("no such file") && (blob.includes("param") || blob.includes("bin"))) {
    return `Model file missing — try reinstalling Cove Image Upscaler (postinstall fetches the models).`;
  }

  // Process killed (signal): often OOM-killer or the user cancelling.
  if (signal === "SIGKILL") {
    return `${label} was killed (likely out of system memory). Try a smaller image or lower scale.`;
  }

  // Fallback: most informative recent stderr lines + exit code.
  const tail = lines.slice(-3).filter((l) => l && !/\d+(?:\.\d+)?%/.test(l));
  const context = tail.join(" · ");
  if (context) return `${label} failed — ${context}`;
  if (signal) return `${label} terminated by ${signal}`;
  return `${label} exited with code ${code ?? "?"}`;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled upscale job mode: ${JSON.stringify(value)}`);
}

function buildCommand(job: UpscaleJob, outputPath: string): BuiltCommand {
  switch (job.mode) {
    case "photo":
      // Always run x4plus at native 4x. For 2x/3x the upscaler post-resizes the
      // result; passing -s 2/3 to an x4-only model yields tile-stitch artifacts.
      return {
        binary: realesrganBinary(),
        label: "realesrgan-ncnn-vulkan",
        args: [
          "-i", job.inputPath,
          "-o", outputPath,
          "-n", "realesrgan-x4plus",
          "-s", "4",
          "-m", realesrganModelsDir(),
          "-f", "png",
        ],
      };
    case "anime": {
      // Anime mode — Real-CUGAN. The valid `-n` (denoise) levels depend on scale:
      //   x2: -1, 0, 1, 2, 3   (we pick 2 for balanced output)
      //   x3: -1, 0, 3         (x3/x4 don't ship denoise2x; using -n 2 there causes
      //   x4: -1, 0, 3          NCNN's `find_blob_index_by_name gap3 failed`)
      // We default to no-denoise for x3/x4 to preserve anime line detail.
      const denoise = job.scale === 2 ? "2" : "0";
      return {
        binary: realcuganBinary(),
        label: "realcugan-ncnn-vulkan",
        args: [
          "-i", job.inputPath,
          "-o", outputPath,
          "-n", denoise,
          "-s", String(job.scale),
          "-m", realcuganModelsDir(),
          "-f", "png",
        ],
      };
    }
    case "pixel":
      // Tripwire: pixel jobs are local, not NCNN. Reaching here means a pixel
      // job slipped past the runJob guard at the IPC boundary.
      throw new Error(
        "Pixel jobs cannot use the AI command builder: no NCNN backend applies to pixel mode.",
      );
    default:
      return assertNever(job);
  }
}
