import { useEffect, useState } from "react";
import type { CleanupSuggestion, ScanMeta, TrashJob } from "../../shared/types";
import * as api from "../api";
import { formatBytes, reasonColor } from "../format";

interface CleanupScreenProps {
  scan: ScanMeta | null;
  suggestions: CleanupSuggestion[];
  reclaimTotalLabel: string;
  onHide: (ids: string[]) => void;
  onUnhide: (ids: string[]) => void;
  trashEvent: TrashJob | null;
}

interface PendingTrash {
  jobId: string;
  suggestionIds: string[];
  count: number;
  size: number;
  firesAt: number;
  committed: boolean;
}

export function CleanupScreen({ scan, suggestions, reclaimTotalLabel, onHide, onUnhide, trashEvent }: CleanupScreenProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null);
  const [pending, setPending] = useState<PendingTrash | null>(null);

  useEffect(() => {
    setSelectedIds(null);
  }, [scan?.id]);

  useEffect(() => {
    if (!pending) return;
    // The items are already hidden optimistically — just clear the banner a
    // few seconds after the commit (the fallback covers a missed update).
    const delay = pending.committed ? 4000 : Math.max(0, pending.firesAt - Date.now()) + 10000;
    const timer = setTimeout(() => setPending(null), delay);
    return () => clearTimeout(timer);
  }, [pending]);

  useEffect(() => {
    if (!trashEvent || trashEvent.status !== "committed") return;
    const job = trashEvent;
    setPending((current) =>
      current?.jobId === job.id ? { ...current, size: job.freedBytes ?? current.size, committed: true } : current
    );
  }, [trashEvent]);

  const effectiveSelected = selectedIds ?? new Set(suggestions.map((item) => item.id));
  const selectedSuggestions = suggestions.filter((item) => effectiveSelected.has(item.id));
  const selectedSize = selectedSuggestions.reduce((sum, item) => sum + item.size, 0);
  const allSelected = suggestions.length > 0 && selectedSuggestions.length === suggestions.length;

  const toggleOne = (id: string) => {
    setSelectedIds((current) => {
      const base = current ?? new Set(suggestions.map((item) => item.id));
      const next = new Set(base);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(suggestions.map((item) => item.id)));
  };

  const trashSuggestions = async (items: CleanupSuggestion[]) => {
    if (!items.length || !scan) return;
    const ids = items.map((item) => item.id);
    const paths = items.flatMap((item) => item.paths);
    onHide(ids);
    try {
      const { job } = await api.trashPaths(scan.id, paths);
      const size = items.reduce((sum, item) => sum + item.size, 0);
      setPending({ jobId: job.id, suggestionIds: ids, count: items.length, size, firesAt: job.firesAt, committed: false });
    } catch {
      onUnhide(ids);
    }
  };

  const undo = async () => {
    if (!pending) return;
    const current = pending;
    const { job } = await api.undoTrash(current.jobId).catch(() => ({ job: null }));
    if (job && job.status !== "cancelled") return; // too late: the banner stays and shows what was freed
    onUnhide(current.suggestionIds);
    setPending(null);
  };

  const allClean = suggestions.length === 0 && !pending;

  return (
    <div className="cleanup-screen">
      <div className="cleanup-header">
        <div>
          <div className="cleanup-header-title-row">
            <div className="cleanup-header-icon">
              <SparkIcon />
            </div>
            <div className="cleanup-header-title">Suggested cleanup</div>
          </div>
          <div className="cleanup-header-sub">
            Safe-to-remove files from this scan. Review, then move to Trash — nothing is gone until you empty it.
          </div>
        </div>
        <div style={{ textAlign: "right", flex: "0 0 auto" }}>
          <div style={{ fontSize: 11, color: "var(--fg-3)" }}>Reclaimable</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: "var(--ok)" }}>{reclaimTotalLabel}</div>
        </div>
      </div>

      {pending ? (
        <div className="trashed-banner">
          <CheckIcon />
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>
            {pending.committed
              ? `Freed ${formatBytes(pending.size)} · empty Trash to reclaim it on disk`
              : `Moved ${pending.count} file${pending.count === 1 ? "" : "s"} to Trash · ${formatBytes(pending.size)}`}
          </span>
          {pending.committed ? null : (
            <button type="button" className="undo-btn" onClick={undo}>
              Undo
            </button>
          )}
        </div>
      ) : null}

      <div className="cleanup-toolbar">
        <button type="button" className="select-all-btn" onClick={toggleAll} disabled={!suggestions.length}>
          <span className={`checkbox ${allSelected ? "on" : ""}`}>{allSelected ? <CheckIcon size={12} /> : null}</span>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Select all</span>
        </button>
        <span style={{ fontSize: 13, color: "var(--fg-2)" }}>
          {selectedSuggestions.length} selected · {formatBytes(selectedSize)}
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className={`trash-selected-btn ${selectedSuggestions.length ? "active" : ""}`}
          disabled={!selectedSuggestions.length}
          onClick={() => trashSuggestions(selectedSuggestions)}
        >
          <TrashIcon /> Move to Trash
        </button>
      </div>

      <div className="cleanup-list">
        {suggestions.map((item) => {
          const on = effectiveSelected.has(item.id);
          const color = reasonColor(item.category);
          return (
            <div key={item.id} className={`cleanup-row ${on ? "selected" : ""}`}>
              <button type="button" className="row-checkbox-btn" onClick={() => toggleOne(item.id)}>
                <span className={`checkbox ${on ? "on" : ""}`}>{on ? <CheckIcon size={12} /> : null}</span>
              </button>
              <div className="cleanup-row-icon" style={{ background: `${color}24`, color }}>
                <FileIcon />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="cleanup-row-name">{item.name}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 4 }}>
                  <span className="mono cleanup-row-path">{item.path}</span>
                  <span className="reason-tag" style={{ color, background: `${color}21` }}>
                    {item.reason}
                  </span>
                </div>
              </div>
              <div className="mono cleanup-row-size">{formatBytes(item.size)}</div>
              <button type="button" className="row-trash-btn" onClick={() => trashSuggestions([item])}>
                <TrashIcon />
              </button>
            </div>
          );
        })}
        {allClean ? (
          <div className="cleanup-all-clean">
            <div className="cleanup-all-clean-icon">
              <CheckIcon size={28} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--fg)" }}>All cleaned up</div>
            <div style={{ fontSize: 13, marginTop: 5 }}>No more suggestions for this folder.</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SparkIcon() {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M12 3l1.6 4L18 8.6l-4.4 1.6L12 15l-1.6-4.8L6 8.6 10.4 7z" />
    </svg>
  );
}

function CheckIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}>
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <polyline points="13 2 13 9 20 9" />
    </svg>
  );
}
