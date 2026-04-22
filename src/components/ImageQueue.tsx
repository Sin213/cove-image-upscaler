import { useStore } from "../store";
import type { QueueEntry } from "../store";

export function ImageQueue() {
  const queue = useStore((s) => s.queue);
  const removeImage = useStore((s) => s.removeImage);

  if (queue.length === 0) return null;

  return (
    <div className="space-y-2">
      {queue.map((entry) => (
        <Row key={entry.image.id} entry={entry} onRemove={() => removeImage(entry.image.id)} />
      ))}
    </div>
  );
}

function Row({ entry, onRemove }: { entry: QueueEntry; onRemove: () => void }) {
  const { image, status, percent, error, outputPath } = entry;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-cove-border bg-cove-surface p-3">
      <img
        src={image.thumbnailDataUrl}
        alt={image.name}
        className="h-14 w-14 rounded-md object-cover"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="truncate text-sm font-medium" title={image.path}>
            {image.name}
          </div>
          <div className="flex items-center gap-2 text-xs text-cove-muted">
            <span>{image.width}×{image.height}</span>
            <StatusBadge status={status} percent={percent} />
          </div>
        </div>
        <ProgressBar status={status} percent={percent} />
        {error && (
          <div className="mt-1 truncate text-xs text-cove-danger" title={error}>
            {error}
          </div>
        )}
        {outputPath && status === "done" && (
          <button
            onClick={() => window.cove.revealInFolder(outputPath)}
            className="mt-1 text-xs text-cove-accent hover:underline"
          >
            Reveal in folder
          </button>
        )}
      </div>
      <button
        onClick={onRemove}
        disabled={status === "running" || status === "queued"}
        className="rounded-md px-2 py-1 text-cove-muted hover:bg-cove-border hover:text-cove-text disabled:opacity-40"
        title="Remove"
      >
        ✕
      </button>
    </div>
  );
}

function StatusBadge({ status, percent }: { status: QueueEntry["status"]; percent: number }) {
  if (status === "running") return <span className="text-cove-accent">{percent.toFixed(0)}%</span>;
  if (status === "queued") return <span>queued</span>;
  if (status === "done") return <span className="text-cove-success">done</span>;
  if (status === "error") return <span className="text-cove-danger">error</span>;
  if (status === "cancelled") return <span>cancelled</span>;
  return null;
}

function ProgressBar({ status, percent }: { status: QueueEntry["status"]; percent: number }) {
  if (status === "idle") return null;
  const width = status === "done" ? 100 : percent;
  const color =
    status === "error" || status === "cancelled"
      ? "bg-cove-danger"
      : status === "done"
        ? "bg-cove-success"
        : "bg-cove-accent";
  return (
    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cove-border">
      <div
        className={`h-full transition-all ${color}`}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}
