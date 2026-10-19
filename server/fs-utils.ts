import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import readline from "readline";
import type { NodeKind, RootChoice } from "../shared/types";

// Where scan data lives. Defaults to the OS temp dir, which is usually on the
// system drive — the drive most often being scanned — so the user can move it
// (the app asks when space runs short). Stored in the home dir so the stdio
// MCP server, a separate process, finds the same location.
const SETTINGS_PATH = path.join(os.homedir(), ".disk-space-visualizer", "settings.json");
const STORE_DIRNAME = "disk-space-visualizer-scans";
export const DEFAULT_SCAN_ROOT = path.join(os.tmpdir(), STORE_DIRNAME);

interface Settings {
  scanRoot?: string | null;
  mcpEnabled?: boolean;
}

function readSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as Settings;
  } catch {
    return {}; // No settings yet, or unreadable: defaults.
  }
}

async function writeSettings(patch: Settings): Promise<void> {
  await fsp.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fsp.writeFile(SETTINGS_PATH, JSON.stringify({ ...readSettings(), ...patch }, null, 2));
}

function loadScanRoot(): string {
  const { scanRoot } = readSettings();
  return typeof scanRoot === "string" && path.isAbsolute(scanRoot) ? scanRoot : DEFAULT_SCAN_ROOT;
}

/** Read per call so the stdio MCP process picks up a toggle made in the app. */
export function isMcpEnabled(): boolean {
  return readSettings().mcpEnabled !== false;
}

export function setMcpEnabled(enabled: boolean): Promise<void> {
  return writeSettings({ mcpEnabled: enabled });
}

// `let` exports are live bindings: importers see the new value after setScanRoot.
export let SCAN_ROOT = loadScanRoot();
export let CRASH_ROOT = path.join(SCAN_ROOT, "crash-reports");

/**
 * Points scan storage at `<folder>/disk-space-visualizer-scans` (or back to
 * the default when folder is null), after checking it is writable, and
 * persists the choice. Returns the previous root.
 */
export async function setScanRoot(folder: string | null): Promise<string> {
  const next = folder ? path.join(path.resolve(folder), STORE_DIRNAME) : DEFAULT_SCAN_ROOT;
  await fsp.mkdir(next, { recursive: true });
  const probe = path.join(next, `.write-test-${process.pid}`);
  await fsp.writeFile(probe, "ok");
  await fsp.rm(probe, { force: true });

  await writeSettings({ scanRoot: next === DEFAULT_SCAN_ROOT ? null : next });
  const previous = SCAN_ROOT;
  SCAN_ROOT = next;
  CRASH_ROOT = path.join(SCAN_ROOT, "crash-reports");
  return previous;
}

/** Bytes available to this user on the volume holding `dir` (or its nearest existing parent). */
export async function freeBytes(dir: string): Promise<number> {
  let target = dir;
  while (!(await pathExists(target))) {
    const parent = path.dirname(target);
    if (parent === target) break;
    target = parent;
  }
  const stats = await fsp.statfs(target);
  return stats.bavail * stats.bsize;
}

// This module runs both from source (server/fs-utils.ts, via tsx in dev) and
// from compiled output nested one level deeper (dist-server/server/fs-utils.js),
// so a fixed "../.." relative to __dirname can't reach the project root in both
// cases. Walk up until we find package.json instead — present at the project
// root in dev, and bundled alongside dist/dist-server in the packaged app too.
export function findProjectRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

export const PROJECT_ROOT = findProjectRoot(__dirname);

const SCAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every scan file path is built here, from ids that arrive over the API and
 * MCP. Scan ids are UUIDs; anything else ("../../x") would reach outside the
 * scan store, so it is refused as an unknown scan.
 */
export function scanDir(id: string): string {
  if (typeof id !== "string" || !SCAN_ID.test(id)) {
    throw Object.assign(new Error("Scan not found"), { statusCode: 404 });
  }
  return path.join(SCAN_ROOT, id);
}

export function snapshotPath(id: string): string {
  return path.join(scanDir(id), "meta.json");
}

/** pid of the process running the scan; lets other processes (the MCP
 * server, a second app instance) tell a live scan from an orphaned one. */
export function ownerPath(id: string): string {
  return path.join(scanDir(id), "owner.json");
}

// One directory node per line. It used to be a single JSON array, which a
// scan with millions of folders could not save: JSON.stringify ran past V8's
// maximum string length, so dirs.json was never written and folder sizes were
// lost on the next start.
export function dirsPath(id: string): string {
  return path.join(scanDir(id), "dirs.ndjson");
}

/** Pre-NDJSON scans; still read when dirs.ndjson is missing. */
export function legacyDirsPath(id: string): string {
  return path.join(scanDir(id), "dirs.json");
}

/** Streams `items` to `target` as NDJSON via a temp file, so no single string holds them all. */
export async function writeNdjsonAtomic<T>(target: string, items: Iterable<T>): Promise<void> {
  const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const out = fs.createWriteStream(tmp, "utf8");
  const failed = new Promise<never>((_resolve, reject) => out.on("error", reject));
  const drained = () => Promise.race([new Promise<void>((resolve) => out.once("drain", () => resolve())), failed]);
  let chunk: string[] = [];
  for (const item of items) {
    chunk.push(`${JSON.stringify(item)}\n`);
    if (chunk.length >= 2000) {
      if (!out.write(chunk.join(""))) await drained();
      chunk = [];
    }
  }
  if (chunk.length) out.write(chunk.join(""));
  await Promise.race([new Promise<void>((resolve) => out.end(() => resolve())), failed]);
  await fsp.rename(tmp, target);
}

export function errorsPath(id: string): string {
  return path.join(scanDir(id), "errors.json");
}

export function nodesPath(id: string): string {
  return path.join(scanDir(id), "nodes.ndjson");
}

/** Paths moved to Trash after the scan settled; see server/trashed.ts. */
export function trashedPath(id: string): string {
  return path.join(scanDir(id), "trashed.json");
}

export function childrenRoot(id: string): string {
  return path.join(scanDir(id), "children");
}

export function pathKey(absPath: string): string {
  return crypto.createHash("sha1").update(absPath).digest("hex");
}

export function childrenPath(id: string, parentPath: string): string {
  return path.join(childrenRoot(id), `${pathKey(parentPath)}.ndjson`);
}

export function expandHome(inputPath?: string | null): string {
  if (!inputPath || typeof inputPath !== "string") return os.homedir();
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

export function normalizeScanPath(inputPath?: string | null): string {
  return path.resolve(expandHome(inputPath));
}

export async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fsp.access(absPath);
    return true;
  } catch {
    return false;
  }
}

async function getWindowsDriveRoots(): Promise<RootChoice[]> {
  if (process.platform !== "win32") return [];
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const checks = await Promise.all(
    letters.map(async (letter) => {
      const drivePath = `${letter}:\\`;
      return (await pathExists(drivePath)) ? { label: `${letter}: drive`, path: drivePath } : null;
    })
  );
  return checks.filter((item): item is RootChoice => item !== null);
}

export async function getRootChoices(): Promise<RootChoice[]> {
  const roots: RootChoice[] = [
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
  if (process.platform === "darwin" && (await pathExists("/Applications"))) {
    roots.push({ label: "Applications", path: "/Applications" });
  }
  return roots;
}

export function inferKind(stats: fs.Stats): NodeKind {
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  if (stats.isSymbolicLink()) return "symlink";
  return "other";
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function readNdjson<T>(filePath: string): Promise<T[]> {
  const records: T[] = [];
  try {
    const stream = fs.createReadStream(filePath, "utf8");
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      records.push(JSON.parse(line) as T);
    }
    return records;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function getContentType(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml; charset=utf-8",
    ".ico": "image/x-icon"
  };
  return map[ext] || "application/octet-stream";
}
