import { useStore } from "../store";

export function OutputPicker() {
  const outputDir = useStore((s) => s.outputDir);
  const setOutputDir = useStore((s) => s.setOutputDir);
  const queue = useStore((s) => s.queue);
  const disabled = useStore((s) => s.isProcessing());

  const onPick = async () => {
    const dir = await window.cove.pickOutputDir();
    if (dir) setOutputDir(dir);
  };

  // If user hasn't set an explicit folder, fall back to the most recent
  // completed job's directory so "Open" still finds something useful.
  const effectiveDir =
    outputDir ??
    (() => {
      for (let i = queue.length - 1; i >= 0; i--) {
        const q = queue[i];
        if (q.status === "done" && q.outputPath) return dirname(q.outputPath);
      }
      return null;
    })();

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span className="field-label">Output folder</span>
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-1.5">
        <input
          value={outputDir ?? ""}
          onChange={(e) => setOutputDir(e.target.value || null)}
          placeholder="Same folder as input"
          spellCheck={false}
          disabled={disabled}
          className="folder-input"
        />
        <button
          type="button"
          onClick={onPick}
          disabled={disabled}
          className="sq-btn"
          title="Browse for folder"
          aria-label="Browse for folder"
        >
          <FolderOpenIcon />
        </button>
        <button
          type="button"
          onClick={() => effectiveDir && window.cove.openFolder(effectiveDir)}
          disabled={!effectiveDir || disabled}
          className="sq-btn"
          title={effectiveDir ? `Open ${effectiveDir}` : "Run an upscale first"}
          aria-label="Open output folder"
        >
          <ExternalIcon />
        </button>
        <button
          type="button"
          onClick={() => setOutputDir(null)}
          disabled={!outputDir || disabled}
          className="sq-btn"
          title="Reset to input folder"
          aria-label="Reset output folder"
        >
          <XIcon />
        </button>
      </div>
    </div>
  );
}

function FolderOpenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1" />
      <path d="M3 9h18l-2 9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h6v6" />
      <path d="M10 14L21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
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

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : ".";
}
