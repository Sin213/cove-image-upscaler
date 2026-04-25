import { useEffect, useRef } from "react";
import { useStore } from "../store";
import type { LogEntry } from "../types";

export function LogPanel() {
  const logs = useStore((s) => s.logs);
  const collapsed = useStore((s) => s.logCollapsed);
  const toggle = useStore((s) => s.toggleLogCollapsed);
  const clearLogs = useStore((s) => s.clearLogs);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!collapsed && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [logs, collapsed]);

  return (
    <div
      className="flex-shrink-0 border-t border-border"
      style={{ background: "linear-gradient(180deg, transparent, rgba(0,0,0,0.25))" }}
    >
      <button
        onClick={toggle}
        className="flex w-full select-none items-center gap-2.5 px-9 py-2.5 font-mono text-[11px] text-text-3 hover:text-text-2"
        aria-expanded={!collapsed}
      >
        <Chevron open={!collapsed} />
        <span className="font-semibold uppercase tracking-[0.6px] text-text-2">Log</span>
        <span>· {logs.length} {logs.length === 1 ? "entry" : "entries"}</span>
        <div className="flex-1" />
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            clearLogs();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              clearLogs();
            }
          }}
          className="cursor-pointer font-mono text-[11px] text-text-3 hover:text-text-2"
        >
          Clear
        </span>
      </button>

      {!collapsed && (
        <div
          ref={bodyRef}
          className="overflow-y-auto px-9 pb-3 font-mono text-[11.5px] leading-[1.65] text-text-2"
          style={{ maxHeight: 140 }}
        >
          {logs.length === 0 ? (
            <div className="italic text-text-3">No entries yet.</div>
          ) : (
            <div className="flex flex-col">
              {logs.map((entry) => (
                <LogRow key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const time = new Date(entry.ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const dotColor =
    entry.level === "good"
      ? "rgb(var(--accent))"
      : entry.level === "warn"
        ? "rgb(var(--warn))"
        : entry.level === "error"
          ? "rgb(var(--danger))"
          : "rgb(var(--text-3))";
  return (
    <div
      className="grid items-baseline gap-2.5"
      style={{ gridTemplateColumns: "62px 12px 1fr" }}
    >
      <span className="text-[10.5px] text-text-3">{time}</span>
      <span style={{ color: dotColor }}>•</span>
      <span className="break-words">
        <span style={{ color: levelTextColor(entry.level) }}>{entry.text}</span>
        {entry.detail && <span className="ml-1 text-text-3">— {entry.detail}</span>}
      </span>
    </div>
  );
}

function levelTextColor(level: LogEntry["level"]): string {
  if (level === "good") return "rgb(var(--accent))";
  if (level === "warn") return "rgb(var(--warn))";
  if (level === "error") return "rgb(var(--danger))";
  return "rgb(var(--text-2))";
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-text-3 transition-transform"
      style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
