import { useStore } from "../store";
import type { Mode } from "../types";

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: "photo", label: "Photo", hint: "Real-world images" },
  { value: "anime", label: "Anime", hint: "Illustrations & anime" },
];

export function ModeToggle() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const disabled = useStore((s) => s.isProcessing());

  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-cove-muted">
        Content type
      </div>
      <div className="inline-flex rounded-lg border border-cove-border bg-cove-surface p-1">
        {MODES.map((m) => (
          <button
            key={m.value}
            disabled={disabled}
            onClick={() => setMode(m.value)}
            title={m.hint}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              mode === m.value
                ? "bg-cove-accent text-cove-bg"
                : "text-cove-muted hover:text-cove-text"
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}
