import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const statusLabels = {
  running: "Scanning",
  complete: "Finished",
  cancelled: "Cancelled",
  failed: "Failed"
};

const TREE_CHILD_RENDER_LIMIT = 20;
const FILE_GROUP_PAGE_SIZE = 50;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  const digits = value >= 100 || exp === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[exp]}`;
}

async function api(path, options) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function sameScan(a, b) {
  return a && b && a.id === b.id;
}

function normalizeExtension(value) {
  return String(value || "").trim().toLowerCase().replace(/^\./, "");
}

function upsertScan(scans, scan) {
  const existing = scans.findIndex((item) => item.id === scan.id);
  const next = existing >= 0
    ? scans.map((item) => (item.id === scan.id ? scan : item))
    : [scan, ...scans];
  return next.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

function buildTreemap(nodes, x, y, width, height, output = []) {
  const visible = nodes.filter((node) => node.size > 0);
  if (!visible.length || width < 2 || height < 2) return output;
  if (visible.length === 1) {
    output.push({ node: visible[0], x, y, width, height });
    return output;
  }

  const total = visible.reduce((sum, node) => sum + node.size, 0);
  let running = 0;
  let split = 1;
  for (let index = 0; index < visible.length; index += 1) {
    if (running + visible[index].size > total / 2 && index > 0) break;
    running += visible[index].size;
    split = index + 1;
  }
  split = Math.max(1, Math.min(visible.length - 1, split));
  const left = visible.slice(0, split);
  const right = visible.slice(split);
  const leftSize = left.reduce((sum, node) => sum + node.size, 0);
  const ratio = leftSize / total;

  if (width >= height) {
    const leftWidth = Math.max(1, Math.round(width * ratio));
    buildTreemap(left, x, y, leftWidth, height, output);
    buildTreemap(right, x + leftWidth, y, width - leftWidth, height, output);
  } else {
    const topHeight = Math.max(1, Math.round(height * ratio));
    buildTreemap(left, x, y, width, topHeight, output);
    buildTreemap(right, x, y + topHeight, width, height - topHeight, output);
  }
  return output;
}

function colorFor(name, index) {
  const colors = ["#236c8f", "#a43d4b", "#2f7651", "#94692f", "#61519b", "#22746b", "#9a4c76", "#4f6f31", "#b14d2d", "#3e668a"];
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return colors[(hash + index) % colors.length];
}

function App() {
  const [roots, setRoots] = useState([]);
  const [storagePath, setStoragePath] = useState("");
  const [scans, setScans] = useState([]);
  const [tab, setTab] = useState("analyze");
  const [rootPath, setRootPath] = useState("~");
  const [includeHidden, setIncludeHidden] = useState(true);
  const [depth, setDepth] = useState(20);
  const [folderScanDepth, setFolderScanDepth] = useState(20);
  const [scanHistory, setScanHistory] = useState([]);
  const [currentScan, setCurrentScan] = useState(null);
  const [currentNode, setCurrentNode] = useState(null);
  const [childrenByPath, setChildrenByPath] = useState(new Map());
  const [expanded, setExpanded] = useState(new Set());
  const [errors, setErrors] = useState([]);
  const [logs, setLogs] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [fileTypeFilter, setFileTypeFilter] = useState("all");
  const [fileExtensionQuery, setFileExtensionQuery] = useState("");
  const [fileGroups, setFileGroups] = useState([]);
  const [fileTypes, setFileTypes] = useState([]);
  const [fileGroupFiles, setFileGroupFiles] = useState(new Map());
  const [fileBrowserLoading, setFileBrowserLoading] = useState(false);
  const [fileBrowserError, setFileBrowserError] = useState("");
  const [fileBrowserUpdatedAt, setFileBrowserUpdatedAt] = useState("");
  const [expandedFileGroups, setExpandedFileGroups] = useState(new Set());
  const [fileBrowserRefresh, setFileBrowserRefresh] = useState(0);
  const [modalFolder, setModalFolder] = useState(null);
  const [modalFolderHistory, setModalFolderHistory] = useState([]);
  const [modalFolderLoading, setModalFolderLoading] = useState(false);
  const [modalFolderError, setModalFolderError] = useState("");
  const [statusText, setStatusText] = useState("Choose a folder to scan.");
  const [zoom, setZoom] = useState(1);
  const [sidePanelWidth, setSidePanelWidth] = useState(390);
  const [isResizingSidePanel, setIsResizingSidePanel] = useState(false);
  const mainGridRef = useRef(null);
  const treemapRef = useRef(null);
  const logEndRef = useRef(null);
  const refreshTimer = useRef(null);

  const loadScans = useCallback(async () => {
    const payload = await api("/api/scans");
    setScans(payload.scans || []);
  }, []);

  useEffect(() => {
    api("/api/roots").then((payload) => {
      setRoots(payload.roots || []);
      setStoragePath(payload.scanStoragePath || "");
      const home = payload.roots?.find((item) => item.label === "Home");
      if (home) setRootPath(home.path);
    }).catch((error) => setStatusText(error.message));
    loadScans().catch((error) => setStatusText(error.message));
  }, [loadScans]);

  const fetchFolder = useCallback(async (scanId, folderPath, options = {}) => {
    const query = folderPath ? `?path=${encodeURIComponent(folderPath)}` : "";
    const payload = await api(`/api/scans/${scanId}/children${query}`);
    const shouldSelect = options.select !== false;
    setCurrentScan(payload.scan);
    setScans((items) => upsertScan(items, payload.scan));
    if (shouldSelect) setCurrentNode(payload.node);
    setErrors(payload.errors || []);
    setChildrenByPath((previous) => {
      const next = new Map(previous);
      if (payload.node) next.set(payload.node.path, payload.children || []);
      return next;
    });
    return payload;
  }, []);

  const scheduleRefresh = useCallback((scan) => {
    if (!scan || scan.status !== "running") return;
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      fetchFolder(scan.id, currentNode?.path || scan.rootPath).catch((error) => setStatusText(error.message));
    }, 250);
  }, [currentNode, fetchFolder]);

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${window.location.host}/ws`);
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === "hello") setScans(payload.scans || []);
      if (payload.type === "scan:update") {
        setScans((items) => upsertScan(items, payload.scan));
        if (sameScan(payload.scan, currentScan)) {
          setCurrentScan(payload.scan);
          scheduleRefresh(payload.scan);
        }
      }
      if (payload.type === "scan:log") {
        setLogs((items) => [...items.slice(-799), payload.log]);
      }
    });
    return () => socket.close();
  }, [currentScan, scheduleRefresh]);

  useEffect(() => {
    if (tab === "logs") logEndRef.current?.scrollIntoView({ block: "end" });
  }, [logs, tab]);

  useEffect(() => {
    if (!isResizingSidePanel) return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const resizeFromPointer = (event) => {
      const rect = mainGridRef.current?.getBoundingClientRect();
      if (!rect) return;
      const maxWidth = Math.min(720, Math.max(340, rect.width - 380));
      const nextWidth = Math.round(rect.right - event.clientX - 12);
      setSidePanelWidth(Math.max(340, Math.min(maxWidth, nextWidth)));
    };

    const stopResize = () => setIsResizingSidePanel(false);
    window.addEventListener("pointermove", resizeFromPointer);
    window.addEventListener("pointerup", stopResize, { once: true });
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", resizeFromPointer);
      window.removeEventListener("pointerup", stopResize);
    };
  }, [isResizingSidePanel]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!currentScan || !query) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api(`/api/scans/${currentScan.id}/search?q=${encodeURIComponent(query)}&limit=80`)
        .then((payload) => {
          setSearchResults(payload.results || []);
          setScans((items) => upsertScan(items, payload.scan));
        })
        .catch((error) => setStatusText(error.message));
    }, 180);
    return () => clearTimeout(timer);
  }, [currentScan, searchQuery]);

  useEffect(() => {
    if (!fileBrowserOpen || !currentScan) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setFileBrowserLoading(true);
      setFileBrowserError("");
      const params = new URLSearchParams({
        type: fileTypeFilter,
        q: fileExtensionQuery,
        limit: "240",
        includeFiles: "false"
      });
      api(`/api/scans/${currentScan.id}/files?${params.toString()}`)
        .then((payload) => {
          if (cancelled) return;
          const groups = payload.groups || [];
          const valid = new Set(groups.map((group) => group.key));
          setFileGroups(groups);
          setFileTypes(payload.types || []);
          setFileBrowserUpdatedAt(payload.generatedAt || "");
          setScans((items) => upsertScan(items, payload.scan));
          setExpandedFileGroups((previous) => new Set(Array.from(previous).filter((key) => valid.has(key))));
          setFileGroupFiles((previous) => new Map(Array.from(previous.entries()).filter(([key]) => valid.has(key))));
          const extension = normalizeExtension(fileExtensionQuery);
          const exactMatch = extension ? groups.find((group) => group.extension === extension) : null;
          const targetGroup = exactMatch || (extension && groups.length === 1 ? groups[0] : null);
          if (targetGroup) {
            setExpandedFileGroups(new Set([targetGroup.key]));
            loadFileGroup(targetGroup, 0);
          }
        })
        .catch((error) => {
          if (!cancelled) setFileBrowserError(error.message);
        })
        .finally(() => {
          if (!cancelled) setFileBrowserLoading(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fileBrowserOpen, currentScan?.id, fileTypeFilter, fileExtensionQuery, fileBrowserRefresh]);

  const startScanForPath = async (scanPath, scanDepth = depth, options = {}) => {
    const trimmedPath = scanPath?.trim() || "~";
    const previousScan = currentScan;
    if (options.preserveCurrent && previousScan) {
      setScanHistory((items) => [previousScan, ...items.filter((item) => item.id !== previousScan.id)].slice(0, 12));
    }
    setStatusText(`Starting scan: ${trimmedPath}`);
    setChildrenByPath(new Map());
    setExpanded(new Set());
    setCurrentNode(null);
    setErrors([]);
    setLogs([]);
    setSearchQuery("");
    setSearchResults([]);
    setFileBrowserOpen(false);
    setExpandedFileGroups(new Set());
    setFileGroupFiles(new Map());
    setModalFolder(null);
    setModalFolderHistory([]);
    setModalFolderError("");
    const payload = await api("/api/scans", {
      method: "POST",
      body: JSON.stringify({ rootPath: trimmedPath, maxDepth: scanDepth, includeHidden })
    });
    setCurrentScan(payload.scan);
    setScans((items) => upsertScan(items, payload.scan));
    setExpanded(new Set([payload.scan.rootPath]));
    await fetchFolder(payload.scan.id, payload.scan.rootPath);
    setStatusText("Scanning...");
  };

  const startScan = async (event) => {
    event.preventDefault();
    await startScanForPath(rootPath);
  };

  const deepScanCurrentFolder = async () => {
    if (!currentNode || currentNode.kind !== "directory") return;
    setRootPath(currentNode.path);
    await startScanForPath(currentNode.path, folderScanDepth, { preserveCurrent: true });
  };

  const rescanCurrentRoot = async () => {
    if (!currentScan) return;
    setRootPath(currentScan.rootPath);
    await startScanForPath(currentScan.rootPath, depth, { preserveCurrent: true });
  };

  const loadScan = async (scan) => {
    setTab("analyze");
    setCurrentScan(scan);
    setChildrenByPath(new Map());
    setExpanded(new Set([scan.rootPath]));
    setSearchQuery("");
    setSearchResults([]);
    await fetchFolder(scan.id, scan.rootPath);
  };

  useEffect(() => {
    if (currentScan || currentNode || !scans.length) return;
    const latestScan = scans[0];
    setExpanded(new Set([latestScan.rootPath]));
    fetchFolder(latestScan.id, latestScan.rootPath).catch((error) => setStatusText(error.message));
  }, [currentScan, currentNode, fetchFolder, scans]);

  const returnToPreviousScan = async () => {
    const [previous, ...rest] = scanHistory;
    if (!previous) return;
    setScanHistory(rest);
    await loadScan(previous);
  };

  const cancelScan = async () => {
    if (!currentScan || currentScan.status !== "running") return;
    const payload = await api(`/api/scans/${currentScan.id}/cancel`, { method: "POST" });
    setCurrentScan(payload.scan);
    setScans((items) => upsertScan(items, payload.scan));
  };

  const selectNode = async (node) => {
    if (!currentScan) return;
    setCurrentNode(node);
    if (node.kind === "directory") {
      setExpanded((prev) => new Set(prev).add(node.path));
      await fetchFolder(currentScan.id, node.path);
    }
  };

  const inspectNode = async (node) => {
    if (!currentScan) return;
    setCurrentNode(node);
    if (node.kind === "directory" && !childrenByPath.has(node.path)) {
      await fetchFolder(currentScan.id, node.path, { select: false });
    }
  };

  const openSearchResult = async (node) => {
    await selectNode(node);
    setSearchQuery("");
    setSearchResults([]);
  };

  const toggleFolder = async (node) => {
    if (!currentScan || node.kind !== "directory") return;
    const next = new Set(expanded);
    if (next.has(node.path)) next.delete(node.path);
    else {
      next.add(node.path);
      if (!childrenByPath.has(node.path)) await fetchFolder(currentScan.id, node.path, { select: false });
    }
    setExpanded(next);
  };

  const copyPath = async (value) => {
    await navigator.clipboard.writeText(value);
    setStatusText("Path copied.");
  };

  const openInFolder = async (value) => {
    if (!value) return;
    await api("/api/open-in-folder", {
      method: "POST",
      body: JSON.stringify({ path: value })
    });
    setStatusText("Opened in file manager.");
  };

  const copyTopFiles = async (options = {}) => {
    if (!currentScan) return;
    const params = new URLSearchParams({
      limit: "10"
    });
    if (options.group?.key) params.set("key", options.group.key);
    else {
      params.set("type", fileTypeFilter);
      params.set("q", fileExtensionQuery);
    }
    const payload = await api(`/api/scans/${currentScan.id}/files/top?${params.toString()}`);
    const title = options.group?.label
      ? `Top ${payload.files.length} ${options.group.label} files by size`
      : `Top ${payload.files.length} files by size`;
    const lines = [
      title,
      ...payload.files.map((file, index) => `${index + 1}. ${file.name} | ${formatBytes(file.size || 0)} | ${file.path}`)
    ];
    await navigator.clipboard.writeText(lines.join("\n"));
    setStatusText(`Copied ${payload.files.length} files.`);
  };

  const loadFileGroup = async (group, offset = 0) => {
    if (!currentScan || !group?.key) return;
    setFileGroupFiles((previous) => {
      const next = new Map(previous);
      const current = next.get(group.key) || { files: [], nextOffset: 0, totalCount: group.count || 0 };
      next.set(group.key, { ...current, loading: true, error: "" });
      return next;
    });
    try {
      const params = new URLSearchParams({
        key: group.key,
        offset: String(offset),
        limit: String(FILE_GROUP_PAGE_SIZE)
      });
      const payload = await api(`/api/scans/${currentScan.id}/files/group?${params.toString()}`);
      setScans((items) => upsertScan(items, payload.scan));
      setFileGroupFiles((previous) => {
        const next = new Map(previous);
        const current = next.get(group.key) || { files: [] };
        next.set(group.key, {
          files: offset > 0 ? [...(current.files || []), ...(payload.files || [])] : (payload.files || []),
          nextOffset: payload.nextOffset,
          totalCount: payload.totalCount,
          totalSize: payload.totalSize,
          loading: false,
          error: ""
        });
        return next;
      });
    } catch (error) {
      setFileGroupFiles((previous) => {
        const next = new Map(previous);
        const current = next.get(group.key) || { files: [] };
        next.set(group.key, { ...current, loading: false, error: error.message });
        return next;
      });
    }
  };

  const toggleFileGroup = (group) => {
    const willOpen = !expandedFileGroups.has(group.key);
    setExpandedFileGroups((previous) => {
      const next = new Set(previous);
      if (next.has(group.key)) next.delete(group.key);
      else next.add(group.key);
      return next;
    });
    if (willOpen && !fileGroupFiles.has(group.key)) {
      loadFileGroup(group, 0);
    }
  };

  const loadModalFolder = async (folderPath, options = {}) => {
    if (!currentScan || !folderPath) return;
    if (options.pushHistory !== false) {
      setModalFolderHistory((items) => [...items, modalFolder]);
    }
    setModalFolderLoading(true);
    setModalFolderError("");
    try {
      const query = `?path=${encodeURIComponent(folderPath)}`;
      const payload = await api(`/api/scans/${currentScan.id}/children${query}`);
      setScans((items) => upsertScan(items, payload.scan));
      setModalFolder({
        node: payload.node,
        children: payload.children || [],
        errors: payload.errors || []
      });
    } catch (error) {
      setModalFolderError(error.message);
    } finally {
      setModalFolderLoading(false);
    }
  };

  const backModalFolder = () => {
    setModalFolderHistory((items) => {
      const previous = items[items.length - 1] || null;
      setModalFolder(previous);
      setModalFolderError("");
      return items.slice(0, -1);
    });
  };

  const openFileFolder = async (file) => {
    if (!currentScan || !file?.directory) return;
    await loadModalFolder(file.directory);
  };

  const currentChildren = currentNode ? childrenByPath.get(currentNode.path) || [] : [];
  const biggestFolder = currentChildren.find((item) => item.kind === "directory");
  const scanState = currentScan ? statusLabels[currentScan.status] || currentScan.status : "Idle";
  const isRunning = currentScan?.status === "running";

  const copyTreeTopItems = async () => {
    if (!currentNode || !currentChildren.length) return;
    const topItems = currentChildren
      .slice()
      .sort((a, b) => {
        if ((b.size || 0) !== (a.size || 0)) return (b.size || 0) - (a.size || 0);
        return a.path.localeCompare(b.path);
      })
      .slice(0, 10);
    const lines = [
      `Top ${topItems.length} items in ${currentNode.path}`,
      ...topItems.map((node, index) => `${index + 1}. ${node.name} | ${formatBytes(node.size || 0)} | ${node.path}`)
    ];
    await navigator.clipboard.writeText(lines.join("\n"));
    setStatusText(`Copied ${topItems.length} tree items.`);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Disk Space Visualizer</h1>
          <p>{statusText}</p>
        </div>
        <form className="scan-form" onSubmit={startScan}>
          <label className="path-field">
            <span>Folder</span>
            <input value={rootPath} onChange={(event) => setRootPath(event.target.value)} />
          </label>
          <label className="small-field">
            <span>Depth</span>
            <input type="number" min="1" max="64" value={depth} onChange={(event) => setDepth(event.target.value)} />
          </label>
          <label className="toggle-field">
            <input type="checkbox" checked={includeHidden} onChange={(event) => setIncludeHidden(event.target.checked)} />
            <span>Hidden</span>
          </label>
          <button type="submit" className="primary-action">Start Scan</button>
          <button type="button" className="secondary-action" onClick={cancelScan} disabled={!isRunning}>Stop</button>
        </form>
      </header>

      <nav className="tabs">
        <button className={tab === "analyze" ? "active" : ""} onClick={() => setTab("analyze")}>Analyze</button>
        <button className={tab === "scans" ? "active" : ""} onClick={() => setTab("scans")}>Scans</button>
        <button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}>Logs</button>
        <span>{storagePath}</span>
      </nav>

      {tab === "logs" ? (
        <LogTerminal logs={logs} currentScan={currentScan} endRef={logEndRef} />
      ) : tab === "scans" ? (
        <ScanList scans={scans} onLoad={loadScan} />
      ) : (
        <main ref={mainGridRef} className="main-grid" style={{ "--side-width": `${sidePanelWidth}px` }}>
          <section className="visual-panel">
            <div className="toolbar">
              <div className="toolbar-top">
                <div className="full-path" title={currentNode?.path || ""}>{currentNode?.path || "No scan loaded"}</div>
                <div className="toolbar-actions">
                  <button type="button" className="secondary-action compact" disabled={!scanHistory.length} onClick={returnToPreviousScan}>Back to Previous</button>
                  <button type="button" className="secondary-action compact" disabled={!currentScan || isRunning} onClick={rescanCurrentRoot}>Rescan Root</button>
                  <button type="button" className="secondary-action compact" disabled={!currentScan} onClick={() => setFileBrowserOpen(true)}>Files by Type</button>
                  <span className={`state-pill ${currentScan?.status || "idle"}`}>{scanState}</span>
                  <div className="zoom-controls">
                    <button type="button" disabled={zoom <= 1} onClick={() => setZoom(Math.max(1, zoom - 0.25))}>-</button>
                    <span>{Math.round(zoom * 100)}%</span>
                    <button type="button" onClick={() => setZoom(Math.min(4, zoom + 0.25))}>+</button>
                    <button type="button" disabled={zoom === 1} onClick={() => setZoom(1)}>Fit</button>
                  </div>
                </div>
              </div>
              <div className="metric-row">
                <span>Current: {formatBytes(currentNode?.size || 0)}</span>
                <span>Root: {formatBytes(currentScan?.progress?.bytesScanned || currentNode?.size || 0)}</span>
                <span>Largest folder: {biggestFolder ? `${biggestFolder.name} (${formatBytes(biggestFolder.size)})` : "-"}</span>
                <span>{currentScan?.progress?.entriesScanned?.toLocaleString() || 0} entries</span>
                <span>{currentScan?.progress?.errors?.toLocaleString() || 0} errors</span>
                <span className="readonly-badge">Read only</span>
              </div>
            </div>
            <Treemap
              nodes={currentChildren}
              zoom={zoom}
              refEl={treemapRef}
              onSelect={selectNode}
              emptyText={currentNode ? "No sizable child items" : "No scan loaded"}
            />
          </section>
          <div
            className={`panel-resizer ${isResizingSidePanel ? "dragging" : ""}`}
            role="separator"
            aria-label="Resize folders and files panel"
            aria-orientation="vertical"
            tabIndex={0}
            onPointerDown={(event) => {
              event.preventDefault();
              setIsResizingSidePanel(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") setSidePanelWidth((value) => Math.min(720, value + 20));
              if (event.key === "ArrowRight") setSidePanelWidth((value) => Math.max(340, value - 20));
            }}
          />
          <aside className="side-panel">
            <section className="detail-block">
              <div className="section-title">
                <h2>{currentNode?.name || "Selection"}</h2>
                <div className="detail-actions">
                  <button type="button" className="secondary-action compact" disabled={!currentNode} onClick={() => openInFolder(currentNode.path)}>Show in Folder</button>
                  <button type="button" className="secondary-action compact" disabled={!currentNode} onClick={() => copyPath(currentNode.path)}>Copy Path</button>
                </div>
              </div>
              <div className="folder-scan-card">
                <label>
                  <span>Folder scan depth</span>
                  <input type="number" min="1" max="64" value={folderScanDepth} onChange={(event) => setFolderScanDepth(event.target.value)} />
                </label>
                <button type="button" className="primary-action" disabled={!currentNode || currentNode.kind !== "directory"} onClick={deepScanCurrentFolder}>Scan Selected Folder</button>
              </div>
              <dl>
                <div><dt>Size</dt><dd>{formatBytes(currentNode?.size || 0)}</dd></div>
                <div><dt>Path</dt><dd className="selectable">{currentNode?.path || "-"}</dd></div>
                <div><dt>Children</dt><dd>{currentNode?.totalChildren || 0}</dd></div>
              </dl>
            </section>
            <section className="detail-block">
              <div className="section-title">
                <h2>Folders & Files</h2>
                <div className="detail-actions">
                  <button type="button" className="secondary-action compact" disabled={!currentChildren.length} onClick={copyTreeTopItems}>Copy Top 10</button>
                  <button type="button" className="secondary-action compact" disabled={!currentScan} onClick={() => setFileBrowserOpen(true)}>Open File Browser</button>
                  <button type="button" disabled={!currentNode?.parentPath} onClick={() => currentNode?.parentPath && fetchFolder(currentScan.id, currentNode.parentPath)}>Up</button>
                </div>
              </div>
              <div className="search-box">
                <input
                  value={searchQuery}
                  disabled={!currentScan}
                  placeholder="Search scanned files and folders"
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
                {searchQuery ? <button type="button" onClick={() => setSearchQuery("")}>Clear</button> : null}
              </div>
              {searchResults.length ? (
                <div className="search-results">
                  {searchResults.map((node) => (
                    <button key={node.path} type="button" onClick={() => openSearchResult(node)}>
                      <span>{node.name}</span>
                      <span>{node.path}</span>
                      <span>{formatBytes(node.size)}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <TreeList
                node={currentNode}
                childrenByPath={childrenByPath}
                expanded={expanded}
                selectedPath={currentNode?.path}
                onToggle={toggleFolder}
                onSelect={inspectNode}
                onOpen={selectNode}
                onCopy={copyPath}
                onReveal={openInFolder}
              />
            </section>
            <section className="detail-block">
              <h2>Scan Log</h2>
              <ul className="error-list">
                {errors.slice(-40).map((error) => <li key={`${error.path}-${error.code}`}>{error.code}: {error.path}</li>)}
              </ul>
            </section>
          </aside>
        </main>
      )}
      <FileBrowserModal
        open={fileBrowserOpen}
        scan={currentScan}
        groups={fileGroups}
        types={fileTypes}
        groupFiles={fileGroupFiles}
        folderView={modalFolder}
        folderHistoryCount={modalFolderHistory.length}
        folderLoading={modalFolderLoading}
        folderError={modalFolderError}
        filter={fileTypeFilter}
        extensionQuery={fileExtensionQuery}
        loading={fileBrowserLoading}
        error={fileBrowserError}
        updatedAt={fileBrowserUpdatedAt}
        expanded={expandedFileGroups}
        onClose={() => setFileBrowserOpen(false)}
        onFilterChange={(value) => {
          setFileTypeFilter(value);
          setExpandedFileGroups(new Set());
          setFileGroupFiles(new Map());
        }}
        onExtensionQueryChange={(value) => {
          setFileExtensionQuery(value);
          setExpandedFileGroups(new Set());
          setFileGroupFiles(new Map());
        }}
        onToggle={toggleFileGroup}
        onLoadMore={(group) => loadFileGroup(group, fileGroupFiles.get(group.key)?.nextOffset || 0)}
        onCopyTopFiles={copyTopFiles}
        onBackFolder={backModalFolder}
        onOpenFolderPath={(folderPath) => loadModalFolder(folderPath)}
        onCopy={copyPath}
        onReveal={openInFolder}
        onOpenFolder={openFileFolder}
        onRefresh={() => setFileBrowserRefresh((value) => value + 1)}
      />
    </div>
  );
}

function LogTerminal({ logs, currentScan, endRef }) {
  const visibleLogs = currentScan ? logs.filter((log) => log.scanId === currentScan.id) : logs;
  return (
    <main className="log-tab">
      <div className="terminal-head">
        <div>
          <h2>Live Logs</h2>
          <span>{currentScan ? currentScan.rootPath : "No active scan selected"}</span>
        </div>
        <span>{visibleLogs.length} lines</span>
      </div>
      <div className="terminal" role="log" aria-live="polite">
        {visibleLogs.length ? visibleLogs.map((log) => (
          <div key={log.id} className={`terminal-line ${log.level}`}>
            <span className="terminal-time">{new Date(log.at).toLocaleTimeString()}</span>
            <span className="terminal-level">{log.level}</span>
            <span className="terminal-message">{log.message}</span>
          </div>
        )) : (
          <div className="terminal-empty">Start a scan to stream paths here.</div>
        )}
        <div ref={endRef} />
      </div>
    </main>
  );
}

function ScanList({ scans, onLoad }) {
  return (
    <main className="scan-list">
      <div className="scan-list-head">
        <h2>Saved Scans</h2>
        <span>{scans.length} scans</span>
      </div>
      <div className="scan-table">
        {scans.map((scan) => (
          <button key={scan.id} type="button" onClick={() => onLoad(scan)} className="scan-row">
            <span className={`state-pill ${scan.status}`}>{statusLabels[scan.status] || scan.status}</span>
            <span className="scan-path">{scan.rootPath}</span>
            <span>{formatBytes(scan.progress?.bytesScanned || 0)}</span>
            <span>{scan.progress?.entriesScanned?.toLocaleString() || 0} entries</span>
            <span>{new Date(scan.startedAt).toLocaleString()}</span>
          </button>
        ))}
      </div>
    </main>
  );
}

function FileBrowserModal({
  open,
  scan,
  groups,
  types,
  groupFiles,
  folderView,
  folderHistoryCount,
  folderLoading,
  folderError,
  filter,
  extensionQuery,
  loading,
  error,
  updatedAt,
  expanded,
  onClose,
  onFilterChange,
  onExtensionQueryChange,
  onToggle,
  onLoadMore,
  onCopyTopFiles,
  onBackFolder,
  onOpenFolderPath,
  onCopy,
  onReveal,
  onOpenFolder,
  onRefresh
}) {
  if (!open) return null;
  const allType = types.find((item) => item.type === "all");
  const visibleTypes = types.length ? types : [{ type: "all", label: "All", count: 0, totalSize: 0 }];
  const searchedExtension = normalizeExtension(extensionQuery);
  const directGroup = searchedExtension
    ? groups.find((group) => group.extension === searchedExtension) || (groups.length === 1 ? groups[0] : null)
    : null;
  const directRecord = directGroup ? groupFiles.get(directGroup.key) : null;
  const directFiles = directRecord?.files || [];
  const directRemaining = Math.max(0, (directRecord?.totalCount || directGroup?.count || 0) - directFiles.length);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="files-modal" role="dialog" aria-modal="true" aria-label="Files by type">
        <header className="files-modal-head">
          <div>
            <h2>Files by Type</h2>
            <p className="selectable">{scan?.rootPath || "No scan selected"}</p>
          </div>
          <div className="files-modal-actions">
            <button type="button" className="secondary-action compact" disabled={!scan || loading} onClick={onRefresh}>Refresh</button>
            <button type="button" className="secondary-action compact" onClick={onClose}>Close</button>
          </div>
        </header>

        <div className="file-browser-summary">
          <span>{(allType?.count || 0).toLocaleString()} files</span>
          <span>{formatBytes(allType?.totalSize || 0)}</span>
          <span>{scan?.status === "running" ? "Scanning" : "Snapshot"}</span>
          <span>{updatedAt ? new Date(updatedAt).toLocaleTimeString() : "-"}</span>
          <button type="button" className="secondary-action compact" disabled={!scan} onClick={() => onCopyTopFiles()}>Copy Top 10</button>
        </div>

        <div className="type-filter-row">
          {visibleTypes.map((item) => (
            <button
              key={item.type}
              type="button"
              className={`type-chip ${filter === item.type ? "active" : ""}`}
              onClick={() => onFilterChange(item.type)}
            >
              <span>{item.label}</span>
              <small>{formatBytes(item.totalSize || 0)}</small>
            </button>
          ))}
        </div>

        <div className="extension-search-row">
          <input
            value={extensionQuery}
            placeholder="Find extension, e.g. .epub"
            onChange={(event) => onExtensionQueryChange(event.target.value)}
          />
          {extensionQuery ? <button type="button" className="secondary-action compact" onClick={() => onExtensionQueryChange("")}>Clear</button> : null}
        </div>

        <div className="file-groups">
          {error ? <div className="file-browser-empty">{error}</div> : null}
          {folderView || folderLoading || folderError ? (
            <FolderModalView
              view={folderView}
              loading={folderLoading}
              error={folderError}
              canBack={folderHistoryCount > 0 || Boolean(folderView)}
              onBack={onBackFolder}
              onOpenFolder={onOpenFolderPath}
              onCopy={onCopy}
              onReveal={onReveal}
            />
          ) : null}
          {!folderView && !folderLoading && !folderError && loading ? (
            <div className="file-browser-empty loading-state">
              <span className="loading-spinner" />
              <span>Loading extension groups...</span>
            </div>
          ) : null}
          {!folderView && !folderLoading && !folderError && !loading && !error && !groups.length ? <div className="file-browser-empty">No files found for this filter.</div> : null}
          {!folderView && !folderLoading && !folderError && !loading && !error && directGroup ? (
            <section className="extension-results">
              <div className="extension-results-head">
                <div>
                  <h2>{directGroup.label} files</h2>
                  <span>{(directRecord?.totalCount || directGroup.count || 0).toLocaleString()} files, {formatBytes(directRecord?.totalSize || directGroup.totalSize || 0)}</span>
                </div>
                <div className="extension-results-actions">
                  <button type="button" className="secondary-action compact" disabled={directRecord?.loading} onClick={() => onCopyTopFiles({ group: directGroup })}>Copy Top 10</button>
                  <button type="button" className="secondary-action compact" disabled={directRecord?.loading} onClick={() => onExtensionQueryChange("")}>Show Groups</button>
                </div>
              </div>
              <div className="file-list direct-file-list">
                {directRecord?.error ? <div className="file-list-note error-text">{directRecord.error}</div> : null}
                {(!directRecord || directRecord.loading) && !directFiles.length ? (
                  <div className="file-list-loading">
                    <span className="loading-spinner" />
                    <span>Loading {directGroup.label} files...</span>
                  </div>
                ) : null}
                {directFiles.map((file) => (
                  <FileResultRow key={file.path} file={file} onOpenFolder={onOpenFolder} onCopy={onCopy} onReveal={onReveal} />
                ))}
                {directRecord?.loading && directFiles.length ? (
                  <div className="file-list-loading compact-loading">
                    <span className="loading-spinner" />
                    <span>Loading more...</span>
                  </div>
                ) : null}
                {directRecord?.nextOffset ? (
                  <div className="file-list-more">
                    <span>{directRemaining.toLocaleString()} more files in this extension</span>
                    <button type="button" className="secondary-action compact" disabled={directRecord.loading} onClick={() => onLoadMore(directGroup)}>Load More</button>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
          {!folderView && !folderLoading && !folderError && !error && !directGroup && groups.map((group) => {
            const isOpen = expanded.has(group.key);
            const record = groupFiles.get(group.key);
            const files = record?.files || [];
            const loadedCount = files.length;
            const remaining = Math.max(0, (record?.totalCount || group.count || 0) - loadedCount);
            return (
              <section key={group.key} className={`file-group ${isOpen ? "open" : ""}`}>
                <div className="file-group-head">
                  <button type="button" className="file-group-toggle" onClick={() => onToggle(group)}>{isOpen ? "v" : ">"}</button>
                  <button type="button" className="file-group-title" onClick={() => onToggle(group)}>
                    <strong>{group.label}</strong>
                    <small>{group.typeLabel}</small>
                  </button>
                  <span>{(group.count || 0).toLocaleString()} files</span>
                  <span>{formatBytes(group.totalSize || 0)}</span>
                  <button type="button" className="secondary-action compact" onClick={() => onCopyTopFiles({ group })}>Copy Top 10</button>
                  <button type="button" className="secondary-action compact" onClick={() => onToggle(group)}>{isOpen ? "Hide" : "View Files"}</button>
                </div>
                {isOpen ? (
                  <div className="file-list">
                    {record?.error ? <div className="file-list-note error-text">{record.error}</div> : null}
                    {record?.loading && !files.length ? (
                      <div className="file-list-loading">
                        <span className="loading-spinner" />
                        <span>Loading {group.label} files...</span>
                      </div>
                    ) : null}
                    {files.map((file) => (
                      <FileResultRow key={file.path} file={file} onOpenFolder={onOpenFolder} onCopy={onCopy} onReveal={onReveal} />
                    ))}
                    {record?.loading && files.length ? (
                      <div className="file-list-loading compact-loading">
                        <span className="loading-spinner" />
                        <span>Loading more...</span>
                      </div>
                    ) : null}
                    {record?.nextOffset ? (
                      <div className="file-list-more">
                        <span>{remaining.toLocaleString()} more files in this extension</span>
                        <button type="button" className="secondary-action compact" disabled={record.loading} onClick={() => onLoadMore(group)}>Load More</button>
                      </div>
                    ) : null}
                    {!record?.loading && !files.length && !record?.error ? <div className="file-list-note">Expand loaded, no files returned.</div> : null}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function FolderModalView({ view, loading, error, canBack, onBack, onOpenFolder, onCopy, onReveal }) {
  const children = view?.children || [];
  return (
    <section className="modal-folder-view">
      <div className="modal-folder-head">
        <button type="button" className="secondary-action compact" disabled={!canBack} onClick={onBack}>Back</button>
        <div>
          <h2>{view?.node?.name || "Folder"}</h2>
          <span className="selectable">{view?.node?.path || ""}</span>
        </div>
        <div className="folder-head-actions">
          <button type="button" className="secondary-action compact" disabled={!view?.node?.path} onClick={() => onReveal(view.node.path)}>Show in Folder</button>
          <button type="button" className="secondary-action compact" disabled={!view?.node?.path} onClick={() => onCopy(view.node.path)}>Copy Path</button>
        </div>
      </div>
      {loading ? (
        <div className="file-list-loading">
          <span className="loading-spinner" />
          <span>Loading folder...</span>
        </div>
      ) : null}
      {error ? <div className="file-list-note error-text">{error}</div> : null}
      {!loading && !error && view ? (
        <>
          <div className="modal-folder-summary">
            <span>{formatBytes(view.node?.size || 0)}</span>
            <span>{children.length.toLocaleString()} scanned items</span>
          </div>
          <div className="modal-folder-list">
            {children.map((node) => (
              <div key={node.path} className="folder-content-row">
                <span className={`folder-kind ${node.kind}`}>{node.kind === "directory" ? "Dir" : "File"}</span>
                <div className="folder-content-main">
                  <strong>{node.name}</strong>
                  <span className="selectable">{node.path}</span>
                </div>
                <span className="file-size">{formatBytes(node.size || 0)}</span>
                <button type="button" className="secondary-action compact" disabled={node.kind !== "directory"} onClick={() => onOpenFolder(node.path)}>Open</button>
                <button type="button" className="secondary-action compact" onClick={() => onReveal(node.path)}>Show</button>
                <button type="button" className="secondary-action compact" onClick={() => onCopy(node.path)}>Copy</button>
              </div>
            ))}
            {!children.length ? <div className="file-list-note">No scanned children in this folder.</div> : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

function FileResultRow({ file, onOpenFolder, onCopy, onReveal }) {
  return (
    <article className="file-list-row">
      <div className="file-main">
        <strong>{file.name}</strong>
        <span className="selectable">{file.path}</span>
        <small>{file.directory}</small>
      </div>
      <span className="file-size">{formatBytes(file.size || 0)}</span>
      <button type="button" className="secondary-action compact" onClick={() => onOpenFolder(file)}>Open Folder</button>
      <button type="button" className="secondary-action compact" onClick={() => onReveal(file.path)}>Show</button>
      <button type="button" className="secondary-action compact" onClick={() => onCopy(file.path)}>Copy Path</button>
    </article>
  );
}

function Treemap({ nodes, zoom, onSelect, refEl, emptyText }) {
  const [size, setSize] = useState({ width: 1, height: 1 });
  useEffect(() => {
    if (!refEl.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(refEl.current);
    return () => observer.disconnect();
  }, [refEl]);

  const canvasWidth = Math.max(1, Math.round(size.width * zoom));
  const canvasHeight = Math.max(1, Math.round(size.height * zoom));
  const layout = useMemo(() => buildTreemap(nodes, 0, 0, canvasWidth, canvasHeight), [nodes, canvasWidth, canvasHeight]);

  return (
    <div className="treemap" ref={refEl}>
      {!nodes.length ? <div className="empty-state">{emptyText}</div> : !layout.length ? <div className="empty-state">No sizable child items</div> : (
        <div className="treemap-canvas" style={{ width: canvasWidth, height: canvasHeight }}>
          {layout.map((item, index) => (
            <button
              key={item.node.path}
              type="button"
              className="tile"
              title={`${item.node.path}\n${formatBytes(item.node.size)}`}
              onClick={() => onSelect(item.node)}
              style={{
                left: item.x,
                top: item.y,
                width: Math.max(0, item.width),
                height: Math.max(0, item.height),
                background: colorFor(item.node.name, index)
              }}
            >
              {item.width > 82 && item.height > 45 ? <span className="tile-title">{item.node.name}</span> : null}
              {item.width > 82 && item.height > 72 ? <span className="tile-size">{formatBytes(item.node.size)}</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TreeList({ node, childrenByPath, expanded, selectedPath, onToggle, onSelect, onOpen, onCopy, onReveal }) {
  if (!node) return <div className="tree-empty">No scan loaded</div>;
  return (
    <div className="folder-tree" role="tree">
      <TreeRow node={node} depth={0} expanded={expanded} selectedPath={selectedPath} onToggle={onToggle} onSelect={onSelect} onOpen={onOpen} onCopy={onCopy} onReveal={onReveal} />
      {expanded.has(node.path) ? (
        <TreeChildren node={node} depth={1} childrenByPath={childrenByPath} expanded={expanded} selectedPath={selectedPath} onToggle={onToggle} onSelect={onSelect} onOpen={onOpen} onCopy={onCopy} onReveal={onReveal} />
      ) : null}
    </div>
  );
}

function TreeChildren(props) {
  const children = props.childrenByPath.get(props.node.path) || [];
  const shouldLimit = props.depth > 1 && children.length > TREE_CHILD_RENDER_LIMIT;
  const visibleChildren = shouldLimit ? children.slice(0, TREE_CHILD_RENDER_LIMIT) : children;
  return (
    <>
      {shouldLimit ? <TreeNavigateRow node={props.node} depth={props.depth} total={children.length} onOpen={props.onOpen} /> : null}
      {visibleChildren.map((child) => (
        <React.Fragment key={child.path}>
          <TreeRow node={child} depth={props.depth} expanded={props.expanded} selectedPath={props.selectedPath} onToggle={props.onToggle} onSelect={props.onSelect} onOpen={props.onOpen} onCopy={props.onCopy} onReveal={props.onReveal} />
          {child.kind === "directory" && props.expanded.has(child.path) ? <TreeChildren {...props} node={child} depth={props.depth + 1} /> : null}
        </React.Fragment>
      ))}
      {shouldLimit ? <TreeLimitRow depth={props.depth} shown={visibleChildren.length} total={children.length} /> : null}
    </>
  );
}

function TreeNavigateRow({ node, depth, total, onOpen }) {
  return (
    <div className="tree-nav-row" style={{ "--depth": depth }}>
      <span />
      <button type="button" className="tree-nav-button" onClick={() => onOpen(node)}>Open folder to browse all {total.toLocaleString()} items</button>
    </div>
  );
}

function TreeLimitRow({ depth, shown, total }) {
  return (
    <div className="tree-limit-row" style={{ "--depth": depth }}>
      Showing first {shown.toLocaleString()} of {total.toLocaleString()} items in this expansion.
    </div>
  );
}

function TreeRow({ node, depth, expanded, selectedPath, onToggle, onSelect, onOpen, onCopy, onReveal }) {
  const isDirectory = node.kind === "directory";
  return (
    <div className={`tree-row ${selectedPath === node.path ? "selected" : ""}`} style={{ "--depth": depth }} role="treeitem">
      <button type="button" className="tree-toggle" disabled={!isDirectory} onClick={() => onToggle(node)}>{isDirectory ? (expanded.has(node.path) ? "v" : ">") : ""}</button>
      <button type="button" className="tree-main" onClick={() => onSelect(node)}>
        <span className="tree-name">{depth === 0 ? node.path : node.name}</span>
        <span className="tree-path">{node.path}</span>
      </button>
      <span className="tree-size">{formatBytes(node.size)}</span>
      <span className="tree-percent">{node.totalChildren || 0}</span>
      <button type="button" className="tree-open" disabled={!isDirectory} onClick={() => onOpen(node)}>Open</button>
      <button type="button" className="tree-copy" onClick={() => onReveal(node.path)}>Show</button>
      <button type="button" className="tree-copy" onClick={() => onCopy(node.path)}>Copy</button>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
