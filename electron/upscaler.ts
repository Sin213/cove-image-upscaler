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
import type { JobProgress, UpscaleJob } from "./types";

const PROGRESS_RE = /(\d+(?:\.\d+)?)%/;
const PROGRESS_THROTTLE_MS = 100;

interface ResolvedJob {
  job: UpscaleJob;
  outputPath: string;
}

export class Upscaler extends EventEmitter {
  private queue: ResolvedJob[] = [];
  private active: { job: UpscaleJob; outputPath: string; child: ChildProcess; tempPath: string | null } | null = null;
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
    if (this.active) {
      try {
        this.active.child.kill("SIGTERM");
      } catch {
        // process may already be dead
      }
    }
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
      try {
        this.active.child.kill("SIGTERM");
      } catch {
        // already dead
      }
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
    this.active = { job, outputPath, child, tempPath };

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
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
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
    this.drain();
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

function buildCommand(job: UpscaleJob, outputPath: string): BuiltCommand {
  if (job.mode === "photo") {
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
  }
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
