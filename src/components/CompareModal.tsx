import { useEffect, useRef, useState } from "react";
import type { LoadedImage } from "../types";

interface Props {
  inputPath: string;
  inputName: string;
  outputPath: string;
  inputWidth: number;
  inputHeight: number;
  scale: number;
  mode: string;
  onClose: () => void;
}

export function CompareModal({
  inputPath,
  inputName,
  outputPath,
  inputWidth,
  inputHeight,
  scale,
  mode,
  onClose,
}: Props) {
  const [before, setBefore] = useState<LoadedImage | null>(null);
  const [after, setAfter] = useState<LoadedImage | null>(null);
  const [pos, setPos] = useState(50);
  const stageRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      window.cove.readImageDataUrl(inputPath, 1920),
      window.cove.readImageDataUrl(outputPath, 1920),
    ]).then(([b, a]) => {
      if (cancelled) return;
      setBefore(b);
      setAfter(a);
    });
    return () => {
      cancelled = true;
    };
  }, [inputPath, outputPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") setPos((p) => Math.max(0, p - (e.shiftKey ? 1 : 4)));
      else if (e.key === "ArrowRight") setPos((p) => Math.min(100, p + (e.shiftKey ? 1 : 4)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current || !stageRef.current) return;
      const rect = stageRef.current.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      setPos(Math.max(0, Math.min(100, x)));
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    draggingRef.current = true;
    document.body.style.cursor = "ew-resize";
    if (!stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    setPos(Math.max(0, Math.min(100, x)));
  };

  const outW = (after?.width ?? inputWidth * scale);
  const outH = (after?.height ?? inputHeight * scale);
  const inW = before?.width ?? inputWidth;
  const inH = before?.height ?? inputHeight;

  return (
    <div
      className="fixed inset-0 z-[100] flex animate-fade flex-col"
      role="dialog"
      aria-modal="true"
      style={{
        background: "rgba(5, 8, 10, 0.85)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
    >
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-[18px] px-[22px] py-4">
        <div className="flex items-center gap-3.5 min-w-0">
          <div className="grid h-8 w-8 place-items-center rounded-lg border border-accent-ring bg-accent-soft text-accent">
            <CompareIcon />
          </div>
          <div className="min-w-0">
            <h3 className="m-0 truncate text-[14px] font-semibold leading-tight text-text">
              {inputName}
            </h3>
            <div className="mt-1 flex items-center gap-2.5 font-mono text-[11.5px] text-text-3">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-accent-ring bg-accent-soft px-2 py-[2px] font-mono text-[10.5px] font-semibold text-accent">
                <span className="inline-block h-[5px] w-[5px] rounded-full bg-current" />
                {scale}× · {mode}
              </span>
              <span>{inW}×{inH}</span>
              <span style={{ color: "rgb(var(--text-3))" }}>→</span>
              <span style={{ color: "rgb(var(--text-2))" }}>{outW}×{outH}</span>
            </div>
          </div>
        </div>
        <div />
        <div className="flex items-center gap-2">
          <button
            onClick={() => window.cove.revealInFolder(outputPath)}
            className="inline-flex items-center gap-2 rounded-lg border border-border-hi bg-white/[0.03] px-3.5 py-2 text-[12.5px] text-text hover:border-border-hi hover:bg-white/[0.06]"
            title="Show output in file manager"
          >
            <FolderIcon /> Reveal in folder
          </button>
          <button
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-lg border border-border-hi bg-white/[0.03] text-text hover:bg-white/[0.06]"
            aria-label="Close"
            title="Close (Esc)"
          >
            <XIcon size={14} />
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        onPointerDown={onPointerDown}
        className="relative flex-1 cursor-ew-resize select-none overflow-hidden"
        style={{
          backgroundImage:
            "repeating-conic-gradient(rgba(255,255,255,0.02) 0% 25%, transparent 25% 50%)",
          backgroundSize: "24px 24px",
        }}
      >
        {after && (
          <img
            src={after.url}
            alt="After"
            draggable={false}
            className="absolute inset-0 h-full w-full object-contain"
          />
        )}
        {before && (
          <img
            src={before.url}
            alt="Before"
            draggable={false}
            className="absolute inset-0 h-full w-full object-contain"
            style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
          />
        )}

        <div
          className="pointer-events-none absolute top-0 bottom-0"
          style={{
            left: `${pos}%`,
            width: 2,
            transform: "translateX(-1px)",
            background: "rgb(var(--accent))",
            boxShadow: "0 0 18px rgba(94, 234, 212, 0.55)",
          }}
        />
        <div
          className="absolute grid h-9 w-9 place-items-center rounded-full text-accent"
          style={{
            top: "50%",
            left: `${pos}%`,
            transform: "translate(-50%, -50%)",
            background: "rgba(8, 12, 14, 0.85)",
            border: "1.5px solid rgb(var(--accent))",
            boxShadow:
              "0 0 0 4px rgba(94, 234, 212, 0.10), 0 8px 24px rgba(0, 0, 0, 0.55)",
            cursor: "ew-resize",
          }}
        >
          <ArrowsIcon />
        </div>

        <div
          className="pointer-events-none absolute inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-black/55 px-2.5 py-[5px] font-mono text-[11px] font-semibold tracking-wider text-text-2 backdrop-blur"
          style={{ top: 18, left: 18 }}
        >
          BEFORE
        </div>
        <div
          className="pointer-events-none absolute inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-black/55 px-2.5 py-[5px] font-mono text-[11px] font-semibold tracking-wider text-accent backdrop-blur"
          style={{ top: 18, right: 18 }}
        >
          <SparkleIcon /> AFTER · {scale}×
        </div>

        {(!before || !after) && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="flex items-center gap-2 rounded-md border border-border-hi bg-bg/80 px-3 py-2 text-[12px] text-text-2">
              <Spinner /> Loading…
            </div>
          </div>
        )}
      </div>

      <div
        className="flex items-center justify-between px-[22px] py-2.5 font-mono text-[11px] text-text-3"
        style={{
          borderTop: "1px solid rgba(255, 255, 255, 0.04)",
          background: "rgba(0, 0, 0, 0.4)",
        }}
      >
        <div>
          Drag the divider <span>·</span>
          <span className="kbd">←</span><span className="kbd">→</span> to nudge
          <span> · </span>
          <span className="kbd">Esc</span> to close
        </div>
        <div>{Math.round(pos)}%</div>
      </div>
    </div>
  );
}

function CompareIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M12 5v14" />
      <path d="m9 9-3 3 3 3" />
      <path d="m15 9 3 3-3 3" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1" />
      <path d="M3 9h18l-2 9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function XIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 6l12 12" />
      <path d="M18 6l-12 12" />
    </svg>
  );
}

function ArrowsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 7l-4 5 4 5" />
      <path d="M16 7l4 5-4 5" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" />
      <path d="M19 14l.7 1.9L21.6 17l-1.9.7L19 19.6l-.7-1.9L16.4 17l1.9-.7z" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="animate-spin text-accent">
      <path d="M21 12a9 9 0 1 1-3-6.7" strokeLinecap="round" />
    </svg>
  );
}
