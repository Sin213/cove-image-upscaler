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

  const queued = queue.filter((q) => q.status !== "done");
  const hasWork = queued.length > 0;

  const onClick = async () => {
    if (processing) {
      await window.cove.cancelAll();
      return;
    }
    if (!hasWork) return;

    resetStatuses();
    const jobs: UpscaleJob[] = queue.map((q) => {
      const jobId = `job-${q.image.id}-${Date.now()}`;
      startJob(q.image.id, jobId);
      return {
        id: jobId,
        inputPath: q.image.path,
        outputDir,
        mode,
        scale,
      };
    });
    await window.cove.enqueue(jobs);
  };

  return (
    <div className="flex items-center gap-2.5">
      <button
        onClick={clearImages}
        disabled={processing || queue.length === 0}
        className="btn btn-ghost"
      >
        Clear
      </button>
      {processing ? (
        <button onClick={onClick} className="btn btn-cancel">
          <CancelIcon /> Cancel
        </button>
      ) : (
        <button onClick={onClick} disabled={!hasWork} className="btn btn-primary">
          <SparkleIcon /> Upscale {hasWork ? queued.length : ""}
        </button>
      )}
    </div>
  );
}

function SparkleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" />
      <path d="M19 14l.7 1.9L21.6 17l-1.9.7L19 19.6l-.7-1.9L16.4 17l1.9-.7z" />
    </svg>
  );
}

function CancelIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 6l12 12" />
      <path d="M18 6l-12 12" />
    </svg>
  );
}
