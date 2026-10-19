import { useEffect, useMemo, useRef, useState } from "react";
import type { RootChoice, ScanError, ScanMeta, ScanNode, TrashJob } from "../../shared/types";
import * as api from "../api";
import { formatBytes, paletteColor } from "../format";
import type { Mode } from "../theme";
import { Treemap } from "../components/Treemap";

const SIMPLE_SCAN_PARAMS = { maxDepth: 40, includeHidden: true };

interface StackEntry {
  name: string;
  path: string;
  isRoot: boolean;
}

// An item sent to Trash that the folder data on screen still includes. It is
// hidden and its size taken off, from the click until a fetch made after the
// server took it out of the scan ("applied") arrives without it. "committed"
// means it is in Trash but the scan could not be updated (it was running).
interface PendingTrash {
  jobId: string | null;
  size: number;
  state: "pending" | "committed" | "applied";
}

interface TrashToast {
  jobId: string;
  name: string;
  size: number;
  committed: boolean;
}

function isInside(target: string, dir: string): boolean {
  if (target === dir || !target.startsWith(dir)) return false;
  const next = target[dir.length];
  return dir.endsWith("/") || dir.endsWith("\\") || next === "/" || next === "\\";
}

function withoutPaths(current: Map<string, PendingTrash>, keep: (path: string, entry: PendingTrash) => boolean): Map<string, PendingTrash> {
  let next: Map<string, PendingTrash> | null = null;
  for (const [path, entry] of current) {
    if (keep(path, entry)) continue;
    next ??= new Map(current);
    next.delete(path);
  }
  return next ?? current;
}

interface AnalyzeScreenProps {
  mode: Mode;
  scan: ScanMeta | null;
  roots: RootChoice[];
  statusText: string;
  reclaimTotalLabel: string;
  suggestCount: number;
  onStartScan: (rootPath: string, options: { maxDepth?: number; includeHidden?: boolean }) => Promise<ScanMeta | null>;
  onCancelScan: () => Promise<void>;
  onGoCleanup: () => void;
  onOpenTypes: () => void;
  trashEvent: TrashJob | null;
}

export function AnalyzeScreen({
  mode,
  scan,
  roots,
  reclaimTotalLabel,
  suggestCount,
  onStartScan,
  onCancelScan,
  onGoCleanup,
  onOpenTypes,
  trashEvent
}: AnalyzeScreenProps) {
  const homeRoot = roots.find((item) => item.label === "Home");
  const [rootPathInput, setRootPathInput] = useState(scan?.rootPath || homeRoot?.path || "~");
  const [depth, setDepth] = useState(20);
  const [includeHidden, setIncludeHidden] = useState(true);
  const [starting, setStarting] = useState(false);
  const [picking, setPicking] = useState(false);

  // Roots load async; swap the "~" placeholder for the real home path once
  // they arrive (unless the user already typed something or a scan set it).
  useEffect(() => {
    if (homeRoot && rootPathInput === "~") setRootPathInput(homeRoot.path);
  }, [homeRoot?.path]);

  const browseForFolder = async () => {
    setPicking(true);
    try {
      const { path: picked } = await api.pickFolder();
      if (picked) setRootPathInput(picked);
    } finally {
      setPicking(false);
    }
  };

  const [stack, setStack] = useState<StackEntry[]>(
    scan ? [{ name: scan.rootPath, path: scan.rootPath, isRoot: true }] : []
  );
  const [children, setChildren] = useState<ScanNode[]>([]);
  const [node, setNode] = useState<ScanNode | null>(null);
  const [errors, setErrors] = useState<ScanError[]>([]);
  const [folderLoading, setFolderLoading] = useState(false);
  const [pendingTrash, setPendingTrash] = useState<Map<string, PendingTrash>>(new Map());
  const pendingTrashRef = useRef(pendingTrash);
  pendingTrashRef.current = pendingTrash;
  const [trashToast, setTrashToast] = useState<TrashToast | null>(null);
  // Bytes this view has sent to Trash and the server has committed.
  const [trashedBytes, setTrashedBytes] = useState(0);
  const [reloadTick, setReloadTick] = useState(0);
  const treemapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!scan) {
      setStack([]);
      return;
    }
    setStack((current) => (current.length ? current : [{ name: scan.rootPath, path: scan.rootPath, isRoot: true }]));
  }, [scan?.id]);

  const currentPath = stack.length ? stack[stack.length - 1]?.path : null;

  useEffect(() => {
    if (!scan || !currentPath) return;
    let cancelled = false;
    // Only signal loading when the *folder* changed — periodic progress
    // refetches during a running scan shouldn't flash the indicator.
    setFolderLoading((current) => current || currentPath !== node?.path);
    const timer = setTimeout(() => {
      api
        .getFolder(scan.id, currentPath)
        .then((payload) => {
          if (cancelled) return;
          setNode(payload.node);
          setChildren(payload.children);
          setErrors(payload.errors);
          // This data was fetched after those trashes were applied: it no longer has them.
          setPendingTrash((current) => withoutPaths(current, (_path, entry) => entry.state !== "applied"));
        })
        .catch((error: Error) => {
          if (!cancelled) console.error("Folder load failed:", error.message);
        })
        .finally(() => {
          if (!cancelled) setFolderLoading(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [scan?.id, scan?.status, scan?.progress.entriesScanned, currentPath, reloadTick]);

  const trashItem = async (item: ScanNode) => {
    if (!scan) return;
    const size = item.size || 0;
    setPendingTrash((current) => new Map(current).set(item.path, { jobId: null, size, state: "pending" }));
    try {
      const { job } = await api.trashPaths(scan.id, [item.path]);
      setPendingTrash((current) =>
        current.has(item.path) ? new Map(current).set(item.path, { jobId: job.id, size, state: "pending" }) : current
      );
      setTrashToast({ jobId: job.id, name: item.name, size, committed: false });
    } catch {
      // Restore the row if the request was rejected.
      setPendingTrash((current) => withoutPaths(current, (path) => path !== item.path));
    }
  };

  const undoTrash = async () => {
    if (!trashToast) return;
    const toast = trashToast;
    setTrashToast(null);
    const { job } = await api.undoTrash(toast.jobId).catch(() => ({ job: null }));
    if (!job || job.status === "cancelled") {
      setPendingTrash((current) => withoutPaths(current, (_path, entry) => entry.jobId !== toast.jobId));
    } else {
      // Too late, it is going to Trash: keep it hidden and bring the toast
      // back so the commit update can show what was freed.
      setTrashToast({ ...toast, committed: job.status === "committed" });
    }
  };

  useEffect(() => {
    const job = trashEvent;
    if (!job || job.scanId !== scan?.id) return;
    const entries = [...pendingTrashRef.current].filter(([, entry]) => entry.jobId === job.id && entry.state === "pending");
    if (!entries.length) return;
    if (job.status === "committed") {
      const state = job.freedBytes === null ? "committed" : "applied";
      setPendingTrash((current) => {
        const next = new Map(current);
        for (const [path, entry] of entries) next.set(path, { ...entry, state });
        return next;
      });
      setTrashedBytes((total) => total + (job.freedBytes ?? entries.reduce((sum, [, entry]) => sum + entry.size, 0)));
      setTrashToast((current) => (current?.jobId === job.id ? { ...current, size: job.freedBytes ?? current.size, committed: true } : current));
      if (job.freedBytes !== null) setReloadTick((tick) => tick + 1);
    } else if (job.status === "cancelled" || job.status === "failed") {
      setPendingTrash((current) => withoutPaths(current, (_path, entry) => entry.jobId !== job.id));
      setTrashToast((current) => (current?.jobId === job.id ? null : current));
    }
  }, [trashEvent]);

  // Dismiss the toast a few seconds after the trash commits; the long
  // fallback covers a commit update that never arrives.
  useEffect(() => {
    if (!trashToast) return;
    const timer = setTimeout(
      () => setTrashToast((current) => (current?.jobId === trashToast.jobId ? null : current)),
      trashToast.committed ? 5000 : 15000
    );
    return () => clearTimeout(timer);
  }, [trashToast]);

  const drill = (child: ScanNode) => {
    if (child.kind !== "directory") return;
    setStack((current) => [...current, { name: child.name, path: child.path, isRoot: false }]);
  };

  const goUp = () => setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));
  const goToCrumb = (index: number) => setStack((current) => current.slice(0, index + 1));

  const advanced = mode === "advanced";

  const handleStart = async () => {
    setStarting(true);
    try {
      // Simple mode always scans everything (full depth, hidden included);
      // Advanced exposes the manual depth stepper + hidden toggle.
      const params = advanced ? { maxDepth: depth, includeHidden } : SIMPLE_SCAN_PARAMS;
      await onStartScan(rootPathInput, params);
    } finally {
      setStarting(false);
    }
  };

  const isScanning = scan?.status === "running";

  // Stop is acknowledged at once; the scan reports "cancelled" a moment later
  // over the socket. Without this the button looked dead in between.
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!isScanning) setStopping(false);
  }, [isScanning]);
  const handleStop = async () => {
    setStopping(true);
    try {
      await onCancelScan();
    } catch {
      setStopping(false);
    }
  };
  const stopButton = (
    <button type="button" className="btn-secondary" disabled={stopping} onClick={() => void handleStop()}>
      {stopping ? "Stopping…" : "Stop"}
    </button>
  );
  const scanned = Boolean(scan);

  // Items on their way to Trash are hidden from every folder view, and their
  // size comes off right away: off this folder, the scan total, and any
  // subfolder row or tile that holds them (trash deep, then go Up).
  const pendingInside = (dirPath: string) => {
    let bytes = 0;
    for (const [path, entry] of pendingTrash) if (isInside(path, dirPath)) bytes += entry.size;
    return bytes;
  };
  const visibleChildren = pendingTrash.size
    ? children
        .filter((item) => !pendingTrash.has(item.path))
        .map((item) => {
          const bytes = item.kind === "directory" ? pendingInside(item.path) : 0;
          return bytes ? { ...item, size: Math.max(0, item.size - bytes) } : item;
        })
        .sort((a, b) => (b.size || 0) - (a.size || 0))
    : children;
  let pendingInFolder = 0;
  let pendingNotInTotal = 0;
  let pendingNotTrashed = 0;
  for (const [path, entry] of pendingTrash) {
    if (node && isInside(path, node.path)) pendingInFolder += entry.size;
    // scan:update has already taken applied items out of the total.
    if (entry.state !== "applied") pendingNotInTotal += entry.size;
    if (entry.state === "pending") pendingNotTrashed += entry.size;
  }
  const shownNode =
    node && pendingTrash.size
      ? {
          ...node,
          size: Math.max(0, node.size - pendingInFolder),
          totalChildren: Math.max(0, node.totalChildren - (children.length - visibleChildren.length))
        }
      : node;
  const movedToTrash = trashedBytes + pendingNotTrashed;

  const totalLabel = formatBytes(Math.max(0, (scan?.progress.bytesScanned || 0) - pendingNotInTotal));
  const largest = visibleChildren.find((item) => item.kind === "directory") || visibleChildren[0] || null;

  const maxChildSize = visibleChildren.length ? Math.max(...visibleChildren.map((item) => item.size || 0), 1) : 1;

  if (!scanned) {
    return (
      <EmptyState
        rootPathInput={rootPathInput}
        onRootPathChange={setRootPathInput}
        onStart={handleStart}
        starting={starting}
        picking={picking}
        onBrowse={browseForFolder}
        roots={roots}
      />
    );
  }

  return (
    <div className="analyze-screen">
      <div className="scan-bar">
        <div className="scan-bar-field">
          <div className="field-label">Folder</div>
          <div className="path-input path-input-with-browse">
            <FolderIcon />
            <input
              className="mono"
              value={rootPathInput}
              onChange={(event) => setRootPathInput(event.target.value)}
              disabled={isScanning}
            />
            <button type="button" className="browse-btn" disabled={picking || isScanning} onClick={browseForFolder}>
              Browse…
            </button>
          </div>
        </div>
        {advanced ? (
          <div>
            <div className="field-label">Depth</div>
            <div className="depth-stepper">
              <span className="mono">{depth}</span>
              <div className="depth-stepper-buttons">
                <button type="button" onClick={() => setDepth((value) => Math.min(64, value + 1))}>
                  ▲
                </button>
                <button type="button" onClick={() => setDepth((value) => Math.max(1, value - 1))}>
                  ▼
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {advanced ? (
          <label className="hidden-toggle">
            <span className={`switch ${includeHidden ? "on" : ""}`} onClick={() => setIncludeHidden((value) => !value)}>
              <span className="switch-knob" />
            </span>
            <span>Hidden files</span>
          </label>
        ) : null}
        <button type="button" className="btn-primary" disabled={starting || isScanning} onClick={handleStart}>
          <RescanIcon /> Rescan
        </button>
        {advanced && isScanning ? stopButton : null}
      </div>

      {isScanning ? (
        <div className="scan-progress-bar">
          <div className="scan-progress-row">
            <SpinnerIcon />
            <span style={{ fontSize: 13, fontWeight: 600 }}>{stopping ? "Stopping" : "Scanning"}</span>
            <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)" }}>
              {scan?.rootPath} · {scan?.progress.entriesScanned.toLocaleString()} files · {totalLabel}
            </span>
            <div style={{ flex: 1 }} />
            {stopButton}
          </div>
          <div className="progress-track">
            <div className="progress-fill-indeterminate" />
          </div>
        </div>
      ) : (
        <div className="status-bar">
          <span className="pill pill-accent">
            <TotalIcon /> {totalLabel} total
          </span>
          {movedToTrash > 0 ? (
            <span className="pill pill-ok" title="Moved to Trash from this scan. Empty Trash to free the space on disk.">
              <TrashIcon /> −{formatBytes(movedToTrash)} moved to Trash
            </span>
          ) : null}
          {largest ? (
            <span className="pill pill-muted">
              Largest · <b style={{ marginLeft: 5, color: "var(--fg)" }}>{largest.name}</b>
              <span style={{ marginLeft: 5, color: "var(--fg-3)" }}>{formatBytes(largest.size)}</span>
            </span>
          ) : null}
          <div style={{ flex: 1 }} />
          {advanced ? (
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginRight: 2 }}>
              <span className="stat-inline" title={`${scan?.progress.entriesScanned.toLocaleString()} items scanned`}>
                <ItemsIcon /> {scan?.progress.entriesScanned.toLocaleString()}
              </span>
              {scan && scan.progress.errors > 0 ? (
                <span className="stat-inline stat-warn" title={`${scan.progress.errors} items skipped (permissions)`}>
                  <WarnIcon /> {scan.progress.errors}
                </span>
              ) : null}
            </div>
          ) : null}
          <button type="button" className="btn-tinted" onClick={onOpenTypes}>
            <TypesIcon /> Break down by file type
          </button>
        </div>
      )}

      {advanced ? (
        <div className={`analyze-advanced-body ${folderLoading ? "folder-loading" : ""}`}>
          <div className="treemap-column">
            <div className="breadcrumb-row">
              <button type="button" className="btn-up" disabled={stack.length <= 1} onClick={goUp}>
                <UpIcon /> Up
              </button>
              <div className="breadcrumb">
                {stack.map((entry, index) => (
                  <span key={entry.path} style={{ display: "inline-flex", alignItems: "center" }}>
                    {index > 0 ? <span style={{ color: "var(--fg-3)", fontSize: 12, margin: "0 2px" }}>/</span> : null}
                    <button
                      type="button"
                      className="breadcrumb-crumb"
                      style={{ fontWeight: index === stack.length - 1 ? 700 : 500, color: index === stack.length - 1 ? "var(--fg)" : "var(--fg-3)" }}
                      onClick={() => goToCrumb(index)}
                    >
                      {index === 0 ? entry.name.split("/").filter(Boolean).pop() || entry.name : entry.name}
                    </button>
                  </span>
                ))}
              </div>
            </div>
            <div className="treemap-frame">
              <div className="treemap-frame-inner">
                <Treemap nodes={visibleChildren} refEl={treemapRef} onSelect={drill} emptyText="No scan loaded" />
              </div>
            </div>
          </div>

          <DetailPanel
            node={shownNode}
            folderItems={visibleChildren}
            maxChildSize={maxChildSize}
            errors={errors}
            totalErrors={scan?.progress.errors || 0}
            reclaimTotalLabel={reclaimTotalLabel}
            suggestCount={suggestCount}
            onDrill={drill}
            onTrash={trashItem}
            onGoCleanup={onGoCleanup}
          />
        </div>
      ) : (
        <SimpleView
          node={shownNode}
          folderItems={visibleChildren}
          reclaimTotalLabel={reclaimTotalLabel}
          suggestCount={suggestCount}
          onGoCleanup={onGoCleanup}
          stack={stack}
          folderLoading={folderLoading}
          onDrill={drill}
          onTrash={trashItem}
          onGoUp={goUp}
          onGoToCrumb={goToCrumb}
        />
      )}

      {trashToast ? (
        <div className="trash-toast">
          <TrashIcon />
          {trashToast.committed ? (
            <span className="trash-toast-text">
              Freed <b>{formatBytes(trashToast.size)}</b> · empty Trash to reclaim it on disk
            </span>
          ) : (
            <>
              <span className="trash-toast-text">
                Moved <b>{trashToast.name}</b> to Trash · {formatBytes(trashToast.size)}
              </span>
              <button type="button" className="trash-toast-undo" onClick={undoTrash}>
                Undo
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function DetailPanel({
  node,
  folderItems,
  maxChildSize,
  errors,
  totalErrors,
  reclaimTotalLabel,
  suggestCount,
  onDrill,
  onTrash,
  onGoCleanup
}: {
  node: ScanNode | null;
  folderItems: ScanNode[];
  maxChildSize: number;
  errors: ScanError[];
  totalErrors: number;
  reclaimTotalLabel: string;
  suggestCount: number;
  onDrill: (node: ScanNode) => void;
  onTrash: (node: ScanNode) => void;
  onGoCleanup: () => void;
}) {
  const rows = folderItems.slice(0, 12);
  return (
    <div className="detail-panel">
      <div className="detail-panel-header">
        <div className="field-label">Selected</div>
        <div style={{ fontSize: 17, fontWeight: 700 }}>{node?.name || "—"}</div>
        <div className="mono" style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 2 }}>
          {node?.path}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button type="button" className="btn-secondary" style={{ flex: 1 }} onClick={() => node && api.openInFolder(node.path)}>
            <RevealIcon /> Reveal
          </button>
          <button
            type="button"
            className="btn-secondary"
            style={{ flex: 1 }}
            onClick={() => node && navigator.clipboard.writeText(node.path)}
          >
            <CopyIcon /> Copy path
          </button>
        </div>
      </div>
      <div className="detail-panel-stats">
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: "var(--fg-3)", marginBottom: 3 }}>Size</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{formatBytes(node?.size || 0)}</div>
        </div>
        <div style={{ flex: 1, borderLeft: "1px solid var(--border-2)", paddingLeft: 14 }}>
          <div style={{ fontSize: 11, color: "var(--fg-3)", marginBottom: 3 }}>Items</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{node?.totalChildren || 0}</div>
        </div>
      </div>
      {suggestCount > 0 ? (
        <div className="detail-panel-cta">
          <button type="button" className="cleanup-cta" onClick={onGoCleanup}>
            <span className="cleanup-cta-icon">
              <CleanupSparkIcon />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Free up {reclaimTotalLabel}</div>
              <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginTop: 1 }}>{suggestCount} files suggested for cleanup</div>
            </div>
            <ChevronRightIcon color="#2f9e6b" />
          </button>
        </div>
      ) : null}
      <div className="detail-panel-contents">
        <div className="detail-panel-contents-head">
          <span style={{ fontSize: 13, fontWeight: 700 }}>Contents</span>
        </div>
        {rows.map((row, index) => (
          <div key={row.path} className="content-row" onClick={() => onDrill(row)}>
            <span className="content-dot" style={{ background: paletteColor(index) }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                <span className="content-name">{row.name}</span>
                <span className="mono content-size">{formatBytes(row.size)}</span>
              </div>
              <div className="content-bar-track">
                <div className="content-bar-fill" style={{ width: `${((row.size || 0) / maxChildSize) * 100}%`, background: paletteColor(index) }} />
              </div>
            </div>
            <button
              type="button"
              className="row-trash-btn row-trash-btn-sm"
              title={`Move ${row.name} to Trash`}
              onClick={(event) => {
                event.stopPropagation();
                onTrash(row);
              }}
            >
              <TrashIcon />
            </button>
            <span style={{ color: row.kind === "directory" ? "var(--fg-3)" : "transparent" }}>
              <ChevronRightIcon color="currentColor" />
            </span>
          </div>
        ))}
      </div>
      {errors.length > 0 ? (
        <div className="detail-panel-skipped">
          <div className="detail-panel-skipped-head">
            <span style={{ fontSize: 13, fontWeight: 700 }}>Skipped · permissions</span>
            <span className="pill pill-warn">{totalErrors}</span>
          </div>
          {errors.slice(-3).map((error) => (
            <div key={`${error.path}-${error.code}`} className="skipped-row">
              <span className="pill pill-warn skipped-code">{error.code}</span>
              <span className="mono skipped-path">{error.path}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SimpleView({
  node,
  folderItems,
  reclaimTotalLabel,
  suggestCount,
  onGoCleanup,
  stack,
  folderLoading,
  onDrill,
  onTrash,
  onGoUp,
  onGoToCrumb
}: {
  node: ScanNode | null;
  folderItems: ScanNode[];
  reclaimTotalLabel: string;
  suggestCount: number;
  onGoCleanup: () => void;
  stack: StackEntry[];
  folderLoading: boolean;
  onDrill: (node: ScanNode) => void;
  onTrash: (node: ScanNode) => void;
  onGoUp: () => void;
  onGoToCrumb: (index: number) => void;
}) {
  const top = folderItems.slice(0, 8);
  const max = top.length ? Math.max(...top.map((item) => item.size || 0), 1) : 1;
  const biggest = top[0];

  return (
    <div className={`simple-view ${folderLoading ? "folder-loading" : ""}`}>
      <div className="simple-view-inner">
        {stack.length > 1 ? (
          <div className="breadcrumb-row" style={{ padding: 0 }}>
            <button type="button" className="btn-up" onClick={onGoUp}>
              <UpIcon /> Up
            </button>
            <div className="breadcrumb">
              {stack.map((entry, index) => (
                <span key={entry.path} style={{ display: "inline-flex", alignItems: "center" }}>
                  {index > 0 ? <span style={{ color: "var(--fg-3)", fontSize: 12, margin: "0 2px" }}>/</span> : null}
                  <button
                    type="button"
                    className="breadcrumb-crumb"
                    style={{ fontWeight: index === stack.length - 1 ? 700 : 500, color: index === stack.length - 1 ? "var(--fg)" : "var(--fg-3)" }}
                    onClick={() => onGoToCrumb(index)}
                  >
                    {index === 0 ? entry.name.split("/").filter(Boolean).pop() || entry.name : entry.name}
                  </button>
                </span>
              ))}
            </div>
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 16 }}>
          <div className="card">
            <div style={{ fontSize: 12.5, color: "var(--fg-2)" }}>This folder</div>
            <div style={{ fontSize: 34, fontWeight: 700, marginTop: 3 }}>
              {formatBytes(node?.size || 0)
                .split(" ")
                .map((part, i) => (i === 0 ? part : <span key={i} style={{ fontSize: 18, color: "var(--fg-2)" }}> {part}</span>))}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--fg-3)", marginTop: 4 }}>
              {node?.totalChildren || 0} items{biggest ? (
                <>
                  {" "}
                  · biggest is <b style={{ color: "var(--fg-2)" }}>{biggest.name}</b>
                </>
              ) : null}
            </div>
            <div className="simple-bar-track">
              {top.slice(0, 6).map((item, index) => (
                <div key={item.path} style={{ width: `${((item.size || 0) / (node?.size || 1)) * 100}%`, background: paletteColor(index), height: "100%" }} />
              ))}
            </div>
          </div>
          {suggestCount > 0 ? (
            <button type="button" className="cleanup-card" onClick={onGoCleanup}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="cleanup-cta-icon">
                  <CleanupSparkIcon />
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#2f9e6b" }}>Cleanup</span>
              </div>
              <div style={{ fontSize: 26, fontWeight: 700, marginTop: 12 }}>Free up {reclaimTotalLabel}</div>
              <div style={{ fontSize: 12.5, color: "var(--fg-2)", marginTop: 3 }}>{suggestCount} files can go to Trash →</div>
            </button>
          ) : null}
        </div>

        <div className="card" style={{ overflow: "hidden", padding: 0 }}>
          <div style={{ padding: "15px 20px", borderBottom: "1px solid var(--border-2)", fontSize: 14, fontWeight: 700 }}>
            What&rsquo;s taking the most space
          </div>
          {top.map((item, index) => {
            const clickable = item.kind === "directory";
            return (
              <div
                key={item.path}
                className={`simple-list-row ${clickable ? "clickable" : ""}`}
                onClick={clickable ? () => onDrill(item) : undefined}
                title={clickable ? `${item.name} — click to open` : item.name}
              >
                <span className="simple-list-dot" style={{ background: paletteColor(index) }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{item.name}</span>
                    <span className="mono" style={{ fontSize: 13.5, fontWeight: 700 }}>
                      {formatBytes(item.size)}
                    </span>
                  </div>
                  <div className="content-bar-track" style={{ height: 6, marginTop: 7 }}>
                    <div className="content-bar-fill" style={{ width: `${((item.size || 0) / max) * 100}%`, background: paletteColor(index) }} />
                  </div>
                </div>
                <button
                  type="button"
                  className="row-trash-btn"
                  title={`Move ${item.name} to Trash`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onTrash(item);
                  }}
                >
                  <TrashIcon />
                </button>
                <span style={{ color: clickable ? "var(--fg-3)" : "transparent", flex: "0 0 auto", display: "inline-flex" }}>
                  <ChevronRightIcon color="currentColor" />
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  rootPathInput,
  onRootPathChange,
  onStart,
  starting,
  picking,
  onBrowse,
  roots
}: {
  rootPathInput: string;
  onRootPathChange: (value: string) => void;
  onStart: () => void;
  starting: boolean;
  picking: boolean;
  onBrowse: () => void;
  roots: RootChoice[];
}) {
  return (
    <div className="empty-state-wrap">
      <div className="empty-state-card">
        <div className="empty-state-icon">
          <FolderIcon size={32} />
        </div>
        <div style={{ fontSize: 20, fontWeight: 700 }}>Scan a folder to get started</div>
        <div style={{ fontSize: 14, color: "var(--fg-2)", marginTop: 8, lineHeight: 1.5 }}>
          Pick any folder or drive and Bytescape maps every file so you can find what&rsquo;s eating your space.
        </div>
        <div className="empty-state-form">
          <div className="path-input path-input-with-browse">
            <FolderIcon />
            <input
              className="mono"
              value={rootPathInput}
              placeholder="Choose a folder…"
              onChange={(event) => onRootPathChange(event.target.value)}
            />
            <button type="button" className="browse-btn" disabled={picking} onClick={onBrowse}>
              Browse…
            </button>
          </div>
          <button type="button" className="btn-primary" disabled={starting} onClick={onStart}>
            Start scan
          </button>
        </div>
      </div>
      {roots.length ? (
        <div style={{ marginTop: 20 }}>
          <div className="field-label">Recent</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
            {roots.map((root) => (
              <button type="button" key={root.path} className="btn-chip" onClick={() => onRootPathChange(root.path)}>
                <ScansDotIcon /> <span className="mono">{root.path}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FolderIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function RescanIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
      <path d="M4 12a8 8 0 1 1 2.3 5.6" />
      <polyline points="4 20 4 14 10 14" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth={2.6} className="spin">
      <path d="M21 12a9 9 0 1 1-6.2-8.5" strokeLinecap="round" />
    </svg>
  );
}

function TotalIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
      <path d="M6 3v18M6 8h12l-3-2.5M18 16H6" />
    </svg>
  );
}

function ItemsIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--fg-3)" strokeWidth={1.9}>
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <polyline points="13 2 13 9 20 9" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}>
      <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <line x1={12} y1={9} x2={12} y2={13.5} />
      <circle cx={12} cy={17} r={0.6} fill="currentColor" />
    </svg>
  );
}

function TypesIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
      <path d="M3 3v18h18" />
      <rect x={7} y={12} width={3} height={6} rx={1} />
      <rect x={12} y={8} width={3} height={10} rx={1} />
      <rect x={17} y={5} width={3} height={13} rx={1} />
    </svg>
  );
}

function UpIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function RevealIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <rect x={9} y={9} width={11} height={11} rx={2} />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

function CleanupSparkIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M12 3l1.6 4L18 8.6l-4.4 1.6L12 15l-1.6-4.8L6 8.6 10.4 7z" />
    </svg>
  );
}

function ChevronRightIcon({ color }: { color: string }) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2}>
      <polyline points="9 6 15 12 9 18" />
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

function ScansDotIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx={12} cy={12} r={9} />
      <polyline points="12 7 12 12 15.5 14" />
    </svg>
  );
}

