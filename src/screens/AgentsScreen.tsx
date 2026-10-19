import { useEffect, useState } from "react";
import type { McpSettings } from "../../shared/types";
import * as api from "../api";

function CopyRow({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be refused (e.g. page not focused); the text stays selectable.
    }
  };
  return (
    <div className="agents-copy">
      <div className="agents-copy-head">
        <span className="agents-label">{label}</span>
        <button type="button" className="btn-ghost" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className={`mono agents-value ${multiline ? "agents-value-multi" : ""}`}>{value}</pre>
    </div>
  );
}

export function AgentsScreen() {
  const [settings, setSettings] = useState<McpSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getMcp()
      .then(setSettings)
      .catch((caught: Error) => setError(caught.message));
  }, []);

  const toggle = async () => {
    if (!settings) return;
    setBusy(true);
    setError(null);
    try {
      setSettings(await api.setMcp(!settings.enabled));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scans-screen">
      <div className="scans-header">
        <div>
          <div className="screen-title">For agents</div>
          <div className="screen-sub">
            AI agents on this computer can read your scan results through a read-only MCP server. They can't delete anything.
          </div>
        </div>
      </div>

      {error ? <div className="storage-modal-error agents-block">{error}</div> : null}

      {settings ? (
        <>
          <div className="agents-status agents-block">
            <span className={`pill ${settings.enabled ? "pill-ok" : "pill-muted"}`}>{settings.enabled ? "Running" : "Stopped"}</span>
            <span className="agents-status-text">
              {settings.enabled ? "Agents can read scan results while the app is open." : "Agents get an error until you start it again."}
            </span>
            <button type="button" className={settings.enabled ? "btn-secondary btn-danger" : "btn-primary"} disabled={busy} onClick={() => void toggle()}>
              {settings.enabled ? "Stop MCP server" : "Start MCP server"}
            </button>
          </div>
          <div className="agents-block">
            <CopyRow label="Prompt for your agent" value={settings.prompt} multiline />
            <CopyRow label="Claude Code command" value={settings.addCommand} />
            <CopyRow label="Server URL" value={settings.url} />
          </div>
        </>
      ) : null}
    </div>
  );
}
