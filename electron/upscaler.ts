import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  realcuganBinary,
  realcuganModelsDir,
  realesrganBinary,
  realesrganModelsDir,
} from "./paths";
import type { JobProgress, UpscaleJob } from "./types";

const PROGRESS_RE = /(\d+(?:\.\d+)?)%/;
const PROGRESS_THROTTLE_MS = 100;

export class Upscaler extends EventEmitter {
  private queue: UpscaleJob[] = [];
  private active: { job: UpscaleJob; child: ChildProcess } | null = null;
  private cancelled = false;

  enqueue(jobs: UpscaleJob[]): void {
    for (const j of jobs) {
      this.queue.push(j);
      this.emitProgress({ id: j.id, percent: 0, status: "queued" });
    }
    this.drain();
  }

  cancelAll(): void {
    this.cancelled = true;
    const pending = [...this.queue];
    this.queue = [];
    for (const j of pending) {
      this.emitProgress({ id: j.id, percent: 0, status: "cancelled" });
    }
    if (this.active) {
      try {
        this.active.child.kill("SIGTERM");
      } catch {
        // process may already be dead
      }
    }
  }

  private emitProgress(p: JobProgress): void {
    this.emit("progress", p);
  }

  private drain(): void {
    if (this.active) return;
    const job = this.queue.shift();
    if (!job) {
      this.cancelled = false;
      return;
    }
    this.runJob(job);
  }

  private runJob(job: UpscaleJob): void {
    const { binary, args, label } = buildCommand(job);
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
    fs.mkdirSync(path.dirname(job.outputPath), { recursive: true });

    this.emitProgress({ id: job.id, percent: 0, status: "running" });

    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.active = { job, child };

    let lastEmit = 0;
    let lastStderrLine = "";

    const onStderr = (buf: Buffer) => {
      const text = buf.toString();
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        lastStderrLine = line;
        const m = line.match(PROGRESS_RE);
        if (m) {
          const now = Date.now();
          if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
            lastEmit = now;
            const pct = Math.min(99, Math.max(0, parseFloat(m[1])));
            this.emitProgress({ id: job.id, percent: pct, status: "running" });
          }
        }
      }
    };
    child.stderr?.on("data", onStderr);
    child.stdout?.on("data", onStderr);

    child.on("error", (err) => {
      this.finishJob(job, "error", err.message);
    });

    child.on("close", (code, signal) => {
      if (this.cancelled || signal === "SIGTERM") {
        this.finishJob(job, "cancelled");
        return;
      }
      if (code === 0 && fs.existsSync(job.outputPath)) {
        this.finishJob(job, "done");
      } else {
        this.finishJob(
          job,
          "error",
          lastStderrLine || `${label} exited with code ${code}`,
        );
      }
    });
  }

  private finishJob(
    job: UpscaleJob,
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
    if (status === "done") payload.outputPath = job.outputPath;
    this.emitProgress(payload);
    this.drain();
  }
}

interface BuiltCommand {
  binary: string;
  args: string[];
  label: string;
}

function buildCommand(job: UpscaleJob): BuiltCommand {
  if (job.mode === "photo") {
    return {
      binary: realesrganBinary(),
      label: "realesrgan-ncnn-vulkan",
      args: [
        "-i", job.inputPath,
        "-o", job.outputPath,
        "-n", "realesrgan-x4plus",
        "-s", String(job.scale),
        "-m", realesrganModelsDir(),
        "-f", "png",
      ],
    };
  }
  if (job.scale === 3) {
    return {
      binary: realesrganBinary(),
      label: "realesrgan-ncnn-vulkan (anime fallback)",
      args: [
        "-i", job.inputPath,
        "-o", job.outputPath,
        "-n", "realesrgan-x4plus-anime",
        "-s", String(job.scale),
        "-m", realesrganModelsDir(),
        "-f", "png",
      ],
    };
  }
  return {
    binary: realcuganBinary(),
    label: "realcugan-ncnn-vulkan",
    args: [
      "-i", job.inputPath,
      "-o", job.outputPath,
      "-n", "2",
      "-s", String(job.scale),
      "-m", realcuganModelsDir(),
      "-f", "png",
    ],
  };
}
