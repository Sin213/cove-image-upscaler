import { useCallback, useState } from "react";
import { useStore } from "../store";

export function Dropzone() {
  const addImages = useStore((s) => s.addImages);
  const [hover, setHover] = useState(false);

  const onBrowse = useCallback(async () => {
    const imgs = await window.cove.pickInputFiles();
    if (imgs.length) addImages(imgs);
  }, [addImages]);

  return (
    <div
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        setHover(true);
      }}
      onDragLeave={() => setHover(false)}
      onDrop={() => setHover(false)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onBrowse();
      }}
      className={`flex flex-col items-center justify-center gap-3.5 rounded-2xl border-[1.5px] border-dashed px-8 py-14 text-center transition-colors ${
        hover ? "border-accent" : "border-border-hi"
      }`}
      style={{
        background:
          "repeating-linear-gradient(135deg, #0a1013 0 8px, #0c1417 8px 16px)",
      }}
    >
      <div
        className="grid h-14 w-14 place-items-center rounded-2xl border border-border-hi bg-[#0e171b] text-accent"
        style={{
          boxShadow:
            "0 0 0 6px rgba(94, 234, 212, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.04)",
        }}
      >
        <ImageIcon />
      </div>

      <div>
        <div className="text-[16px] font-semibold tracking-tight text-text">
          {hover ? "Drop to add to queue" : "Drop images or folders here"}
        </div>
        <div className="mt-1 text-[12.5px] text-text-3">
          PNG · JPG · WEBP. Files stay on your machine.
        </div>
      </div>

      <button onClick={onBrowse} className="btn-outline mt-1">
        <UploadIcon /> Choose images…
      </button>
    </div>
  );
}

function ImageIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V7" />
      <path d="M7 12l5-5 5 5" />
      <path d="M5 21h14" />
    </svg>
  );
}
