import { useState } from "react";
import type { StorageSettings } from "../../shared/types";
import * as api from "../api";
import { formatBytes } from "../format";

export interface StoragePrompt {
  /** Why we are asking: before a scan could start, or after one stopped. */
  reason: "start" | "stopped" | "manual";
  storagePath: string;
  freeBytes?: number;
  requiredBytes?: number;
}

interface StorageDialogProps {
  prompt: StoragePrompt;
  onClose: () => void;
  /** Called with the new settings once the location has changed. */
  onChanged: (settings: StorageSettings) => void;
}

export function StorageDialog({ prompt, onClose, onChanged }: StorageDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (useDefault: boolean) => {
    setBusy(true);
    setError(null);
    try {
      let folder: string | null = null;
      if (!useDefault) {
        folder = (await api.pickFolder("storage")).path;
        if (!folder) return; // picker cancelled
      }
      onChanged(await api.setStorage(folder));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title =
    prompt.reason === "manual" ? "Scan data location" : prompt.reason === "start" ? "Not enough space to start" : "Scan stopped: drive almost full";

  return (
    <div className="modal-backdrop">
      <div className="storage-modal" role="dialog" aria-labelledby="storage-modal-title">
        <div className="screen-title" id="storage-modal-title">
          {title}
        </div>
        <p className="storage-modal-text">
          Scan data is saved in{" "}
          <span className="mono">{prompt.storagePath}</span>
          {prompt.freeBytes !== undefined ? <>, which has {formatBytes(prompt.freeBytes)} free</> : null}
          {prompt.requiredBytes !== undefined && prompt.reason === "start" ? <>; this scan needs about {formatBytes(prompt.requiredBytes)}</> : null}.
        </p>
        <p className="storage-modal-text">
          {prompt.reason === "manual"
            ? "Large scans can take a few GB. Pick a folder on a drive with room to spare."
            : "Choose a folder on a drive with more free space, then start the scan again."}{" "}
          Saved scans at the current location are deleted when you switch; your files are not touched.
        </p>
        {error ? <div className="storage-modal-error">{error}</div> : null}
        <div className="storage-modal-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void choose(true)}>
            Use default
          </button>
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void choose(false)}>
            {busy ? "Working…" : "Choose folder…"}
          </button>
        </div>
      </div>
    </div>
  );
}
