import { AI_SCALES, PIXEL_SCALES } from "../../electron/types";
import { useStore } from "../store";
import type { AnyScale, Mode } from "../types";

// One mode-aware source of truth; the tuples keep their literal scale types.
const SCALES_BY_MODE = {
  photo: AI_SCALES,
  anime: AI_SCALES,
  pixel: PIXEL_SCALES,
} as const;

interface Hint {
  headline: string;
  detail: string;
}

// Keyed per mode by that mode's actual scales, so each map stays exhaustive
// without inventing Pixel-only entries for the AI modes.
type HintsByMode = {
  [M in Mode]: { [S in (typeof SCALES_BY_MODE)[M][number]]: Hint };
};

// One template so every Pixel scale states the same production contract:
// nearest-neighbor, N x N blocks, no smoothing, artifacts enlarged not repaired.
function pixelHint(s: (typeof PIXEL_SCALES)[number]): Hint {
  return {
    headline: `${s}× blocks`,
    detail: `Exact nearest-neighbor enlargement. Every source pixel becomes ${s === 8 ? "an" : "a"} ${s} × ${s} block with no smoothing or blending. Existing compression artifacts are enlarged, not repaired.`,
  };
}

const HINTS: HintsByMode = {
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
  pixel: {
    2: pixelHint(2),
    3: pixelHint(3),
    4: pixelHint(4),
    5: pixelHint(5),
    6: pixelHint(6),
    8: pixelHint(8),
  },
};

export function ScalePicker() {
  const scale = useStore((s) => s.scale);
  const mode = useStore((s) => s.mode);
  const setScale = useStore((s) => s.setScale);
  const disabled = useStore((s) => s.isProcessing());

  const scales: readonly AnyScale[] = SCALES_BY_MODE[mode];
  const hints: Partial<Record<AnyScale, Hint>> = HINTS[mode];

  return (
    <div className="flex flex-col gap-1.5">
      <span className="field-label">Scale</span>
      <div className="segmented">
        {scales.map((s) => {
          const hint = hints[s];
          return (
            <div key={s} className="tooltip-host">
              <button
                disabled={disabled}
                onClick={() => setScale(s)}
                className={scale === s ? "active" : ""}
              >
                {s}×
              </button>
              {hint && (
                <div className="tooltip-bubble">
                  <b>{hint.headline}</b>
                  <div className="mt-0.5 text-text-2">{hint.detail}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
