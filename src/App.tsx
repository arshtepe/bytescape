import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CleanupSuggestion, LogEntry, RootChoice, ScanMeta, SocketMessage, StorageSettings, TrashJob } from "../shared/types";
import * as api from "./api";
import { applyTheme, loadStoredMode, loadStoredTheme, storeMode, storeTheme, systemTheme, type Mode, type Theme } from "./theme";
import { formatBytes } from "./format";
import { TitleBar } from "./components/TitleBar";
import { Sidebar, type Screen } from "./components/Sidebar";
import { AnalyzeScreen } from "./screens/AnalyzeScreen";
import { CleanupScreen } from "./screens/CleanupScreen";
import { ScansScreen } from "./screens/ScansScreen";
import { LogsScreen } from "./screens/LogsScreen";
import { AgentsScreen } from "./screens/AgentsScreen";
import { FilesByTypeModal } from "./FilesByTypeModal";
import { StorageDialog, type StoragePrompt } from "./components/StorageDialog";

function upsertScan(scans: ScanMeta[], scan: ScanMeta): ScanMeta[] {
  const existing = scans.findIndex((item) => item.id === scan.id);
  const next = existing >= 0 ? scans.map((item) => (item.id === scan.id ? scan : item)) : [scan, ...scans];
  return next.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export function App() {
  const [theme, setTheme] = useState<Theme>(() => loadStoredTheme() ?? systemTheme());
  const [mode, setMode] = useState<Mode>(() => loadStoredMode() ?? "simple");
  const [sbCollapsed, setSbCollapsed] = useState(false);
  const [screen, setScreen] = useState<Screen>("analyze");
  const [showTypes, setShowTypes] = useState(false);

  const [roots, setRoots] = useState<RootChoice[]>([]);
  const [scans, setScans] = useState<ScanMeta[]>([]);
  const [currentScan, setCurrentScan] = useState<ScanMeta | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [statusText, setStatusText] = useState("Choose a folder to scan.");

  const [suggestions, setSuggestions] = useState<CleanupSuggestion[]>([]);
  const [hiddenSuggestionIds, setHiddenSuggestionIds] = useState<Set<string>>(new Set());
  // Latest Trash job update from the server, for the screens that started one.
  const [trashEvent, setTrashEvent] = useState<TrashJob | null>(null);

  const [storage, setStorage] = useState<StorageSettings | null>(null);
  const [storagePrompt, setStoragePrompt] = useState<StoragePrompt | null>(null);
  // Scan to start again once the user has picked a roomier location.
  const pendingScanRef = useRef<{ rootPath: string; options: { maxDepth?: number; includeHidden?: boolean } } | null>(null);
  const promptedForScanRef = useRef<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => applyTheme(theme), [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      storeTheme(next);
      return next;
    });
  }, []);

  const setModeAndStore = useCallback((next: Mode) => {
    setMode(next);
    storeMode(next);
  }, []);

  const loadScans = useCallback(async () => {
    const payload = await api.listScans();
    setScans(payload.scans);
    return payload.scans;
  }, []);

  const refreshCleanup = useCallback(async (scanId: string) => {
    try {
      const payload = await api.getCleanupSuggestions(scanId);
      setSuggestions(payload.suggestions);
      setHiddenSuggestionIds(new Set());
    } catch {
      setSuggestions([]);
    }
  }, []);

  useEffect(() => {
    api
      .getRoots()
      .then((payload) => setRoots(payload.roots))
      .catch((error: Error) => setStatusText(error.message));
    loadScans().catch((error: Error) => setStatusText(error.message));
    api.getStorage().then(setStorage).catch(() => {});
  }, [loadScans]);

  // A scan that stopped because its storage drive filled up: ask where to
  // save scan data instead (once per scan).
  useEffect(() => {
    if (!currentScan || currentScan.errorCode !== "INSUFFICIENT_SPACE") return;
    if (promptedForScanRef.current === currentScan.id) return;
    promptedForScanRef.current = currentScan.id;
    pendingScanRef.current = {
      rootPath: currentScan.rootPath,
      options: { maxDepth: currentScan.maxDepth, includeHidden: currentScan.includeHidden }
    };
    api
      .getStorage()
      .then((settings) => {
        setStorage(settings);
        setStoragePrompt({ reason: "stopped", storagePath: settings.scanRoot, freeBytes: settings.freeBytes });
      })
      .catch(() => setStoragePrompt({ reason: "stopped", storagePath: storage?.scanRoot || "" }));
  }, [currentScan?.id, currentScan?.errorCode]);

  useEffect(() => {
    if (!currentScan) {
      setSuggestions([]);
      return;
    }
    if (currentScan.status === "running") return;
    refreshCleanup(currentScan.id);
  }, [currentScan?.id, currentScan?.status, refreshCleanup]);

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${window.location.host}/ws`);
    socketRef.current = socket;
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data) as SocketMessage;
      if (payload.type === "hello") setScans(payload.scans);
      if (payload.type === "scan:update") {
        setScans((items) => upsertScan(items, payload.scan));
        setCurrentScan((current) => (current && current.id === payload.scan.id ? payload.scan : current));
      }
      if (payload.type === "scan:deleted") {
        setScans((items) => items.filter((item) => item.id !== payload.scanId));
        setCurrentScan((current) => (current && current.id === payload.scanId ? null : current));
      }
      if (payload.type === "trash:update") setTrashEvent(payload.job);
      if (payload.type === "scan:log") {
        setLogs((items) => [...items.slice(-799), payload.log]);
      }
    });
    return () => socket.close();
  }, []);

  useEffect(() => {
    if (currentScan || !scans.length) return;
    setCurrentScan(scans[0] as ScanMeta);
  }, [currentScan, scans]);

  const startScan = useCallback(
    async (rootPath: string, options: { maxDepth?: number; includeHidden?: boolean } = {}) => {
      const trimmed = rootPath.trim() || "~";
      setStatusText(`Starting scan: ${trimmed}`);
      setLogs([]);
      let payload: { scan: ScanMeta };
      try {
        payload = await api.createScan({
          rootPath: trimmed,
          maxDepth: options.maxDepth ?? 20,
          includeHidden: options.includeHidden ?? true
        });
      } catch (error) {
        if (error instanceof api.ApiError && error.payload.code === "INSUFFICIENT_SPACE") {
          pendingScanRef.current = { rootPath: trimmed, options };
          setStatusText("Not enough space for scan data.");
          setStoragePrompt({
            reason: "start",
            storagePath: String(error.payload.storagePath),
            freeBytes: Number(error.payload.freeBytes),
            requiredBytes: Number(error.payload.requiredBytes)
          });
          return null;
        }
        setStatusText((error as Error).message);
        return null;
      }
      setCurrentScan(payload.scan);
      setScans((items) => upsertScan(items, payload.scan));
      setStatusText("Scanning...");
      return payload.scan;
    },
    []
  );

  const storageChanged = useCallback(
    (settings: StorageSettings) => {
      setStorage(settings);
      setStoragePrompt(null);
      const pending = pendingScanRef.current;
      pendingScanRef.current = null;
      if (pending) void startScan(pending.rootPath, pending.options);
    },
    [startScan]
  );

  const openStorageSettings = useCallback(() => {
    pendingScanRef.current = null;
    setStoragePrompt({ reason: "manual", storagePath: storage?.scanRoot || "", freeBytes: storage?.freeBytes });
  }, [storage]);

  const cancelScan = useCallback(async () => {
    if (!currentScan || currentScan.status !== "running") return;
    try {
      const payload = await api.cancelScan(currentScan.id);
      setCurrentScan(payload.scan);
      setScans((items) => upsertScan(items, payload.scan));
    } catch (error) {
      setStatusText((error as Error).message);
      // Resync: the scan may already have ended, which is why cancel failed.
      const fresh = await api.getScan(currentScan.id).catch(() => null);
      if (fresh) setCurrentScan(fresh.scan);
      throw error;
    }
  }, [currentScan]);

  const deleteScans = useCallback(async (ids: string[]) => {
    const deleted = new Set<string>();
    for (const id of ids) {
      try {
        await api.deleteScan(id);
        deleted.add(id);
      } catch (error) {
        setStatusText((error as Error).message);
      }
    }
    setScans((items) => items.filter((item) => !deleted.has(item.id)));
    setCurrentScan((current) => (current && deleted.has(current.id) ? null : current));
  }, []);

  const loadScan = useCallback((scan: ScanMeta) => {
    setScreen("analyze");
    setCurrentScan(scan);
  }, []);

  const diskUsage = useMemo(() => {
    if (!currentScan) return null;
    return { used: currentScan.progress.bytesScanned };
  }, [currentScan]);

  const visibleSuggestions = useMemo(
    () => suggestions.filter((item) => !hiddenSuggestionIds.has(item.id)),
    [suggestions, hiddenSuggestionIds]
  );
  const reclaimTotal = useMemo(() => visibleSuggestions.reduce((sum, item) => sum + item.size, 0), [visibleSuggestions]);
  const reclaimTotalLabel = formatBytes(reclaimTotal);

  const hideSuggestions = useCallback((ids: string[]) => {
    setHiddenSuggestionIds((current) => {
      const next = new Set(current);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);

  const unhideSuggestions = useCallback((ids: string[]) => {
    setHiddenSuggestionIds((current) => {
      const next = new Set(current);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  return (
    <div className="app-shell">
      <TitleBar mode={mode} onSetMode={setModeAndStore} theme={theme} onToggleTheme={toggleTheme} />
      <div className="app-body">
        <Sidebar
          collapsed={sbCollapsed}
          onToggleCollapsed={() => setSbCollapsed((value) => !value)}
          screen={screen}
          onSetScreen={setScreen}
          reclaimTotalLabel={visibleSuggestions.length ? reclaimTotalLabel : null}
          diskUsage={diskUsage}
        />
        <main className="app-main">
          {screen === "analyze" ? (
            <AnalyzeScreen
              key={currentScan?.id || "empty"}
              mode={mode}
              scan={currentScan}
              roots={roots}
              statusText={statusText}
              reclaimTotalLabel={reclaimTotalLabel}
              suggestCount={visibleSuggestions.length}
              onStartScan={startScan}
              onCancelScan={cancelScan}
              onGoCleanup={() => setScreen("cleanup")}
              onOpenTypes={() => setShowTypes(true)}
              trashEvent={trashEvent}
            />
          ) : screen === "cleanup" ? (
            <CleanupScreen
              scan={currentScan}
              suggestions={visibleSuggestions}
              reclaimTotalLabel={reclaimTotalLabel}
              onHide={hideSuggestions}
              onUnhide={unhideSuggestions}
              trashEvent={trashEvent}
            />
          ) : screen === "scans" ? (
            <ScansScreen
              scans={scans}
              storage={storage}
              onOpen={loadScan}
              onDelete={deleteScans}
              onChangeStorage={openStorageSettings}
              onNewScan={() => setScreen("analyze")}
            />
          ) : screen === "logs" ? (
            <LogsScreen logs={logs} scan={currentScan} />
          ) : (
            <AgentsScreen />
          )}
        </main>
      </div>
      <FilesByTypeModal open={showTypes} scan={currentScan} onClose={() => setShowTypes(false)} />
      {storagePrompt ? (
        <StorageDialog
          prompt={storagePrompt}
          onClose={() => {
            pendingScanRef.current = null;
            setStoragePrompt(null);
          }}
          onChanged={storageChanged}
        />
      ) : null}
    </div>
  );
}
