import { useStore } from "../store";
import type { Mode, Scale } from "../types";

const SCALES: Scale[] = [2, 3, 4];

const HINTS: Record<Mode, Record<Scale, { headline: string; detail: string }>> = {
  photo: {
    2: { headline: "Recommended", detail: "Fastest. Balanced detail — works on any photo." },
    3: { headline: "Stronger detail", detail: "Slower than 2×. Good middle ground." },
    4: { headline: "Maximum detail", detail: "Slowest. Try 2× first if output looks tiled or torn." },
  },
  anime: {
    2: { headline: "Recommended", detail: "Real-CUGAN ×2 — clean, fast, reliable on any source." },
    3: { headline: "Real-CUGAN ×3", detail: "Stronger detail than 2×. Native model — no fallback." },
    4: { headline: "Maximum detail", detail: "Slowest. May tile-artifact on certain sources — drop to 2× if so." },
  },
};

export function ScalePicker() {
  const scale = useStore((s) => s.scale);
  const mode = useStore((s) => s.mode);
  const setScale = useStore((s) => s.setScale);
  const disabled = useStore((s) => s.isProcessing());

  return (
    <div className="flex flex-col gap-1.5">
      <span className="field-label">Scale</span>
      <div className="segmented">
        {SCALES.map((s) => {
          const hint = HINTS[mode][s];
          return (
            <div key={s} className="tooltip-host">
              <button
                disabled={disabled}
                onClick={() => setScale(s)}
                className={scale === s ? "active" : ""}
              >
                {s}×
              </button>
              <div className="tooltip-bubble">
                <b>{hint.headline}</b>
                <div className="mt-0.5 text-text-2">{hint.detail}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
