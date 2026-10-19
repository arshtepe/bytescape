import type { CSSProperties } from "react";
import type { Mode, Theme } from "../theme";

interface TitleBarProps {
  mode: Mode;
  onSetMode: (mode: Mode) => void;
  theme: Theme;
  onToggleTheme: () => void;
}

function segButtonStyle(active: boolean): CSSProperties {
  return {
    padding: "0 13px",
    height: 26,
    border: "none",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    background: active ? "var(--accent)" : "transparent",
    color: active ? "#fff" : "var(--fg-2)"
  };
}

function SunIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx={12} cy={12} r={4} />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
    </svg>
  );
}

export function TitleBar({ mode, onSetMode, theme, onToggleTheme }: TitleBarProps) {
  return (
    <div className="title-bar">
      <div className="title-bar-name">Bytescape</div>
      <div className="segmented">
        <button type="button" style={segButtonStyle(mode === "simple")} onClick={() => onSetMode("simple")}>
          Simple
        </button>
        <button type="button" style={segButtonStyle(mode === "advanced")} onClick={() => onSetMode("advanced")}>
          Advanced
        </button>
      </div>
      <button type="button" className="btn-ghost theme-toggle" onClick={onToggleTheme}>
        <span style={{ width: 15, height: 15, display: "inline-flex" }}>{theme === "dark" ? <SunIcon /> : <MoonIcon />}</span>
        {theme === "dark" ? "Light" : "Dark"}
      </button>
    </div>
  );
}
