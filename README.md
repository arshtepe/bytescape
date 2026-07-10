# Disk Space Visualizer

A local Node and React app for cross-platform disk usage analysis. It scans a folder from the local server process, persists scan snapshots under the OS temp directory, and renders an interactive treemap/tree in the browser.

## Run

```sh
npm start
```

Open `http://127.0.0.1:5178`.

On macOS, you can also double-click `Disk Space Visualizer.command`.

On Windows, you can double-click `Disk Space Visualizer.bat` from the project folder after installing Node.js and dependencies.

## Build UI

```sh
npm run build
```

## Desktop Builds

Run as an Electron desktop app locally:

```sh
npm run electron:dev
```

Build a portable Windows x64 executable:

```sh
npm run dist:win
```

The portable `.exe` is written to `release/Disk Space Visualizer 1.0.0.exe`.

Optional platform builds:

```sh
npm run dist:win:arm64
npm run dist:mac
npm run dist:linux
```

## Notes

- Scans run locally and do not upload file paths or sizes anywhere.
- Scan snapshots are saved under your OS temp folder, in `disk-space-visualizer-scans/<uuid>/`.
- Filesystem operations are read-only: the app uses metadata reads and directory listing only. It does not write, move, rename, or delete scanned files.
- Running scans stream status over WebSocket, so discovered folders and counted sizes update before the full scan finishes.
- The `Scans` tab lists saved scans, their status, size, entry count, start time, and lets you reopen them.
- The toolbar shows whether a scan is idle, scanning, finished, cancelled, or failed.
- The treemap fits the available screen by default. Use the zoom controls or `Cmd/Ctrl` + mouse wheel over the treemap to zoom and pan.
- Full paths are selectable in the toolbar and details panel. Use `Copy Path` on the selected item or any tree row to copy a file or folder path.
- Use `Show in Folder` / `Show` to reveal files or folders in Finder, Windows Explorer, or the Linux file manager.
- Symlinks are not followed, which avoids loops and duplicate counting.
- Permission errors are captured in the scan log.
- Full-disk scans can take a while. macOS may deny access to protected folders unless the terminal app has Full Disk Access; Windows may deny access to protected system folders unless the app is run from an elevated terminal.

## Platform Notes

- macOS and Linux show home, current project, and filesystem root shortcuts.
- Windows shows home, current project, and detected drive roots such as `C:\` or `D:\`.
- The app uses Node's platform path handling, so Windows paths with backslashes are supported.

## CLI Smoke Test

```sh
npm run scan:sample
```
