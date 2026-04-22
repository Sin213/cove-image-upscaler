import { useCallback, useState } from "react";
import { useStore } from "../store";

export function Dropzone() {
  const addImages = useStore((s) => s.addImages);
  const [hover, setHover] = useState(false);

  const onBrowse = useCallback(async () => {
    const imgs = await window.cove.pickInputFiles();
    if (imgs.length) addImages(imgs);
  }, [addImages]);

  const onDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setHover(false);
      const paths = Array.from(e.dataTransfer.files)
        .map((f) => {
          try {
            return window.cove.getPathForFile(f);
          } catch {
            return "";
          }
        })
        .filter((p) => !!p);
      if (paths.length === 0) return;
      const imgs = await window.cove.importDroppedPaths(paths);
      if (imgs.length) addImages(imgs);
    },
    [addImages],
  );

  return (
    <div
      onDrop={onDrop}
      onDragOver={(e) => {
        e.preventDefault();
        setHover(true);
      }}
      onDragLeave={() => setHover(false)}
      onClick={onBrowse}
      className={`cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
        hover
          ? "border-cove-accent bg-cove-surface"
          : "border-cove-border hover:border-cove-accent hover:bg-cove-surface/50"
      }`}
    >
      <div className="text-lg font-medium">Drop images here</div>
      <div className="mt-1 text-sm text-cove-muted">
        or click to browse (PNG, JPG, WEBP)
      </div>
    </div>
  );
}
