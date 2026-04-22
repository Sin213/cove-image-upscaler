import { useStore } from "../store";
import type { Scale } from "../types";

const SCALES: Scale[] = [2, 3, 4];

export function ScalePicker() {
  const scale = useStore((s) => s.scale);
  const setScale = useStore((s) => s.setScale);
  const disabled = useStore((s) => s.isProcessing());

  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-cove-muted">
        Scale
      </div>
      <div className="inline-flex rounded-lg border border-cove-border bg-cove-surface p-1">
        {SCALES.map((s) => (
          <button
            key={s}
            disabled={disabled}
            onClick={() => setScale(s)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              scale === s
                ? "bg-cove-accent text-cove-bg"
                : "text-cove-muted hover:text-cove-text"
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}
