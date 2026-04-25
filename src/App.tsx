import { useEffect, useState } from "react";
import { Dropzone } from "./components/Dropzone";
import { ImageQueue } from "./components/ImageQueue";
import { LogPanel } from "./components/LogPanel";
import { ModeToggle } from "./components/ModeToggle";
import { OutputPicker } from "./components/OutputPicker";
import { ScalePicker } from "./components/ScalePicker";
import { Titlebar } from "./components/Titlebar";
import { UpscaleButton } from "./components/UpscaleButton";
import { useStore } from "./store";

export function App() {
  const applyProgress = useStore((s) => s.applyProgress);
  const log = useStore((s) => s.log);
  const queue = useStore((s) => s.queue);
  const isProcessing = useStore((s) => s.isProcessing());
  const hasQueue = queue.length > 0;
  const [dragCount, setDragCount] = useState(0);
  const isDragOver = dragCount > 0;

  useEffect(() => {
    return window.cove.onProgress((p) => applyProgress(p));
  }, [applyProgress]);

  const counts = countByStatus(queue);
  const queued = queue.filter((q) => q.status === "queued" || q.status === "idle");

  let statusState: "idle" | "running" | "done" | "error" = "idle";
  let statusLabel = "ready";
  if (counts.error > 0 && counts.running === 0) {
    statusState = "error";
    statusLabel = `${counts.error} error${counts.error === 1 ? "" : "s"}`;
  } else if (counts.running > 0) {
    statusState = "running";
    statusLabel = `${counts.running} running`;
  } else if (counts.done > 0 && counts.done === queue.length && queue.length > 0) {
    statusState = "done";
    statusLabel = `${counts.done} done`;
  } else if (queued.length > 0) {
    statusState = "idle";
    statusLabel = `${queued.length} queued`;
  }

  const handleFiles = async (paths: string[]) => {
    if (paths.length === 0) return;
    const imgs = await window.cove.importDroppedPaths(paths);
    if (imgs.length === 0) {
      log("warn", "Nothing imported", "no images recognized in drop");
      return;
    }
    useStore.getState().addImages(imgs);
  };

  const onDragEnter = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    setDragCount((c) => c + 1);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    setDragCount((c) => Math.max(0, c - 1));
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    setDragCount(0);
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => {
        try {
          return window.cove.getPathForFile(f);
        } catch {
          return "";
        }
      })
      .filter((p) => !!p);
    void handleFiles(paths);
  };

  return (
    <div className="flex h-full flex-col bg-bg-2 text-text">
      <Titlebar />

      <main
        className="relative flex flex-1 flex-col overflow-hidden bg-bg-2"
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <div className="flex flex-1 flex-col gap-[18px] overflow-hidden px-9 pt-7">
          {/* Header */}
          <div className="grid grid-cols-[1fr_auto] items-start gap-4 py-1">
            <div>
              <h1 className="m-0 text-[26px] font-bold leading-tight tracking-tight text-text">
                Cove Image Upscaler
              </h1>
              <p className="mt-1.5 max-w-[560px] text-[13px] text-text-3">
                AI image upscaling — Real-ESRGAN for photos, Real-CUGAN for anime. Powered by NCNN Vulkan.
              </p>
            </div>
            <span className={`status-pill ${pillClass(statusState)}`}>
              <span className="dot" />
              {statusLabel}
            </span>
          </div>

          {/* Controls */}
          <div className="grid items-end gap-4" style={{ gridTemplateColumns: "auto auto 1fr" }}>
            <ModeToggle />
            <ScalePicker />
            <OutputPicker />
          </div>

          {/* Queue header */}
          <div className="flex items-center justify-between px-0.5">
            <div className="flex items-center gap-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.6px] text-text-3">
              <span>Queue</span>
              {hasQueue && (
                <span className="font-normal lowercase tracking-[0.4px] text-text-3">
                  · {queue.length} {queue.length === 1 ? "image" : "images"}
                </span>
              )}
            </div>
            <button
              onClick={async () => {
                const imgs = await window.cove.pickInputFiles();
                if (imgs.length) useStore.getState().addImages(imgs);
              }}
              disabled={isProcessing}
              className="btn-outline"
            >
              <PlusIcon /> Add more
            </button>
          </div>

          {/* Queue body */}
          <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1 pb-2">
            {hasQueue ? <ImageQueue /> : <Dropzone />}
          </div>
        </div>

        {/* Drop overlay (when dragging files in over a non-empty queue) */}
        {isDragOver && hasQueue && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-bg/70 backdrop-blur-sm">
            <div className="rounded-2xl border-2 border-dashed border-accent bg-accent-soft px-8 py-6 text-center">
              <div className="text-[15px] font-semibold text-accent">Drop to add to queue</div>
              <div className="mt-1 font-mono text-[10.5px] uppercase tracking-[0.12em] text-text-2">
                PNG · JPG · WEBP · folders
              </div>
            </div>
          </div>
        )}

        {/* Bottom: log panel + action bar */}
        <LogPanel />
        <div className="flex items-center justify-end gap-2.5 px-9 pb-4 pt-3">
          <UpscaleButton />
        </div>
      </main>
    </div>
  );
}

function pillClass(state: "idle" | "running" | "done" | "error"): string {
  if (state === "running") return "status-pill-running";
  if (state === "done") return "status-pill-done";
  if (state === "error") return "status-pill-error";
  return "";
}

function countByStatus(queue: ReturnType<typeof useStore.getState>["queue"]) {
  let done = 0, running = 0, queued = 0, error = 0;
  for (const q of queue) {
    if (q.status === "done") done++;
    else if (q.status === "running") running++;
    else if (q.status === "queued") queued++;
    else if (q.status === "error") error++;
  }
  return { done, running, queued, error };
}

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}
