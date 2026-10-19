import type { CSSProperties } from "react";
import { formatBytes } from "../format";

export type Screen = "analyze" | "cleanup" | "scans" | "logs" | "agents";

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  screen: Screen;
  onSetScreen: (screen: Screen) => void;
  reclaimTotalLabel: string | null;
  diskUsage: { used: number } | null;
}

function navStyle(active: boolean, collapsed: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: collapsed ? 0 : 11,
    height: 38,
    padding: collapsed ? 0 : "0 12px",
    justifyContent: collapsed ? "center" : "flex-start",
    borderRadius: 10,
    border: "none",
    cursor: "pointer",
    width: "100%",
    textAlign: "left",
    fontSize: 13.5,
    fontWeight: active ? 700 : 500,
    background: active ? "var(--accent-soft)" : "transparent",
    color: active ? "var(--accent)" : "var(--fg-2)"
  };
}

function AnalyzeIcon() {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ flex: "0 0 auto" }}>
      <rect x={3} y={3} width={8} height={18} rx={1.6} />
      <rect x={13} y={3} width={8} height={8} rx={1.6} />
      <rect x={13} y={13} width={8} height={8} rx={1.6} />
    </svg>
  );
}

function CleanupIcon() {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ flex: "0 0 auto" }}>
      <path d="M12 3l1.6 4L18 8.6l-4.4 1.6L12 15l-1.6-4.8L6 8.6 10.4 7z" />
      <path d="M18.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
    </svg>
  );
}

function ScansIcon() {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ flex: "0 0 auto" }}>
      <circle cx={12} cy={12} r={9} />
      <polyline points="12 7 12 12 15.5 14" />
    </svg>
  );
}

function LogsIcon() {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ flex: "0 0 auto" }}>
      <line x1={4} y1={7} x2={20} y2={7} />
      <line x1={4} y1={12} x2={20} y2={12} />
      <line x1={4} y1={17} x2={14} y2={17} />
    </svg>
  );
}

function AgentsIcon() {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ flex: "0 0 auto" }}>
      <rect x={4} y={8} width={16} height={12} rx={2.5} />
      <line x1={12} y1={4} x2={12} y2={8} />
      <circle cx={9} cy={14} r={1} />
      <circle cx={15} cy={14} r={1} />
    </svg>
  );
}

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <polyline points={direction === "left" ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
    </svg>
  );
}

export function Sidebar({ collapsed, onToggleCollapsed, screen, onSetScreen, reclaimTotalLabel, diskUsage }: SidebarProps) {
  return (
    <div className="sidebar" style={{ flex: `0 0 ${collapsed ? 66 : 224}px`, width: collapsed ? 66 : 224, padding: collapsed ? "16px 10px" : "16px 12px" }}>
      <div className="sidebar-brand-row" style={{ padding: collapsed ? "6px 0 16px" : "6px 8px 16px", justifyContent: collapsed ? "center" : "flex-start" }}>
        <div className="sidebar-brand-icon">
          <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
            <rect x={3} y={3} width={8} height={18} rx={1.6} />
            <rect x={13} y={3} width={8} height={8} rx={1.6} />
            <rect x={13} y={13} width={8} height={8} rx={1.6} />
          </svg>
        </div>
        {!collapsed ? (
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--fg)", lineHeight: 1.1 }}>Bytescape</div>
            <div style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.3 }}>Disk space map</div>
          </div>
        ) : null}
      </div>

      <button type="button" className="nav-item" style={navStyle(screen === "analyze", collapsed)} title="Analyze" onClick={() => onSetScreen("analyze")}>
        <AnalyzeIcon />
        {!collapsed ? <span>Analyze</span> : null}
      </button>
      <button type="button" className="nav-item" style={navStyle(screen === "cleanup", collapsed)} title="Cleanup" onClick={() => onSetScreen("cleanup")}>
        <CleanupIcon />
        {!collapsed ? <span style={{ flex: 1, textAlign: "left" }}>Cleanup</span> : null}
        {!collapsed && reclaimTotalLabel ? <span className="pill pill-ok">{reclaimTotalLabel}</span> : null}
      </button>
      <button type="button" className="nav-item" style={navStyle(screen === "scans", collapsed)} title="Scans" onClick={() => onSetScreen("scans")}>
        <ScansIcon />
        {!collapsed ? <span>Scans</span> : null}
      </button>
      <button type="button" className="nav-item" style={navStyle(screen === "logs", collapsed)} title="Logs" onClick={() => onSetScreen("logs")}>
        <LogsIcon />
        {!collapsed ? <span>Logs</span> : null}
      </button>
      <button type="button" className="nav-item" style={navStyle(screen === "agents", collapsed)} title="For agents" onClick={() => onSetScreen("agents")}>
        <AgentsIcon />
        {!collapsed ? <span>For agents</span> : null}
      </button>

      <div style={{ flex: 1 }} />

      {!collapsed && diskUsage ? (
        <div className="sidebar-disk-card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--fg-2)" }}>Scanned</span>
          </div>
          <div style={{ height: 7, borderRadius: 6, background: "var(--inset)", overflow: "hidden" }}>
            <div style={{ width: "100%", height: "100%", background: "linear-gradient(90deg,var(--accent),#e0709a)" }} />
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: "var(--fg-3)" }}>{formatBytes(diskUsage.used)} scanned</div>
        </div>
      ) : null}

      <button
        type="button"
        className="nav-item sidebar-toggle"
        style={{ display: "flex", alignItems: "center", gap: collapsed ? 0 : 11, justifyContent: collapsed ? "center" : "flex-start", height: 38, padding: collapsed ? 0 : "0 12px", marginTop: 4, borderRadius: 10, border: "none", cursor: "pointer", width: "100%", fontSize: 13, fontWeight: 500, background: "transparent", color: "var(--fg-3)" }}
        title="Toggle sidebar"
        onClick={onToggleCollapsed}
      >
        <span style={{ width: 16, height: 16, display: "inline-flex", flex: "0 0 auto" }}>
          <Chevron direction={collapsed ? "right" : "left"} />
        </span>
        {!collapsed ? <span>Collapse</span> : null}
      </button>
    </div>
  );
}
