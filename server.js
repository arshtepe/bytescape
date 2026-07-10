const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 5178);
const HOST = process.env.HOST || "127.0.0.1";
const DIST_DIR = path.join(__dirname, "dist");
const PUBLIC_DIR = path.join(__dirname, "public");
const SCAN_ROOT = path.join(os.tmpdir(), "disk-space-visualizer-scans");
const CRASH_ROOT = path.join(SCAN_ROOT, "crash-reports");
const jobs = new Map();
let wss = null;
let crashHandlersInstalled = false;

class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.active >= this.max) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

class ScanCancelled extends Error {
  constructor() {
    super("Scan cancelled");
    this.name = "ScanCancelled";
  }
}

function expandHome(inputPath) {
  if (!inputPath || typeof inputPath !== "string") return os.homedir();
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function normalizeScanPath(inputPath) {
  return path.resolve(expandHome(inputPath));
}

async function pathExists(absPath) {
  try {
    await fsp.access(absPath);
    return true;
  } catch {
    return false;
  }
}

async function getWindowsDriveRoots() {
  if (process.platform !== "win32") return [];
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const checks = await Promise.all(letters.map(async (letter) => {
    const drivePath = `${letter}:\\`;
    return await pathExists(drivePath) ? { label: `${letter}: drive`, path: drivePath } : null;
  }));
  return checks.filter(Boolean);
}

async function getRootChoices() {
  const roots = [
    { label: "Home", path: os.homedir() },
    { label: "Current project", path: process.cwd() }
  ];

  if (process.platform === "win32") {
    const drives = await getWindowsDriveRoots();
    const homeDrive = path.parse(os.homedir()).root;
    for (const drive of drives) {
      if (!roots.some((item) => item.path.toLowerCase() === drive.path.toLowerCase())) {
        roots.push(drive);
      }
    }
    if (homeDrive && !roots.some((item) => item.path.toLowerCase() === homeDrive.toLowerCase())) {
      roots.push({ label: "System drive", path: homeDrive });
    }
    return roots;
  }

  roots.push({ label: process.platform === "darwin" ? "Macintosh HD" : "Filesystem root", path: "/" });
  if (process.platform === "darwin" && await pathExists("/Applications")) {
    roots.push({ label: "Applications", path: "/Applications" });
  }
  return roots;
}

function scanDir(id) {
  return path.join(SCAN_ROOT, id);
}

function snapshotPath(id) {
  return path.join(scanDir(id), "meta.json");
}

function dirsPath(id) {
  return path.join(scanDir(id), "dirs.json");
}

function errorsPath(id) {
  return path.join(scanDir(id), "errors.json");
}

function nodesPath(id) {
  return path.join(scanDir(id), "nodes.ndjson");
}

function childrenRoot(id) {
  return path.join(scanDir(id), "children");
}

function pathKey(absPath) {
  return crypto.createHash("sha1").update(absPath).digest("hex");
}

function childrenPath(id, parentPath) {
  return path.join(childrenRoot(id), `${pathKey(parentPath)}.ndjson`);
}

function serializeError(error) {
  if (!error) return null;
  return {
    name: error.name || "Error",
    message: error.message || String(error),
    stack: error.stack || null,
    code: error.code || null
  };
}

async function saveCrashReport(kind, error) {
  await fsp.mkdir(CRASH_ROOT, { recursive: true });
  const id = crypto.randomUUID();
  const target = path.join(CRASH_ROOT, `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}.json`);
  const report = {
    id,
    kind,
    at: new Date().toISOString(),
    pid: process.pid,
    platform: process.platform,
    node: process.version,
    cwd: process.cwd(),
    argv: process.argv,
    memoryUsage: process.memoryUsage(),
    activeScans: Array.from(jobs.values()).map(makeMeta),
    error: serializeError(error)
  };
  await fsp.writeFile(target, JSON.stringify(report, null, 2));
  console.error(`Crash report saved: ${target}`);
  return target;
}

function installCrashHandlers() {
  if (crashHandlersInstalled) return;
  crashHandlersInstalled = true;
  process.on("uncaughtException", (error) => {
    saveCrashReport("uncaughtException", error)
      .catch((writeError) => console.error(`Failed to save crash report: ${writeError.message}`))
      .finally(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    saveCrashReport("unhandledRejection", error)
      .catch((writeError) => console.error(`Failed to save crash report: ${writeError.message}`))
      .finally(() => process.exit(1));
  });

  process.on("warning", (warning) => {
    saveCrashReport("warning", warning)
      .catch((writeError) => console.error(`Failed to save warning report: ${writeError.message}`));
  });
}

function inferKind(stats) {
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  if (stats.isSymbolicLink()) return "symlink";
  return "other";
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
    req.on("error", reject);
  });
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function makeMeta(job) {
  return {
    id: job.id,
    status: job.status,
    rootPath: job.rootPath,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    progress: {
      entriesScanned: job.entriesScanned,
      dirsScanned: job.dirsScanned,
      filesScanned: job.filesScanned,
      bytesScanned: job.bytesScanned,
      errors: job.errors.length
    },
    storagePath: scanDir(job.id)
  };
}

function makeNode(absPath, parentPath, stats, kind) {
  return {
    path: absPath,
    parentPath,
    name: parentPath ? path.basename(absPath) || absPath : absPath,
    kind,
    size: kind === "file" ? stats.size : 0,
    totalChildren: 0,
    errorCount: 0,
    modifiedAt: stats.mtimeMs
  };
}

async function writeSnapshot(job) {
  await fsp.mkdir(scanDir(job.id), { recursive: true });
  const writes = [
    [snapshotPath(job.id), makeMeta(job)],
    [dirsPath(job.id), Array.from(job.dirs.values())],
    [errorsPath(job.id), job.errors.slice(-1000)]
  ];
  await Promise.all(writes.map(async ([target, payload]) => {
    const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(payload));
    await fsp.rename(tmp, target);
  }));
}

function queueSnapshotWrite(job) {
  job.snapshotWrite = (job.snapshotWrite || Promise.resolve())
    .catch(() => {})
    .then(() => writeSnapshot(job));
  return job.snapshotWrite;
}

function scheduleSnapshot(job) {
  if (job.snapshotTimer) return;
  job.snapshotTimer = setTimeout(() => {
    job.snapshotTimer = null;
    queueSnapshotWrite(job).catch((error) => {
      job.error = error.message;
      broadcastScan(job);
    });
  }, 1200);
}

function broadcast(payload) {
  if (!wss) return;
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}

function broadcastScan(job) {
  const now = Date.now();
  if (job.lastBroadcastAt && now - job.lastBroadcastAt < 600 && job.status === "running") return;
  job.lastBroadcastAt = now;
  broadcast({ type: "scan:update", scan: makeMeta(job) });
}

function broadcastLog(job, level, message, details = {}) {
  const now = Date.now();
  if (level === "scan" && job.lastLogAt && now - job.lastLogAt < 120) return;
  if (level === "scan") job.lastLogAt = now;
  broadcast({
    type: "scan:log",
    log: {
      id: crypto.randomUUID(),
      scanId: job.id,
      at: new Date().toISOString(),
      level,
      message,
      ...details
    }
  });
}

function recordError(job, absPath, error) {
  const item = {
    path: absPath,
    code: error && error.code ? error.code : "ERROR",
    message: error && error.message ? error.message : String(error)
  };
  job.errors.push(item);
  if (job.errors.length > 1000) job.errors.splice(0, job.errors.length - 1000);
}

async function appendJsonLine(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.appendFile(filePath, `${JSON.stringify(value)}\n`);
}

async function persistNode(job, parent, node) {
  await appendJsonLine(nodesPath(job.id), node);
  if (parent) {
    await appendJsonLine(childrenPath(job.id, parent.path), node);
    parent.totalChildren += 1;
  }
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readNdjson(filePath) {
  const records = [];
  try {
    const stream = fs.createReadStream(filePath, "utf8");
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      records.push(JSON.parse(line));
    }
    return records;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readScanErrors(id, limit = 200) {
  const errors = await readJsonFile(errorsPath(id), []);
  return errors.slice(-limit);
}

async function readDirNodesByPath(id, wantedPaths) {
  const wanted = new Set(Array.from(wantedPaths || []).filter(Boolean));
  const found = new Map();
  if (!wanted.size) return found;

  try {
    const stream = fs.createReadStream(dirsPath(id), "utf8");
    let objectText = "";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for await (const chunk of stream) {
      for (const char of chunk) {
        if (depth === 0) {
          if (char === "{") {
            depth = 1;
            objectText = "{";
            inString = false;
            escaped = false;
          }
          continue;
        }

        objectText += char;

        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = inString;
          continue;
        }
        if (char === "\"") {
          inString = !inString;
          continue;
        }
        if (inString) continue;

        if (char === "{") depth += 1;
        if (char === "}") {
          depth -= 1;
          if (depth === 0) {
            try {
              const node = JSON.parse(objectText);
              if (wanted.has(node.path)) {
                found.set(node.path, node);
                if (found.size === wanted.size) return found;
              }
            } catch {
              // Ignore malformed partial records from interrupted scans.
            }
            objectText = "";
          }
        }
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  return found;
}

async function getScanStore(id) {
  const active = jobs.get(id);
  if (active) {
    return {
      meta: makeMeta(active),
      dirs: active.dirs,
      errors: active.errors.slice(-1000),
      active: true
    };
  }
  const [meta, errors] = await Promise.all([
    readJsonFile(snapshotPath(id), null),
    readJsonFile(errorsPath(id), [])
  ]);
  if (!meta) {
    const error = new Error("Scan not found");
    error.statusCode = 404;
    throw error;
  }
  return {
    meta,
    dirs: null,
    errors,
    active: false
  };
}

function enrichNode(node, dirMap) {
  if (!node) return null;
  if (!dirMap) return node;
  if (node.kind !== "directory") return node;
  return dirMap.get(node.path) || node;
}

function fallbackDirectoryNode(absPath, meta) {
  return {
    path: absPath,
    parentPath: absPath === meta.rootPath ? "" : path.dirname(absPath),
    name: absPath === meta.rootPath ? absPath : path.basename(absPath) || absPath,
    kind: "directory",
    size: absPath === meta.rootPath ? meta.progress?.bytesScanned || 0 : 0,
    totalChildren: 0,
    errorCount: 0,
    modifiedAt: null
  };
}

async function getScanMeta(id) {
  const active = jobs.get(id);
  if (active) return makeMeta(active);
  const meta = await readJsonFile(snapshotPath(id), null);
  if (!meta) {
    const error = new Error("Scan not found");
    error.statusCode = 404;
    throw error;
  }
  return meta;
}

const FILE_TYPE_DEFS = [
  { type: "images", label: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "svg", "ico"] },
  { type: "videos", label: "Videos", extensions: ["mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv", "flv", "mpg", "mpeg"] },
  { type: "audio", label: "Audio", extensions: ["mp3", "wav", "flac", "aac", "m4a", "ogg", "opus", "aif", "aiff"] },
  { type: "archives", label: "Archives", extensions: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "dmg", "iso", "pkg"] },
  { type: "documents", label: "Documents", extensions: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key", "rtf", "txt", "md"] },
  { type: "code", label: "Code", extensions: ["js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "cc", "cpp", "h", "hpp", "cs", "php", "sh", "zsh", "bash", "html", "css", "scss", "sass"] },
  { type: "data", label: "Data", extensions: ["json", "xml", "yaml", "yml", "csv", "tsv", "sqlite", "sqlite3", "db", "log", "ndjson", "parquet", "avro"] },
  { type: "apps", label: "Apps", extensions: ["app", "exe", "apk", "ipa", "bin", "dylib", "so", "framework"] },
  { type: "other", label: "Other", extensions: [] }
];

const FILE_TYPE_BY_EXTENSION = new Map(
  FILE_TYPE_DEFS.flatMap((definition) => definition.extensions.map((extension) => [extension, definition]))
);

function classifyFileName(name) {
  const extension = path.extname(name || "").toLowerCase().replace(/^\./, "");
  const definition = FILE_TYPE_BY_EXTENSION.get(extension) || FILE_TYPE_DEFS[FILE_TYPE_DEFS.length - 1];
  return {
    extension,
    type: definition.type,
    typeLabel: definition.label,
    groupKey: extension ? `${definition.type}:${extension}` : `${definition.type}:no-extension`,
    groupLabel: extension ? `.${extension}` : "No extension"
  };
}

function normalizeExtensionQuery(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
}

function addTopFile(files, file, limit) {
  files.push(file);
  files.sort((a, b) => {
    if ((b.size || 0) !== (a.size || 0)) return (b.size || 0) - (a.size || 0);
    return a.path.localeCompare(b.path);
  });
  if (files.length > limit) files.length = limit;
}

async function fileGroupsForScan(id, options = {}) {
  const meta = await getScanMeta(id);
  const typeFilter = String(options.type || "all");
  const extensionQuery = normalizeExtensionQuery(options.extension || options.q);
  const includeFiles = options.includeFiles === true || options.includeFiles === "true";
  const groupLimit = clampInt(options.groupLimit, 1, 300, 80);
  const maxGroups = clampInt(options.limit, 1, 500, 160);
  const groups = new Map();
  const summaries = new Map(FILE_TYPE_DEFS.map((definition) => [
    definition.type,
    { type: definition.type, label: definition.label, count: 0, totalSize: 0 }
  ]));
  const allSummary = { type: "all", label: "All", count: 0, totalSize: 0 };

  function getGroup(classification) {
    if (!groups.has(classification.groupKey)) {
      groups.set(classification.groupKey, {
        key: classification.groupKey,
        extension: classification.extension,
        label: classification.groupLabel,
        type: classification.type,
        typeLabel: classification.typeLabel,
        count: 0,
        totalSize: 0,
        files: []
      });
    }
    return groups.get(classification.groupKey);
  }

  const stream = fs.createReadStream(nodesPath(id), "utf8");
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let node;
    try {
      node = JSON.parse(line);
    } catch {
      continue;
    }
    if (!node || node.kind !== "file") continue;
    const classification = classifyFileName(node.name || node.path);
    const summary = summaries.get(classification.type);
    if (summary) {
      summary.count += 1;
      summary.totalSize += node.size || 0;
    }
    allSummary.count += 1;
    allSummary.totalSize += node.size || 0;
    if (typeFilter !== "all" && classification.type !== typeFilter) continue;
    if (extensionQuery && !classification.extension.includes(extensionQuery)) continue;

    const group = getGroup(classification);
    group.count += 1;
    group.totalSize += node.size || 0;
    if (includeFiles) {
      const file = {
        path: node.path,
        directory: path.dirname(node.path),
        name: node.name || path.basename(node.path),
        size: node.size || 0,
        modifiedAt: node.modifiedAt || null,
        type: classification.type,
        extension: classification.extension
      };
      addTopFile(group.files, file, groupLimit);
    }
  }

  const orderedGroups = Array.from(groups.values())
    .sort((a, b) => {
      if (b.totalSize !== a.totalSize) return b.totalSize - a.totalSize;
      if (b.count !== a.count) return b.count - a.count;
      return a.label.localeCompare(b.label);
    })
    .slice(0, maxGroups)
    .map((group) => ({
      ...group,
      visibleFiles: group.files.length
    }));

  return {
    scan: meta,
    filter: typeFilter,
    extensionQuery,
    generatedAt: new Date().toISOString(),
    types: [
      allSummary,
      ...FILE_TYPE_DEFS.map((definition) => summaries.get(definition.type))
    ],
    groups: orderedGroups
  };
}

async function filesForGroup(id, options = {}) {
  const meta = await getScanMeta(id);
  const key = String(options.key || "");
  const offset = clampInt(options.offset, 0, 1_000_000, 0);
  const limit = clampInt(options.limit, 1, 200, 50);
  const keep = offset + limit;
  const files = [];
  let totalCount = 0;
  let totalSize = 0;
  let group = null;

  const stream = fs.createReadStream(nodesPath(id), "utf8");
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let node;
    try {
      node = JSON.parse(line);
    } catch {
      continue;
    }
    if (!node || node.kind !== "file") continue;
    const classification = classifyFileName(node.name || node.path);
    if (classification.groupKey !== key) continue;
    group = {
      key: classification.groupKey,
      extension: classification.extension,
      label: classification.groupLabel,
      type: classification.type,
      typeLabel: classification.typeLabel
    };
    const file = {
      path: node.path,
      directory: path.dirname(node.path),
      name: node.name || path.basename(node.path),
      size: node.size || 0,
      modifiedAt: node.modifiedAt || null,
      type: classification.type,
      extension: classification.extension
    };
    totalCount += 1;
    totalSize += file.size;
    addTopFile(files, file, keep);
  }

  return {
    scan: meta,
    group: group || { key },
    offset,
    limit,
    totalCount,
    totalSize,
    files: files.slice(offset, offset + limit),
    nextOffset: offset + limit < totalCount ? offset + limit : null,
    generatedAt: new Date().toISOString()
  };
}

async function topFilesForScan(id, options = {}) {
  const meta = await getScanMeta(id);
  const typeFilter = String(options.type || "all");
  const extensionQuery = normalizeExtensionQuery(options.q || options.extension);
  const key = String(options.key || "");
  const limit = clampInt(options.limit, 1, 50, 10);
  const files = [];
  let totalCount = 0;
  let totalSize = 0;

  const stream = fs.createReadStream(nodesPath(id), "utf8");
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let node;
    try {
      node = JSON.parse(line);
    } catch {
      continue;
    }
    if (!node || node.kind !== "file") continue;
    const classification = classifyFileName(node.name || node.path);
    if (key && classification.groupKey !== key) continue;
    if (!key && typeFilter !== "all" && classification.type !== typeFilter) continue;
    if (!key && extensionQuery && !classification.extension.includes(extensionQuery)) continue;

    const file = {
      path: node.path,
      directory: path.dirname(node.path),
      name: node.name || path.basename(node.path),
      size: node.size || 0,
      modifiedAt: node.modifiedAt || null,
      type: classification.type,
      extension: classification.extension
    };
    totalCount += 1;
    totalSize += file.size;
    addTopFile(files, file, limit);
  }

  return {
    scan: meta,
    totalCount,
    totalSize,
    files,
    generatedAt: new Date().toISOString()
  };
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function scanTree(job, options) {
  const io = new Semaphore(options.fsConcurrency);

  function addSize(ancestors, bytes) {
    job.bytesScanned += bytes;
    for (const ancestor of ancestors) {
      ancestor.size += bytes;
    }
  }

  function addError(ancestors) {
    for (const ancestor of ancestors) {
      ancestor.errorCount += 1;
    }
  }

  async function scanPath(absPath, depth, parent, ancestors) {
    if (job.cancelled) throw new ScanCancelled();
    broadcastLog(job, "scan", absPath, { path: absPath, depth });

    let stats;
    try {
      stats = await io.run(() => fsp.lstat(absPath));
    } catch (error) {
      recordError(job, absPath, error);
      broadcastLog(job, "error", `${error.code || "ERROR"} ${absPath}`, { path: absPath, code: error.code || "ERROR" });
      const node = {
        path: absPath,
        parentPath: parent ? parent.path : "",
        name: path.basename(absPath) || absPath,
        kind: "inaccessible",
        size: 0,
        totalChildren: 0,
        errorCount: 1,
        modifiedAt: Date.now()
      };
      await persistNode(job, parent, node);
      addError(ancestors);
      scheduleSnapshot(job);
      broadcastScan(job);
      return node;
    }

    const kind = inferKind(stats);
    const node = makeNode(absPath, parent ? parent.path : "", stats, kind);
    if (!parent) job.rootNodePath = node.path;
    if (kind === "directory") job.dirs.set(node.path, node);
    await persistNode(job, parent, node);

    job.entriesScanned += 1;

    if (kind === "file") {
      job.filesScanned += 1;
      addSize(ancestors, node.size);
      scheduleSnapshot(job);
      broadcastScan(job);
      return node;
    }

    if (kind !== "directory" || depth >= options.maxDepth) {
      return node;
    }

    job.dirsScanned += 1;
    let names;
    try {
      names = await io.run(() => fsp.readdir(absPath));
    } catch (error) {
      recordError(job, absPath, error);
      broadcastLog(job, "error", `${error.code || "ERROR"} ${absPath}`, { path: absPath, code: error.code || "ERROR" });
      node.errorCount = 1;
      addError([...ancestors, node]);
      scheduleSnapshot(job);
      broadcastScan(job);
      return node;
    }

    if (!options.includeHidden) names = names.filter((name) => !name.startsWith("."));

    await mapLimit(names, options.walkConcurrency, async (name) => {
      const childPath = path.join(absPath, name);
      return scanPath(childPath, depth + 1, node, [...ancestors, node]);
    });

    scheduleSnapshot(job);
    broadcastScan(job);
    return node;
  }

  await scanPath(job.rootPath, 0, null, []);
}

async function createScanJob(payload) {
  const rootPath = normalizeScanPath(payload.rootPath);
  const stats = await fsp.stat(rootPath);
  if (!stats.isDirectory()) {
    const error = new Error("Scan path must be a directory");
    error.statusCode = 400;
    throw error;
  }

  const id = crypto.randomUUID();
  const job = {
    id,
    status: "running",
    rootPath,
    rootNodePath: rootPath,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    entriesScanned: 0,
    dirsScanned: 0,
    filesScanned: 0,
    bytesScanned: 0,
    errors: [],
    error: null,
    cancelled: false,
    dirs: new Map(),
    snapshotTimer: null,
    snapshotWrite: Promise.resolve(),
    lastBroadcastAt: 0,
    lastLogAt: 0
  };

  const options = {
    maxDepth: clampInt(payload.maxDepth, 1, 64, 20),
    fsConcurrency: clampInt(payload.fsConcurrency, 8, 256, 64),
    walkConcurrency: clampInt(payload.walkConcurrency, 2, 64, 16),
    includeHidden: payload.includeHidden !== false
  };

  await fsp.mkdir(scanDir(id), { recursive: true });
  await fsp.mkdir(childrenRoot(id), { recursive: true });
  await fsp.writeFile(nodesPath(id), "");
  jobs.set(id, job);
  await queueSnapshotWrite(job);
  broadcastLog(job, "info", `started ${rootPath}`, { path: rootPath });
  broadcastScan(job);

  scanTree(job, options)
    .then(async () => {
      job.status = "complete";
      job.finishedAt = new Date().toISOString();
      if (job.snapshotTimer) clearTimeout(job.snapshotTimer);
      job.snapshotTimer = null;
      await queueSnapshotWrite(job);
      broadcastLog(job, "success", `finished ${rootPath}`, { path: rootPath });
      broadcastScan(job);
      jobs.delete(id);
    })
    .catch(async (error) => {
      job.error = error instanceof ScanCancelled ? "Scan cancelled" : error.message;
      job.status = error instanceof ScanCancelled ? "cancelled" : "failed";
      job.finishedAt = new Date().toISOString();
      if (job.snapshotTimer) clearTimeout(job.snapshotTimer);
      job.snapshotTimer = null;
      await queueSnapshotWrite(job).catch(() => {});
      broadcastLog(job, job.status === "cancelled" ? "warn" : "error", `${job.status} ${rootPath}`, { path: rootPath });
      broadcastScan(job);
      jobs.delete(id);
    });

  return job;
}

async function listScans() {
  await fsp.mkdir(SCAN_ROOT, { recursive: true });
  const entries = await fsp.readdir(SCAN_ROOT, { withFileTypes: true });
  const scans = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      scans.push(await getScanMeta(entry.name));
    } catch {
      // Ignore incomplete temp folders.
    }
  }
  return scans.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

async function nodesToFolderPayload(id, requestedPath) {
  const store = await getScanStore(id);
  const rootPath = store.meta.rootPath;
  const currentPath = requestedPath || rootPath;
  let node = store.dirs?.get(currentPath) || null;
  const childRecords = await readNdjson(childrenPath(id, currentPath));
  let dirLookup = store.dirs;

  if (!dirLookup) {
    const wantedDirs = new Set([currentPath]);
    for (const child of childRecords) {
      if (child.kind === "directory") wantedDirs.add(child.path);
    }
    dirLookup = await readDirNodesByPath(id, wantedDirs);
    node = dirLookup.get(currentPath) || node;
  }

  if (!node) node = fallbackDirectoryNode(currentPath, store.meta);
  node.totalChildren = childRecords.length || node.totalChildren || 0;

  const children = childRecords
    .map((child) => enrichNode(child, dirLookup))
    .filter(Boolean)
    .sort((a, b) => (b.size || 0) - (a.size || 0));

  return {
    scan: store.meta,
    node,
    children,
    errors: store.errors.slice(-200)
  };
}

function fuzzyScore(text, query) {
  const source = text.toLowerCase();
  const target = query.toLowerCase().trim();
  if (!target) return 0;
  if (source === target) return 10000;
  if (source.includes(target)) return 7000 - source.indexOf(target);

  let score = 0;
  let lastIndex = -1;
  for (const char of target) {
    const index = source.indexOf(char, lastIndex + 1);
    if (index === -1) return 0;
    score += lastIndex + 1 === index ? 8 : 2;
    if (index === 0 || source[index - 1] === "/" || source[index - 1] === "-" || source[index - 1] === "_" || source[index - 1] === ".") {
      score += 5;
    }
    lastIndex = index;
  }
  return score;
}

async function searchScan(id, query, limit = 80) {
  const meta = await getScanMeta(id);
  const trimmed = String(query || "").trim();
  const lowered = trimmed.toLowerCase();
  if (!trimmed) return [];
  const matches = [];

  async function consider(node) {
    const enriched = node;
    const nameLower = enriched.name.toLowerCase();
    const nameScore = fuzzyScore(enriched.name, trimmed) * 2;
    const pathScore = fuzzyScore(enriched.path, trimmed);
    const score = Math.max(nameScore, pathScore);
    if (score <= 0) return;
    const rank = nameLower.startsWith(lowered) ? 0 : 1;
    matches.push({ node: enriched, score, rank });
    matches.sort(compareSearchMatches);
    if (matches.length > limit * 4) matches.length = limit * 2;
  }

  function compareSearchMatches(a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (b.score !== a.score) return b.score - a.score;
    if ((b.node.size || 0) !== (a.node.size || 0)) return (b.node.size || 0) - (a.node.size || 0);
    return a.node.path.localeCompare(b.node.path);
  }

  const stream = fs.createReadStream(nodesPath(id), "utf8");
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    await consider(JSON.parse(line));
  }

  return matches
    .sort(compareSearchMatches)
    .slice(0, limit)
    .map((item) => item.node);
}

async function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml; charset=utf-8",
    ".ico": "image/x-icon"
  }[ext] || "application/octet-stream";
}

async function serveStatic(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const baseDir = await fsp.stat(DIST_DIR).then(() => DIST_DIR).catch(() => PUBLIC_DIR);
  const requested = parsed.pathname === "/" ? "/index.html" : parsed.pathname;
  const decodedPath = decodeURIComponent(requested);
  let filePath = path.normalize(path.join(baseDir, decodedPath));
  if (!filePath.startsWith(baseDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
    const content = await fsp.readFile(filePath);
    res.writeHead(200, {
      "content-type": await getContentType(filePath),
      "cache-control": "no-store"
    });
    res.end(content);
  } catch (error) {
    if (error.code === "ENOENT" && baseDir === DIST_DIR) {
      const content = await fsp.readFile(path.join(DIST_DIR, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(content);
      return;
    }
    sendJson(res, error.code === "ENOENT" ? 404 : 500, { error: error.code === "ENOENT" ? "Not found" : error.message });
  }
}

async function openInFileManager(targetPath) {
  const normalized = normalizeScanPath(targetPath);
  let stats = null;
  try {
    stats = await fsp.stat(normalized);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const isDirectory = stats?.isDirectory() || false;
  const parentDir = isDirectory ? normalized : path.dirname(normalized);
  const launch = (command, args) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.unref();
  };

  if (process.platform === "darwin") {
    if (stats && !isDirectory) launch("open", ["-R", normalized]);
    else launch("open", [parentDir]);
    return { openedPath: normalized, mode: stats && !isDirectory ? "reveal" : "open" };
  }

  if (process.platform === "win32") {
    if (stats && !isDirectory) launch("explorer.exe", [`/select,${normalized}`]);
    else launch("explorer.exe", [parentDir]);
    return { openedPath: normalized, mode: stats && !isDirectory ? "reveal" : "open" };
  }

  launch("xdg-open", [parentDir]);
  return { openedPath: normalized, mode: "open" };
}

async function router(req, res) {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && parsed.pathname === "/api/roots") {
      sendJson(res, 200, {
        readOnly: true,
        scanStoragePath: SCAN_ROOT,
        platform: process.platform,
        roots: await getRootChoices()
      });
      return;
    }

    if (req.method === "GET" && parsed.pathname === "/api/scans") {
      sendJson(res, 200, { scans: await listScans() });
      return;
    }

    if (req.method === "POST" && parsed.pathname === "/api/open-in-folder") {
      const payload = await readBody(req);
      if (!payload.path || typeof payload.path !== "string") {
        sendJson(res, 400, { error: "Path is required" });
        return;
      }
      sendJson(res, 200, await openInFileManager(payload.path));
      return;
    }

    if (req.method === "POST" && parsed.pathname === "/api/scans") {
      const payload = await readBody(req);
      const job = await createScanJob(payload);
      sendJson(res, 202, { scan: makeMeta(job) });
      return;
    }

    const scanMatch = parsed.pathname.match(/^\/api\/scans\/([^/]+)$/);
    const childrenMatch = parsed.pathname.match(/^\/api\/scans\/([^/]+)\/children$/);
    const searchMatch = parsed.pathname.match(/^\/api\/scans\/([^/]+)\/search$/);
    const fileGroupMatch = parsed.pathname.match(/^\/api\/scans\/([^/]+)\/files\/group$/);
    const fileTopMatch = parsed.pathname.match(/^\/api\/scans\/([^/]+)\/files\/top$/);
    const filesMatch = parsed.pathname.match(/^\/api\/scans\/([^/]+)\/files$/);
    const cancelMatch = parsed.pathname.match(/^\/api\/scans\/([^/]+)\/cancel$/);

    if (scanMatch && req.method === "GET") {
      const store = await getScanStore(scanMatch[1]);
      sendJson(res, 200, { scan: store.meta });
      return;
    }

    if (childrenMatch && req.method === "GET") {
      sendJson(res, 200, await nodesToFolderPayload(childrenMatch[1], parsed.searchParams.get("path")));
      return;
    }

    if (searchMatch && req.method === "GET") {
      const store = await getScanStore(searchMatch[1]);
      const limit = clampInt(parsed.searchParams.get("limit"), 1, 200, 80);
      sendJson(res, 200, {
    scan: store.meta,
        query: parsed.searchParams.get("q") || "",
        results: await searchScan(searchMatch[1], parsed.searchParams.get("q"), limit)
      });
      return;
    }

    if (filesMatch && req.method === "GET") {
      sendJson(res, 200, await fileGroupsForScan(filesMatch[1], {
        type: parsed.searchParams.get("type") || "all",
        q: parsed.searchParams.get("q") || "",
        includeFiles: parsed.searchParams.get("includeFiles") === "true",
        limit: parsed.searchParams.get("limit"),
        groupLimit: parsed.searchParams.get("groupLimit")
      }));
      return;
    }

    if (fileGroupMatch && req.method === "GET") {
      sendJson(res, 200, await filesForGroup(fileGroupMatch[1], {
        key: parsed.searchParams.get("key") || "",
        offset: parsed.searchParams.get("offset"),
        limit: parsed.searchParams.get("limit")
      }));
      return;
    }

    if (fileTopMatch && req.method === "GET") {
      sendJson(res, 200, await topFilesForScan(fileTopMatch[1], {
        key: parsed.searchParams.get("key") || "",
        type: parsed.searchParams.get("type") || "all",
        q: parsed.searchParams.get("q") || "",
        limit: parsed.searchParams.get("limit")
      }));
      return;
    }

    if (cancelMatch && req.method === "POST") {
      const job = jobs.get(cancelMatch[1]);
      if (!job) {
        sendJson(res, 404, { error: "Scan is not currently running" });
        return;
      }
      job.cancelled = true;
      sendJson(res, 200, { scan: makeMeta(job) });
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message });
  }
}

async function runCliScan() {
  const job = await createScanJob({ rootPath: process.argv[3] || ".", maxDepth: 20, includeHidden: true });
  while (jobs.has(job.id)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const store = await getScanStore(job.id);
  console.log(JSON.stringify(store.meta, null, 2));
}

function startServer(options = {}) {
  const host = options.host || HOST;
  const port = options.port ?? PORT;
  if (options.installCrashHandlers !== false) installCrashHandlers();
  const server = http.createServer(router);
  wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", async (ws) => {
    ws.send(JSON.stringify({ type: "hello", scans: await listScans().catch(() => []) }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      const url = `http://${host}:${actualPort}`;
      console.log(`Disk Space Visualizer running at ${url}`);
      console.log(`Scan snapshots stored in ${SCAN_ROOT}`);
      console.log(`Crash reports stored in ${CRASH_ROOT}`);
      resolve({
        server,
        wss,
        url,
        close: () => new Promise((closeResolve) => {
          wss.close(() => {
            server.close(() => closeResolve());
          });
        })
      });
    });
  });
}

if (process.argv[2] === "--scan") {
  runCliScan().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  startServer
};
