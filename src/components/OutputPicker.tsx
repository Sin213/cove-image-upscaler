import { useStore } from "../store";

export function OutputPicker() {
  const outputDir = useStore((s) => s.outputDir);
  const setOutputDir = useStore((s) => s.setOutputDir);
  const disabled = useStore((s) => s.isProcessing());

  const onPick = async () => {
    const dir = await window.cove.pickOutputDir();
    if (dir) setOutputDir(dir);
  };

  return (
    <div className="flex-1 min-w-0">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-cove-muted">
        Output folder
      </div>
      <button
        onClick={onPick}
        disabled={disabled}
        className="flex w-full items-center gap-2 rounded-lg border border-cove-border bg-cove-surface px-3 py-1.5 text-left text-sm hover:border-cove-accent disabled:cursor-not-allowed disabled:opacity-50"
        title={outputDir ?? ""}
      >
        <span className="flex-1 truncate">
          {outputDir ?? <span className="text-cove-muted">Same folder as input (default)</span>}
        </span>
        <span className="text-cove-muted">Browse…</span>
      </button>
    </div>
  );
}
