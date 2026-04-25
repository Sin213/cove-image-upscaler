import { useStore } from "../store";
import type { Mode } from "../types";

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: "photo", label: "Photo", hint: "Real-world images (Real-ESRGAN)" },
  { value: "anime", label: "Anime", hint: "Illustrations & anime (Real-CUGAN)" },
];

export function ModeToggle() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const disabled = useStore((s) => s.isProcessing());

  return (
    <div className="flex flex-col gap-1.5">
      <span className="field-label">Content</span>
      <div className="segmented">
        {MODES.map((m) => (
          <button
            key={m.value}
            disabled={disabled}
            onClick={() => setMode(m.value)}
            title={m.hint}
            className={mode === m.value ? "active" : ""}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}
