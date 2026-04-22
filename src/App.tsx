import { useEffect } from "react";
import { Dropzone } from "./components/Dropzone";
import { ImageQueue } from "./components/ImageQueue";
import { ModeToggle } from "./components/ModeToggle";
import { OutputPicker } from "./components/OutputPicker";
import { ScalePicker } from "./components/ScalePicker";
import { ThemeToggle } from "./components/ThemeToggle";
import { UpscaleButton } from "./components/UpscaleButton";
import { useStore } from "./store";

export function App() {
  const applyProgress = useStore((s) => s.applyProgress);
  const hasQueue = useStore((s) => s.queue.length > 0);

  useEffect(() => {
    return window.cove.onProgress((p) => applyProgress(p));
  }, [applyProgress]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-cove-border px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Cove Upscaler</h1>
          <p className="text-xs text-cove-muted">
            AI image upscaling for photos and anime, powered by NCNN Vulkan.
          </p>
        </div>
        <ThemeToggle />
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          {!hasQueue && <Dropzone />}

          <div className="flex flex-wrap items-end gap-4">
            <ModeToggle />
            <ScalePicker />
            <OutputPicker />
          </div>

          {hasQueue && (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-cove-muted">Queue</h2>
                <button
                  onClick={async () => {
                    const imgs = await window.cove.pickInputFiles();
                    if (imgs.length) useStore.getState().addImages(imgs);
                  }}
                  className="text-xs text-cove-accent hover:underline"
                >
                  + Add more
                </button>
              </div>
              <ImageQueue />
            </>
          )}
        </div>
      </main>

      <footer className="flex items-center justify-end border-t border-cove-border bg-cove-surface/60 px-6 py-3">
        <UpscaleButton />
      </footer>
    </div>
  );
}
