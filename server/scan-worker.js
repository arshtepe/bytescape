"use strict";
// Scan worker: enumerates directories using synchronous native fs calls.
// Sync-in-a-worker beats promise-based fs because each promise call pays a
// threadpool round-trip; readdirSync/lstatSync go straight to the syscall.
//
// The worker also pre-serializes each entry's NDJSON line and posts one blob
// string per directory instead of per-entry objects: file nodes are
// write-only on the main thread (only directory nodes live in memory for
// drill-down/size propagation), so shipping objects for them would only add
// structured-clone and GC cost. Kept as plain JS so the same file runs under
// tsx in dev and from compiled dist-server output.

const fs = require("fs");
const path = require("path");
const { parentPort, workerData } = require("worker_threads");

const includeHidden = Boolean(workerData && workerData.includeHidden);
// Directories left out of the scan entirely: on macOS the /System/Volumes/Data
// twins of firmlinked folders (/Users, /Applications...), which a scan of /
// would otherwise walk and count twice.
const skipPaths = new Set((workerData && workerData.skipPaths) || []);
const CHUNK = 5000;

/**
 * @param {string} dirPath
 * @param {number} taskId
 */
function scanDirectory(dirPath, taskId) {
  let dirents;
  try {
    dirents = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    parentPort.postMessage({
      type: "dir",
      taskId,
      dirPath,
      blob: "",
      dirEntries: [],
      entryCount: 0,
      fileCount: 0,
      fileBytes: 0,
      entryErrors: [],
      dirError: { code: (error && error.code) || "ERROR", message: (error && error.message) || String(error) },
      done: true
    });
    return;
  }

  let lines = [];
  let dirEntries = [];
  let entryCount = 0;
  let fileCount = 0;
  let fileBytes = 0;
  let entryErrors = [];

  const post = (done) => {
    parentPort.postMessage({
      type: "dir",
      taskId,
      dirPath,
      blob: lines.join(""),
      dirEntries,
      entryCount,
      fileCount,
      fileBytes,
      entryErrors,
      dirError: null,
      done
    });
    lines = [];
    dirEntries = [];
    entryCount = 0;
    fileCount = 0;
    fileBytes = 0;
    entryErrors = [];
  };

  for (const dirent of dirents) {
    const name = dirent.name;
    if (!includeHidden && name.startsWith(".")) continue;

    const absPath = path.join(dirPath, name);
    if (skipPaths.has(absPath)) continue;
    let kind;
    let size = 0;
    let mtimeMs = 0;
    let errorCount = 0;

    try {
      const stats = fs.lstatSync(absPath);
      if (stats.isDirectory()) kind = "directory";
      else if (stats.isFile()) kind = "file";
      else if (stats.isSymbolicLink()) kind = "symlink";
      else kind = "other";
      // Space on disk, as du and Finder's "on disk" count it: sparse disk
      // images (Docker.raw, VM disks) and compressed files use less than their
      // length. Windows has no block count, so it falls back to the length.
      size = kind === "file" ? (typeof stats.blocks === "number" ? stats.blocks * 512 : stats.size) : 0;
      mtimeMs = stats.mtimeMs;
    } catch (error) {
      kind = "inaccessible";
      mtimeMs = Date.now();
      errorCount = 1;
      entryErrors.push({
        path: absPath,
        code: (error && error.code) || "ERROR",
        message: (error && error.message) || String(error)
      });
    }

    // Same node shape persistNode used to write; live totals for directories
    // are overlaid from the in-memory dirs map on read (enrichNode).
    lines.push(
      `${JSON.stringify({
        path: absPath,
        parentPath: dirPath,
        name,
        kind,
        size,
        totalChildren: 0,
        errorCount,
        modifiedAt: mtimeMs
      })}\n`
    );

    entryCount += 1;
    if (kind === "file") {
      fileCount += 1;
      fileBytes += size;
    } else if (kind === "directory") {
      dirEntries.push({ name, mtimeMs });
    }

    if (entryCount >= CHUNK) post(false);
  }

  post(true);
}

parentPort.on("message", (message) => {
  if (message.type !== "scan") return;
  for (const task of message.tasks) {
    scanDirectory(task.dirPath, task.taskId);
  }
});
