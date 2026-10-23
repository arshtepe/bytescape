<p align="center">
  <img src="assets/hero.svg" alt="Bytescape: a treemap of folders; one tile is moved to Trash and the rest re-flow while the total drops" width="880">
</p>

<p align="center">
  <a href="https://github.com/arshtepe/bytescape/releases/latest"><img src="assets/download.svg" alt="Download Bytescape for macOS, Windows and Linux" width="360"></a>
</p>
<p align="center">
  <b>Direct download (v1.1.0):</b>
  <a href="https://github.com/arshtepe/bytescape/releases/download/v1.1.0/Bytescape-1.1.0-arm64.dmg">macOS (Apple Silicon)</a> ·
  <a href="https://github.com/arshtepe/bytescape/releases/download/v1.1.0/Bytescape-1.1.0.exe">Windows (x64)</a> ·
  <a href="https://github.com/arshtepe/bytescape/releases/download/v1.1.0/Bytescape-1.1.0.AppImage">Linux AppImage</a> ·
  <a href="https://github.com/arshtepe/bytescape/releases/download/v1.1.0/bytescape-1.1.0.tar.gz">Linux tar.gz</a>
  <br><sub>Unsigned builds: see the <a href="#download">install notes</a> for the first launch.</sub>
</p>

# Bytescape

See what is eating your disk, and clean it up safely. Bytescape scans a folder or a whole drive, draws it as a treemap, and lets you send the big stuff to Trash without leaving the app.

## Features

- **Treemap and simple view.** Drill into any folder; sizes update live while the scan runs.
- **Fast scans, honest sizes.** Directory listing runs on worker threads; about two million files take a minute. Sizes are space on disk, and on macOS a scan of `/` counts firmlinked folders once.
- **Safe cleanup.** Old node_modules, git-ignored build output and tool caches (Xcode, Gradle, npm, Homebrew, pip) are pre-selected. Duplicates (confirmed byte for byte), old archives and logs are listed for you to review. App data, hidden folders and cloud-synced folders are never suggested. Move to Trash has a 6 second undo, and the treemap, folder sizes and totals update the moment you click.
- **Breakdown by file type.** Find every video, disk image or archive across the scan.
- **For agents.** An optional read-only MCP endpoint lets AI tools ask what is using your space.
- **Private.** Everything runs locally. Scanning is read-only, and nothing about your files leaves your machine.

## Download

Download the current version (1.1.0) directly, or browse all versions on [Releases](https://github.com/arshtepe/bytescape/releases):

| Platform | Download |
| --- | --- |
| macOS (Apple Silicon) | [Bytescape-1.1.0-arm64.dmg](https://github.com/arshtepe/bytescape/releases/download/v1.1.0/Bytescape-1.1.0-arm64.dmg) or [.zip](https://github.com/arshtepe/bytescape/releases/download/v1.1.0/Bytescape-1.1.0-arm64-mac.zip) |
| Windows (x64) | [Bytescape-1.1.0.exe](https://github.com/arshtepe/bytescape/releases/download/v1.1.0/Bytescape-1.1.0.exe) (portable, no install) |
| Linux (x64) | [Bytescape-1.1.0.AppImage](https://github.com/arshtepe/bytescape/releases/download/v1.1.0/Bytescape-1.1.0.AppImage) or [bytescape-1.1.0.tar.gz](https://github.com/arshtepe/bytescape/releases/download/v1.1.0/bytescape-1.1.0.tar.gz) |

The builds are not signed yet:

- **macOS** blocks the first launch. Right-click the app and choose **Open**, or run `xattr -dr com.apple.quarantine /Applications/Bytescape.app`.
- **Windows** SmartScreen may warn: choose **More info**, then **Run anyway**.
- **Linux**: make the AppImage executable with `chmod +x Bytescape-*.AppImage`.

## Build from source

Requires Node.js 18 or newer.

```sh
npm install
npm run electron:dev   # run the desktop app
npm run dist:mac       # or dist:win, dist:linux
```

To use it in a browser instead, run `npm run build && npm start` and open `http://127.0.0.1:5178`.

## License

MIT
