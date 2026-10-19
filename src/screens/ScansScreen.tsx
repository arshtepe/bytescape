import { useState } from "react";
import type { ScanMeta, StorageSettings } from "../../shared/types";
import { formatBytes } from "../format";

interface ScansScreenProps {
  scans: ScanMeta[];
  storage: StorageSettings | null;
  onChangeStorage: () => void;
  onOpen: (scan: ScanMeta) => void;
  onDelete: (ids: string[]) => Promise<void>;
  onNewScan: () => void;
}

const STATUS_LABELS: Record<ScanMeta["status"], string> = {
  running: "Scanning",
  complete: "Finished",
  cancelled: "Cancelled",
  failed: "Failed"
};

export function ScansScreen({ scans, storage, onChangeStorage, onOpen, onDelete, onNewScan }: ScansScreenProps) {
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  // Only the latest scan is worth showing: starting a scan removes older
  // ones, so anything else here is left over from a run that got stuck or
  // was interrupted, and only needs a way to be cleared.
  const latest = scans.slice(0, 1);
  const leftovers = scans.slice(1).filter((scan) => scan.status !== "running");

  const remove = async (targets: ScanMeta[]) => {
    if (!targets.length) return;
    const message =
      targets.length === 1
        ? `Delete the saved scan of ${targets[0]?.rootPath}? This frees its disk space; your files are not touched.`
        : `Delete ${targets.length} old saved scans? This frees their disk space; your files are not touched.`;
    if (!window.confirm(message)) return;
    const ids = targets.map((scan) => scan.id);
    setDeleting((current) => new Set([...current, ...ids]));
    try {
      await onDelete(ids);
    } finally {
      setDeleting((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
  };

  return (
    <div className="scans-screen">
      <div className="scans-header">
        <div>
          <div className="screen-title">Last scan</div>
          <div className="screen-sub">Reopen it instantly. Starting a new scan replaces it.</div>
        </div>
        <button type="button" className="btn-primary" onClick={onNewScan}>
          <PlusIcon /> New scan
        </button>
      </div>
      {storage ? (
        <div className="scans-storage">
          <span>
            Scan data: <span className="mono">{storage.scanRoot}</span> · {formatBytes(storage.freeBytes)} free
          </span>
          <button type="button" className="btn-ghost" onClick={onChangeStorage}>
            Change…
          </button>
        </div>
      ) : null}
      <div className="scans-list">
        {latest.map((scan) => (
          <div
            role="button"
            tabIndex={0}
            key={scan.id}
            className="scan-card"
            onClick={() => onOpen(scan)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(scan);
              }
            }}
          >
            <div className="scan-card-icon">
              <FolderIcon />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="mono scan-card-path">{scan.rootPath}</div>
              <div className="scan-card-meta">
                {STATUS_LABELS[scan.status]} · {scan.progress.entriesScanned.toLocaleString()} items
                {scan.progress.errors ? ` · ${scan.progress.errors} errors` : ""}
              </div>
            </div>
            <div style={{ textAlign: "right", flex: "0 0 auto" }}>
              <div style={{ fontSize: 17, fontWeight: 700 }}>{formatBytes(scan.progress.bytesScanned)}</div>
              <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 2 }}>{new Date(scan.startedAt).toLocaleString()}</div>
            </div>
            <span className="btn-secondary scan-card-open">Open</span>
            <button
              type="button"
              className="btn-secondary btn-danger"
              title={scan.status === "running" ? "Cancel the scan before deleting it" : "Delete this saved scan"}
              disabled={scan.status === "running" || deleting.has(scan.id)}
              onClick={(event) => {
                event.stopPropagation();
                void remove([scan]);
              }}
            >
              {deleting.has(scan.id) ? "Deleting…" : "Delete"}
            </button>
          </div>
        ))}
        {!scans.length ? <div className="scans-empty">No scans yet.</div> : null}
        {leftovers.length ? (
          <div className="scans-leftovers">
            <span>
              {leftovers.length === 1 ? "1 older scan" : `${leftovers.length} older scans`} from an earlier run (stuck or interrupted) still
              {leftovers.length === 1 ? " takes" : " take"} up space.
            </span>
            <button
              type="button"
              className="btn-secondary btn-danger"
              disabled={leftovers.some((scan) => deleting.has(scan.id))}
              onClick={() => void remove(leftovers)}
            >
              {leftovers.some((scan) => deleting.has(scan.id)) ? "Deleting…" : "Delete old scans"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
      <line x1={12} y1={5} x2={12} y2={19} />
      <line x1={5} y1={12} x2={19} y2={12} />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
