import { useStore } from "../store";
import type { UpscaleJob } from "../types";

export function UpscaleButton() {
  const queue = useStore((s) => s.queue);
  const mode = useStore((s) => s.mode);
  const scale = useStore((s) => s.scale);
  const outputDir = useStore((s) => s.outputDir);
  const startJob = useStore((s) => s.startJob);
  const resetStatuses = useStore((s) => s.resetStatuses);
  const clearImages = useStore((s) => s.clearImages);
  const processing = useStore((s) => s.isProcessing());

  const hasWork = queue.length > 0;

  const onClick = async () => {
    if (processing) {
      await window.cove.cancelAll();
      return;
    }
    if (!hasWork) return;

    resetStatuses();
    const jobs: UpscaleJob[] = queue.map((q) => {
      const jobId = `job-${q.image.id}-${Date.now()}`;
      const { base, ext } = splitName(q.image.name);
      const outName = `${base}_${scale}x_${mode}.png`;
      const outPath = joinPath(
        outputDir ?? dirname(q.image.path),
        outName,
      );
      startJob(q.image.id, jobId);
      void ext;
      return {
        id: jobId,
        inputPath: q.image.path,
        outputPath: outPath,
        mode,
        scale,
      };
    });
    await window.cove.enqueue(jobs);
  };

  return (
    <div className="flex items-center gap-2">
      {hasWork && !processing && (
        <button
          onClick={clearImages}
          className="rounded-lg border border-cove-border px-3 py-2 text-sm text-cove-muted hover:border-cove-danger hover:text-cove-danger"
        >
          Clear
        </button>
      )}
      <button
        onClick={onClick}
        disabled={!hasWork}
        className={`rounded-lg px-5 py-2 text-sm font-semibold transition-colors ${
          processing
            ? "bg-cove-danger text-white hover:bg-cove-danger/90"
            : "bg-cove-accent text-cove-bg hover:bg-cove-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
        }`}
      >
        {processing ? "Cancel" : `Upscale ${queue.length || ""}`.trim()}
      </button>
    </div>
  );
}

function splitName(name: string): { base: string; ext: string } {
  const i = name.lastIndexOf(".");
  if (i <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, i), ext: name.slice(i) };
}

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : ".";
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  if (dir.endsWith(sep)) return `${dir}${name}`;
  return `${dir}${sep}${name}`;
}
