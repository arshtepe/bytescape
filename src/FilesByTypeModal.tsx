import { useEffect, useState } from "react";
import type { FileGroup, FileRecord, FileTypeSummary, ScanMeta } from "../shared/types";
import * as api from "./api";
import { categoryColor, formatBytes, normalizeExtension } from "./format";

interface FilesByTypeModalProps {
  open: boolean;
  scan: ScanMeta | null;
  onClose: () => void;
}

interface GroupFilesState {
  files: FileRecord[];
  nextOffset: number | null;
  totalCount: number;
  loading: boolean;
  error: string;
}

export function FilesByTypeModal({ open, scan, onClose }: FilesByTypeModalProps) {
  const [activeCat, setActiveCat] = useState("all");
  const [query, setQuery] = useState("");
  const [types, setTypes] = useState<FileTypeSummary[]>([]);
  const [groups, setGroups] = useState<FileGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [generatedAt, setGeneratedAt] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [groupFiles, setGroupFiles] = useState<Map<string, GroupFilesState>>(new Map());
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!open) return;
    setActiveCat("all");
    setQuery("");
    setExpanded(new Set());
    setGroupFiles(new Map());
  }, [open, scan?.id]);

  useEffect(() => {
    if (!open || !scan) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    api
      .getFileGroups(scan.id, { type: activeCat, q: normalizeExtension(query) })
      .then((payload) => {
        if (cancelled) return;
        setTypes(payload.types);
        setGroups(payload.groups);
        setGeneratedAt(payload.generatedAt);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, scan?.id, activeCat, query, refreshTick]);

  if (!open) return null;

  const loadGroupFiles = (group: FileGroup, offset: number) => {
    if (!scan) return;
    setGroupFiles((current) => {
      const next = new Map(current);
      const existing = next.get(group.key) || { files: [], nextOffset: null, totalCount: group.count, loading: false, error: "" };
      next.set(group.key, { ...existing, loading: true, error: "" });
      return next;
    });
    api
      .getFileGroupFiles(scan.id, group.key, offset)
      .then((payload) => {
        setGroupFiles((current) => {
          const next = new Map(current);
          const existing = next.get(group.key);
          next.set(group.key, {
            files: offset > 0 ? [...(existing?.files || []), ...payload.files] : payload.files,
            nextOffset: payload.nextOffset,
            totalCount: payload.totalCount,
            loading: false,
            error: ""
          });
          return next;
        });
      })
      .catch((err: Error) => {
        setGroupFiles((current) => {
          const next = new Map(current);
          const existing = next.get(group.key);
          if (existing) next.set(group.key, { ...existing, loading: false, error: err.message });
          return next;
        });
      });
  };

  const toggleGroup = (group: FileGroup) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(group.key)) next.delete(group.key);
      else {
        next.add(group.key);
        if (!groupFiles.has(group.key)) loadGroupFiles(group, 0);
      }
      return next;
    });
  };

  const copyTop10 = async (group?: FileGroup) => {
    if (!scan) return;
    const payload = await api.getTopFiles(scan.id, group ? { key: group.key } : { type: activeCat, q: normalizeExtension(query) });
    const title = group ? `Top ${payload.files.length} ${group.label} files by size` : `Top ${payload.files.length} files by size`;
    const lines = [title, ...payload.files.map((file, index) => `${index + 1}. ${file.name} | ${formatBytes(file.size)} | ${file.path}`)];
    await navigator.clipboard.writeText(lines.join("\n"));
  };

  const allType = types.find((item) => item.type === "all");
  const visibleTypes = types.length ? types : [{ type: "all" as const, label: "All", count: 0, totalSize: 0 }];
  const maxGroupSize = groups.length ? Math.max(...groups.map((item) => item.totalSize), 1) : 1;

  return (
    <div className="modal-backdrop">
      <div className="files-modal">
        <div className="files-modal-header">
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="files-modal-icon">
                <TypesIcon />
              </div>
              <span style={{ fontSize: 18, fontWeight: 700 }}>Files by type</span>
            </div>
            <div className="files-modal-summary">
              <span className="mono" style={{ color: "var(--fg-3)" }}>
                {scan?.rootPath}
              </span>
              <span style={{ color: "var(--fg-2)" }}>
                <b style={{ color: "var(--fg)" }}>{(allType?.count || 0).toLocaleString()}</b> files ·{" "}
                <b style={{ color: "var(--fg)" }}>{formatBytes(allType?.totalSize || 0)}</b>
              </span>
              {generatedAt ? <span style={{ color: "var(--fg-3)" }}>Snapshot {new Date(generatedAt).toLocaleTimeString()}</span> : null}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto" }}>
            <button type="button" className="btn-secondary" disabled={!scan || loading} onClick={() => setRefreshTick((v) => v + 1)}>
              <RefreshIcon /> Refresh
            </button>
            <button type="button" className="icon-btn" onClick={onClose}>
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="files-modal-chips">
          {visibleTypes.map((item) => (
            <button
              key={item.type}
              type="button"
              className={`type-chip ${activeCat === item.type ? "active" : ""}`}
              onClick={() => setActiveCat(item.type)}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 600 }}>
                <span className="type-chip-dot" style={{ background: item.type === "all" ? "var(--accent)" : categoryColor(item.type) }} />
                {item.label}
              </span>
              <span style={{ fontSize: 12, fontWeight: 600, opacity: 0.66, marginTop: 6 }}>{formatBytes(item.totalSize)}</span>
            </button>
          ))}
        </div>

        <div className="files-modal-search">
          <div className="path-input">
            <SearchIcon />
            <input placeholder="Find an extension, e.g. .epub" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
        </div>

        <div className={`files-modal-body ${loading ? "files-modal-loading" : ""}`}>
          {loading ? (
            <div className="files-modal-spinner-overlay">
              <span className="dv-spinner" />
              <span>Analyzing files…</span>
            </div>
          ) : null}
          {error ? <div className="files-modal-empty">{error}</div> : null}
          {!loading && !error && !groups.length ? <div className="files-modal-empty">No files found for this filter.</div> : null}
          <div className="files-modal-table-head">
            <span style={{ flex: 1 }}>Extension</span>
            <span style={{ width: 96, textAlign: "right" }}>Files</span>
            <span style={{ width: 112, textAlign: "right" }}>Size</span>
            <span style={{ width: 200 }} />
          </div>
          {groups.map((group) => {
            const isOpen = expanded.has(group.key);
            const record = groupFiles.get(group.key);
            const color = categoryColor(group.type);
            return (
              <div key={group.key} className="file-group">
                <div className="file-group-row" onClick={() => toggleGroup(group)}>
                  <span className="file-group-icon" style={{ background: `${color}24`, color }}>
                    {group.extension ? group.extension.slice(0, 4).toUpperCase() : "—"}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{group.label}</div>
                    <span className="reason-tag" style={{ color, background: `${color}21` }}>
                      {group.typeLabel}
                    </span>
                  </div>
                  <div style={{ width: 96, textAlign: "right" }}>
                    <div className="mono" style={{ fontSize: 13.5, fontWeight: 600 }}>
                      {group.count.toLocaleString()}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--fg-3)" }}>files</div>
                  </div>
                  <div style={{ width: 112, textAlign: "right" }}>
                    <div className="mono" style={{ fontSize: 13.5, fontWeight: 600 }}>
                      {formatBytes(group.totalSize)}
                    </div>
                    <div className="group-size-bar-track">
                      <div className="group-size-bar-fill" style={{ width: `${(group.totalSize / maxGroupSize) * 100}%`, background: color }} />
                    </div>
                  </div>
                  <div style={{ width: 200, display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        copyTop10(group);
                      }}
                    >
                      Copy top 10
                    </button>
                    <button type="button" className="btn-secondary" onClick={(event) => event.stopPropagation()}>
                      {isOpen ? "Hide" : "View files"}
                    </button>
                  </div>
                </div>
                {isOpen ? (
                  <div className="file-list">
                    {record?.error ? <div className="file-list-note">{record.error}</div> : null}
                    {(record?.files || []).map((file) => (
                      <div key={file.path} className="file-list-row">
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <strong style={{ fontSize: 13, fontWeight: 600 }}>{file.name}</strong>
                          <div className="mono file-list-path">{file.path}</div>
                        </div>
                        <span className="mono" style={{ fontSize: 12.5, fontWeight: 600, flex: "0 0 auto" }}>
                          {formatBytes(file.size)}
                        </span>
                      </div>
                    ))}
                    {record?.loading ? <div className="file-list-note">Loading…</div> : null}
                    {record?.nextOffset ? (
                      <button type="button" className="link-btn" onClick={() => loadGroupFiles(group, record.nextOffset as number)}>
                        Load more ({Math.max(0, record.totalCount - (record.files?.length || 0)).toLocaleString()} remaining)
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TypesIcon() {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
      <path d="M3 3v18h18" />
      <rect x={7} y={12} width={3} height={6} rx={1} />
      <rect x={12} y={8} width={3} height={10} rx={1} />
      <rect x={17} y={5} width={3} height={13} rx={1} />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
      <path d="M4 12a8 8 0 1 1 2.3 5.6" />
      <polyline points="4 20 4 14 10 14" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
      <line x1={6} y1={6} x2={18} y2={18} />
      <line x1={18} y1={6} x2={6} y2={18} />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="var(--fg-3)" strokeWidth={2}>
      <circle cx={11} cy={11} r={7} />
      <line x1={21} y1={21} x2={16.5} y2={16.5} />
    </svg>
  );
}
