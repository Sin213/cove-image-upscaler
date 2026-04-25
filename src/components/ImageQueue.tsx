import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { QueueEntry } from "../store";
import type { UpscaleJob } from "../types";
import { CompareModal } from "./CompareModal";

export function ImageQueue() {
  const queue = useStore((s) => s.queue);
  const removeImage = useStore((s) => s.removeImage);
  const reorder = useStore((s) => s.reorder);
  const mode = useStore((s) => s.mode);
  const scale = useStore((s) => s.scale);
  const outputDir = useStore((s) => s.outputDir);
  const startJob = useStore((s) => s.startJob);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compareEntry, setCompareEntry] = useState<QueueEntry | null>(null);

  useEffect(() => {
    if (selectedId && !queue.some((q) => q.image.id === selectedId)) {
      setSelectedId(null);
    }
  }, [queue, selectedId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (compareEntry) return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) {
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (!selectedId) return;
        const entry = queue.find((q) => q.image.id === selectedId);
        if (!entry) return;
        if (entry.status === "running" || entry.status === "queued") return;
        e.preventDefault();
        removeImage(selectedId);
        setSelectedId(null);
      } else if (e.key === "Escape") {
        if (selectedId) {
          e.preventDefault();
          setSelectedId(null);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, queue, removeImage, compareEntry]);

  if (queue.length === 0) return null;

  const onRefresh = (entry: QueueEntry) => {
    const jobId = `job-${entry.image.id}-${Date.now()}`;
    startJob(entry.image.id, jobId);
    const job: UpscaleJob = {
      id: jobId,
      inputPath: entry.image.path,
      outputDir,
      mode,
      scale,
    };
    void window.cove.enqueue([job]);
  };

  return (
    <>
      <div className="flex flex-col gap-2.5">
        {queue.map((entry) => {
          const id = entry.image.id;
          const isIdle =
            entry.status === "idle" ||
            entry.status === "done" ||
            entry.status === "error" ||
            entry.status === "cancelled";
          const isDragging = dragId === id;
          const isOver = overId === id && dragId && dragId !== id;
          const isSelected = selectedId === id;
          return (
            <div
              key={id}
              draggable={isIdle}
              onDragStart={(e) => {
                if (!isIdle) {
                  e.preventDefault();
                  return;
                }
                setDragId(id);
                e.dataTransfer.effectAllowed = "move";
                try {
                  e.dataTransfer.setData("application/x-cove-row", id);
                } catch {
                  // ignore platforms that reject custom types
                }
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              onDragOver={(e) => {
                if (!dragId || dragId === id) return;
                if (!e.dataTransfer.types.includes("application/x-cove-row")) return;
                e.preventDefault();
                e.stopPropagation();
                setOverId(id);
              }}
              onDrop={(e) => {
                if (!e.dataTransfer.types.includes("application/x-cove-row")) return;
                e.preventDefault();
                e.stopPropagation();
                if (dragId && dragId !== id) reorder(dragId, id);
                setDragId(null);
                setOverId(null);
              }}
              className={`transition-opacity ${isDragging ? "opacity-40" : ""}`}
            >
              <Row
                entry={entry}
                isOver={!!isOver}
                isSelected={isSelected}
                onSelect={() => setSelectedId((cur) => (cur === id ? null : id))}
                onRemove={() => removeImage(id)}
                onCompare={() => setCompareEntry(entry)}
                onRefresh={() => onRefresh(entry)}
              />
            </div>
          );
        })}
      </div>

      {compareEntry && compareEntry.outputPath && (
        <CompareModal
          inputPath={compareEntry.image.path}
          inputName={compareEntry.image.name}
          outputPath={compareEntry.outputPath}
          inputWidth={compareEntry.image.width}
          inputHeight={compareEntry.image.height}
          scale={scale}
          mode={mode}
          onClose={() => setCompareEntry(null)}
        />
      )}
    </>
  );
}

function Row({
  entry,
  isOver,
  isSelected,
  onSelect,
  onRemove,
  onCompare,
  onRefresh,
}: {
  entry: QueueEntry;
  isOver: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onCompare: () => void;
  onRefresh: () => void;
}) {
  const { image, status, percent, error, outputPath, jobId } = entry;
  const canCompare = status === "done" && !!outputPath;
  const canCancel = (status === "running" || status === "queued") && !!jobId;
  const isRunning = status === "running";

  const onRowClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const tgt = e.target as HTMLElement;
    if (tgt.closest("button, a, input")) return;
    onSelect();
  };

  const cardBorderColor = isOver
    ? "rgb(var(--accent))"
    : isSelected
      ? "rgb(var(--accent))"
      : isRunning
        ? "rgba(96,165,250,0.30)"
        : "rgb(var(--border))";

  return (
    <div
      onClick={onRowClick}
      className="relative grid cursor-pointer items-center gap-4 rounded-xl border bg-panel px-3.5 py-3 transition-colors"
      style={{
        gridTemplateColumns: "16px 84px minmax(0,1fr) auto auto",
        borderColor: cardBorderColor,
        background: isSelected ? "rgba(94, 234, 212, 0.04)" : undefined,
      }}
    >
      <span className="flex cursor-grab items-center justify-center text-text-3 opacity-60">
        <GripIcon />
      </span>

      <div className="relative h-16 w-[84px] flex-shrink-0 overflow-hidden rounded-lg border border-border-hi bg-[#0a1013]">
        <img
          src={image.thumbnailDataUrl}
          alt={image.name}
          className="h-full w-full object-cover"
          draggable={false}
        />
        {isRunning && (
          <div className="absolute inset-0 grid place-items-center bg-black/35">
            <Spinner />
          </div>
        )}
        {status === "done" && (
          <div className="absolute inset-x-0 bottom-0 flex p-1">
            <span className="done-badge">
              <CheckIcon /> DONE
            </span>
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <div className="truncate text-[14px] font-semibold text-text" title={image.path}>
          {image.name}
        </div>
        <div className="flex items-center gap-2.5 font-mono text-[11.5px] text-text-3">
          <span>{image.width}×{image.height}</span>
          {canCompare && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onCompare();
                }}
                className="bg-transparent p-0 font-mono text-[11.5px] text-accent hover:text-text"
              >
                Compare
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (outputPath) window.cove.revealInFolder(outputPath);
                }}
                className="bg-transparent p-0 font-mono text-[11.5px] text-accent hover:text-text"
              >
                Reveal
              </button>
            </>
          )}
          {status === "running" && (
            <span style={{ color: "#93c5fd" }}>upscaling · {percent.toFixed(0)}%</span>
          )}
          {status === "queued" && <span>queued</span>}
          {status === "cancelled" && <span>cancelled</span>}
        </div>
        {error && (
          <div
            className="line-clamp-2 break-words font-mono text-[10.5px] leading-snug text-danger"
            title={error}
          >
            {error}
          </div>
        )}
      </div>

      <div>
        <StatusPill status={status} percent={percent} />
      </div>

      <RowActions
        canCancel={canCancel}
        jobId={jobId}
        onRefresh={onRefresh}
        onRemove={onRemove}
      />

      <div className="card-progress">
        <div
          className="card-progress-fill"
          style={{
            width: `${status === "done" ? 100 : status === "running" ? percent : 0}%`,
          }}
        />
      </div>
    </div>
  );
}

function StatusPill({ status, percent }: { status: QueueEntry["status"]; percent: number }) {
  if (status === "running") {
    return (
      <span className="status-pill status-pill-running">
        <span className="dot" />
        {percent.toFixed(0)}%
      </span>
    );
  }
  if (status === "queued") return <span className="status-pill"><span className="dot" />queued</span>;
  if (status === "done") return <span className="status-pill status-pill-done"><span className="dot" />done</span>;
  if (status === "error") return <span className="status-pill status-pill-error"><span className="dot" />error</span>;
  if (status === "cancelled") return <span className="status-pill status-pill-warn"><span className="dot" />cancelled</span>;
  return <span className="status-pill"><span className="dot" />idle</span>;
}

function RowActions({
  canCancel,
  jobId,
  onRefresh,
  onRemove,
}: {
  canCancel: boolean;
  jobId: string | null;
  onRefresh: () => void;
  onRemove: () => void;
}) {
  if (canCancel && jobId) {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          window.cove.cancelOne(jobId);
        }}
        title="Cancel this job"
        aria-label="Cancel this job"
        className="row-icon"
      >
        <XIcon />
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <div className="tooltip-host">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRefresh();
          }}
          className="row-icon"
          aria-label="Re-run with current settings"
        >
          <RefreshIcon />
        </button>
        <div
          className="tooltip-bubble"
          style={{ left: "auto", right: 0, transform: "translateY(4px)" }}
        >
          Re-run with current scale
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        title="Remove from queue"
        aria-label="Remove from queue"
        className="row-icon row-icon-danger"
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function GripIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <circle cx="9" cy="6" r="1.2" />
      <circle cx="9" cy="12" r="1.2" />
      <circle cx="9" cy="18" r="1.2" />
      <circle cx="15" cy="6" r="1.2" />
      <circle cx="15" cy="12" r="1.2" />
      <circle cx="15" cy="18" r="1.2" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 6l12 12" />
      <path d="M18 6l-12 12" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M9 7V4h6v3" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="animate-spin text-accent">
      <path d="M21 12a9 9 0 1 1-3-6.7" strokeLinecap="round" />
    </svg>
  );
}
