import fsp from "fs/promises";
import { execFile } from "child_process";

// The browser page can't open a real filesystem folder dialog (the web File
// System Access API yields sandboxed handles, not paths), so the server side
// owns the picker: Electron's native dialog when we're embedded in the app,
// otherwise per-platform OS pickers invoked as child processes.

function execFileForPath(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5 * 60 * 1000 }, (error, stdout) => {
      if (error) {
        resolve(null); // Cancelled dialogs exit non-zero on every platform.
        return;
      }
      const picked = stdout.trim();
      resolve(picked || null);
    });
  });
}

async function pickWithElectron(title: string): Promise<string | null> {
  // Resolved lazily: 'electron' only exists when the server runs inside the
  // Electron main process; the standalone `node`/`tsx` server must not touch it.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { dialog, BrowserWindow } = require("electron") as typeof import("electron");
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const options = {
    title,
    properties: ["openDirectory" as const]
  };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0] ?? null;
}

function pickWithOsPicker(title: string): Promise<string | null> {
  // Titles are fixed strings from the router, never user input.
  if (process.platform === "darwin") {
    return execFileForPath("osascript", ["-e", `POSIX path of (choose folder with prompt "${title}")`]);
  }
  if (process.platform === "win32") {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; " +
      "$picker = New-Object System.Windows.Forms.FolderBrowserDialog; " +
      `$picker.Description = '${title}'; ` +
      "if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $picker.SelectedPath }";
    return execFileForPath("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  }
  return execFileForPath("zenity", ["--file-selection", "--directory", `--title=${title}`]);
}

let pickerInFlight: Promise<string | null> | null = null;

export function pickFolder(title = "Choose a folder to scan"): Promise<string | null> {
  // A second Browse click while a dialog is open joins the existing one
  // instead of stacking OS dialogs.
  if (pickerInFlight) return pickerInFlight;

  const run = async (): Promise<string | null> => {
    let picked: string | null = null;
    if (process.versions.electron) {
      try {
        picked = await pickWithElectron(title);
      } catch {
        picked = await pickWithOsPicker(title);
      }
    } else {
      picked = await pickWithOsPicker(title);
    }
    if (!picked) return null;

    // Normalize (osascript returns a trailing slash) and confirm it's a directory.
    const cleaned = picked.length > 1 ? picked.replace(/[\\/]+$/, "") : picked;
    try {
      const stats = await fsp.stat(cleaned);
      return stats.isDirectory() ? cleaned : null;
    } catch {
      return null;
    }
  };

  pickerInFlight = run().finally(() => {
    pickerInFlight = null;
  });
  return pickerInFlight;
}
