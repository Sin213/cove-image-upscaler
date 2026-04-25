import { ThemeToggle } from "./ThemeToggle";

export function Titlebar() {
  return (
    <div
      className="titlebar-drag flex h-11 flex-shrink-0 items-center justify-between gap-2 border-b border-border bg-gradient-to-b from-[#131c21] to-[#0f161a] px-3"
    >
      <div className="flex items-center gap-2.5">
        <div className="grid h-[26px] w-[26px] place-items-center overflow-hidden">
          <img
            src="./cove_icon.png"
            alt=""
            className="h-[22px] w-[22px] object-contain drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]"
          />
        </div>
        <span className="font-mono text-[11.5px] font-semibold tracking-wider text-text-2">
          Cove Image Upscaler
        </span>
        <span className="rounded-md border border-border bg-[#0b1114] px-[7px] py-[2px] font-mono text-[11px] text-text-3">
          v{__APP_VERSION__}
        </span>
      </div>

      <div className="no-drag flex items-center gap-0.5">
        <ThemeToggle />
        <button
          className="win-ctrl"
          title="Minimize"
          aria-label="Minimize"
          onClick={() => window.cove.windowMinimize()}
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14" />
          </svg>
        </button>
        <button
          className="win-ctrl"
          title="Maximize"
          aria-label="Maximize"
          onClick={() => window.cove.windowToggleMaximize()}
        >
          <div className="h-2.5 w-2.5 rounded-[2px] border-[1.5px] border-current" />
        </button>
        <button
          className="win-ctrl win-ctrl-close"
          title="Close"
          aria-label="Close"
          onClick={() => window.cove.windowClose()}
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 6l12 12" />
            <path d="M18 6l-12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
