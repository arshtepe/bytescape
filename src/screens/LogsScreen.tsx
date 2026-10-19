import { useMemo, useState } from "react";
import type { LogEntry, LogLevel, ScanMeta } from "../../shared/types";

interface LogsScreenProps {
  logs: LogEntry[];
  scan: ScanMeta | null;
}

type Filter = "all" | "info" | "warn" | "error";

const TAG_STYLE: Record<LogLevel, { label: string; color: string; bg: string }> = {
  info: { label: "INFO", color: "var(--fg-3)", bg: "var(--surface-2)" },
  scan: { label: "INFO", color: "var(--fg-3)", bg: "var(--surface-2)" },
  warn: { label: "WARN", color: "var(--warn)", bg: "var(--warn-soft)" },
  error: { label: "ERROR", color: "var(--danger)", bg: "var(--danger-soft)" },
  success: { label: "DONE", color: "var(--ok)", bg: "var(--ok-soft)" }
};

function matchesFilter(level: LogLevel, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "info") return level === "info" || level === "scan" || level === "success";
  if (filter === "warn") return level === "warn";
  return level === "error";
}

export function LogsScreen({ logs, scan }: LogsScreenProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const visibleLogs = useMemo(() => {
    const scoped = scan ? logs.filter((log) => log.scanId === scan.id) : logs;
    return scoped.filter((log) => matchesFilter(log.level, filter));
  }, [logs, scan, filter]);

  return (
    <div className="logs-screen">
      <div className="logs-header">
        <div>
          <div className="screen-title">Activity log</div>
          <div className="screen-sub">{scan ? `Everything from the latest scan of ${scan.rootPath}.` : "No active scan selected."}</div>
        </div>
        <div className="logs-filter-row">
          {(["all", "info", "warn", "error"] as Filter[]).map((value) => (
            <button
              key={value}
              type="button"
              className={`logs-filter-btn ${filter === value ? "active" : ""}`}
              onClick={() => setFilter(value)}
            >
              {value === "all" ? "All" : value === "info" ? "Info" : value === "warn" ? "Warnings" : "Errors"}
            </button>
          ))}
        </div>
      </div>
      <div className="logs-body">
        {visibleLogs.length ? (
          visibleLogs.map((log) => {
            const tag = TAG_STYLE[log.level];
            return (
              <div key={log.id} className="log-row">
                <span className="mono log-time">{new Date(log.at).toLocaleTimeString()}</span>
                <span className="log-tag" style={{ color: tag.color, background: tag.bg }}>
                  {tag.label}
                </span>
                <span className="mono log-message">{log.message}</span>
              </div>
            );
          })
        ) : (
          <div className="logs-empty">No log entries yet.</div>
        )}
      </div>
    </div>
  );
}
