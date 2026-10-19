import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import readline from "readline";
import { Worker } from "worker_threads";
import type {
  ScanError,
  ScanMeta,
  ScanNode,
  ScanStatus,
  FolderPayload,
  SearchResponse,
  StorageSettings
} from "../shared/types";
import { broadcast } from "./broadcast";
import { addTrashed, trashedFilter } from "./trashed";
import {
  childrenPath,
  childrenRoot,
  clampInt,
  dirsPath,
  DEFAULT_SCAN_ROOT,
  errorsPath,
  freeBytes,
  inferKind,
  nodesPath,
  normalizeScanPath,
  ownerPath,
  readJsonFile,
  readNdjson,
  SCAN_ROOT,
  scanDir,
  setScanRoot,
  snapshotPath
} from "./fs-utils";

export class ScanCancelled extends Error {
  constructor() {
    super("Scan cancelled");
    this.name = "ScanCancelled";
  }
}

// Scan data needs roughly this much per entry (two NDJSON copies of each
// line) plus a small file per directory (one filesystem block each).
// Measured: 1.95M entries / 362k dirs on C:\ came to about 2 GB.
const BYTES_PER_ENTRY = 300;
const BYTES_PER_DIR = 4096;
// Space required up front when there is no earlier scan of the same folder
// to estimate from, and the floor the scan stops at while running, so the
// scan never fills the drive (it is usually the drive being scanned).
const MIN_FREE_TO_START = 2 * 1024 ** 3;
const MIN_FREE_WHILE_RUNNING = 512 * 1024 ** 2;

export class InsufficientSpaceError extends Error {
  readonly statusCode = 507;
  readonly code = "INSUFFICIENT_SPACE";
  constructor(
    readonly storagePath: string,
    readonly freeBytes: number,
    readonly requiredBytes: number
  ) {
    super(`Not enough free space for scan data in ${storagePath}`);
    this.name = "InsufficientSpaceError";
  }

  get details() {
    return { code: this.code, storagePath: this.storagePath, freeBytes: this.freeBytes, requiredBytes: this.requiredBytes };
  }
}

function estimateStoreBytes(scan: ScanMeta): number {
  return scan.progress.entriesScanned * BYTES_PER_ENTRY + scan.progress.dirsScanned * BYTES_PER_DIR;
}

export interface ScanJob {
  id: string;
  status: ScanStatus;
  rootPath: string;
  rootNodePath: string;
  startedAt: string;
  finishedAt: string | null;
  maxDepth: number;
  includeHidden: boolean;
  entriesScanned: number;
  dirsScanned: number;
  filesScanned: number;
  bytesScanned: number;
  errors: ScanError[];
  error: string | null;
  errorCode: ScanMeta["errorCode"];
  cancelled: boolean;
  /** Ends the scan now (set by scanTree while it runs). */
  abort: (() => void) | null;
  dirs: Map<string, ScanNode>;
  snapshotTimer: ReturnType<typeof setTimeout> | null;
  snapshotWrite: Promise<void>;
  lastBroadcastAt: number;
  lastLogAt: number;
}

export interface CreateScanPayload {
  rootPath?: string;
  maxDepth?: number;
  includeHidden?: boolean;
}

interface ScanOptions {
  maxDepth: number;
  includeHidden: boolean;
  workers: number;
}

export const jobs = new Map<string, ScanJob>();
// Final metas whose snapshot write failed (typically ENOSPC: the scan store
// shares a disk with what is being scanned). Served from memory for the rest
// of this process so the UI sees the real outcome, not a stale "running".
const unpersistedMetas = new Map<string, ScanMeta>();

export function makeMeta(job: ScanJob): ScanMeta {
  return {
    id: job.id,
    status: job.status,
    rootPath: job.rootPath,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    maxDepth: job.maxDepth,
    includeHidden: job.includeHidden,
    error: job.error,
    errorCode: job.errorCode,
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

function makeNode(absPath: string, parentPath: string, stats: { size: number; mtimeMs: number }, kind: ScanNode["kind"]): ScanNode {
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

async function writeSnapshot(job: ScanJob, options: { includeDirs?: boolean } = {}): Promise<void> {
  await fsp.mkdir(scanDir(job.id), { recursive: true });
  const writes: Array<[string, unknown]> = [
    [snapshotPath(job.id), makeMeta(job)],
    [errorsPath(job.id), job.errors.slice(-1000)]
  ];
  // Serializing the full dirs map is O(total directories); doing it on the
  // periodic snapshot made large scans quadratic. Live folder views read
  // job.dirs from memory (getScanStore), so dirs.json is only needed once the
  // scan settles — write it on the final snapshot only.
  if (options.includeDirs) {
    writes.push([dirsPath(job.id), Array.from(job.dirs.values())]);
  }
  await Promise.all(
    writes.map(async ([target, payload]) => {
      const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(payload));
      await fsp.rename(tmp, target);
    })
  );
}

function queueSnapshotWrite(job: ScanJob, options: { includeDirs?: boolean } = {}): Promise<void> {
  job.snapshotWrite = job.snapshotWrite.catch(() => {}).then(() => writeSnapshot(job, options));
  return job.snapshotWrite;
}

function scheduleSnapshot(job: ScanJob): void {
  if (job.snapshotTimer) return;
  job.snapshotTimer = setTimeout(() => {
    job.snapshotTimer = null;
    queueSnapshotWrite(job).catch((error: Error) => {
      job.error = error.message;
      broadcastScan(job);
    });
  }, 1200);
}

function broadcastScan(job: ScanJob): void {
  const now = Date.now();
  if (job.lastBroadcastAt && now - job.lastBroadcastAt < 600 && job.status === "running") return;
  job.lastBroadcastAt = now;
  broadcast({ type: "scan:update", scan: makeMeta(job) });
}

function broadcastLog(job: ScanJob, level: "info" | "scan" | "warn" | "error" | "success", message: string, details: Record<string, unknown> = {}): void {
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

function recordError(job: ScanJob, absPath: string, error: NodeJS.ErrnoException): void {
  job.errors.push({
    path: absPath,
    code: error?.code || "ERROR",
    message: error?.message || String(error)
  });
  if (job.errors.length > 1000) job.errors.splice(0, job.errors.length - 1000);
}

// ===== Batched NDJSON writer =====
// The previous implementation ran mkdir+appendFile twice per node (~600k
// syscalls for a 100k-entry tree) and was the dominant scan cost. This writer
// buffers lines in memory and flushes each touched file once per interval;
// since a directory's children arrive as one worker batch, each
// children/<hash>.ndjson is typically written exactly once per scan.
//
// The appends run as sync calls on a dedicated worker thread. As fsp calls,
// one flush queued thousands of appendFile on the shared libuv threadpool
// every 250 ms, and every file read the UI waits on (folder listings, the
// app's own index.html) sat behind them: p95 87-148 ms, max 0.5 s mid-scan.
const WRITER_WORKER_SOURCE = `
const { parentPort } = require("worker_threads");
const fs = require("fs");
parentPort.on("message", (writes) => {
  try {
    for (const [target, data] of writes) fs.appendFileSync(target, data);
    parentPort.postMessage(null);
  } catch (error) {
    parentPort.postMessage({ message: error.message, code: error.code });
  }
});
`;

class ScanWriter {
  private nodeLines: string[] = [];
  private childrenLines = new Map<string, string[]>();
  private bufferedBytes = 0;
  private writingBytes = 0;
  /** Called after each flush lands, so a scan paused on backlog can resume. */
  onDrain: () => void = () => {};
  private flushChain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval>;
  /** First failed write (e.g. ENOSPC). Fire-and-forget flushes must not
   * reject unhandled — the crash handler would exit the whole server and
   * leave the scan's snapshot stuck at "running". scanTree polls this. */
  error: Error | null = null;
  private readonly onError: (error: Error) => void;
  private readonly worker: Worker;
  /** Settles the flush the worker is writing; flushes run one at a time. */
  private inFlight: { resolve: () => void; reject: (error: Error) => void } | null = null;

  constructor(private readonly scanId: string, onError: (error: Error) => void = () => {}) {
    this.onError = onError;
    this.worker = new Worker(WRITER_WORKER_SOURCE, { eval: true });
    this.worker.on("message", (failure: { message: string; code?: string } | null) => {
      const pending = this.inFlight;
      this.inFlight = null;
      if (!failure) pending?.resolve();
      else pending?.reject(Object.assign(new Error(failure.message), { code: failure.code }));
    });
    this.worker.on("error", (error: Error) => {
      const pending = this.inFlight;
      this.inFlight = null;
      pending?.reject(error);
    });
    this.timer = setInterval(() => this.flushSafely(), 250);
  }

  private write(writes: Array<[string, string]>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.inFlight = { resolve, reject };
      this.worker.postMessage(writes);
    });
  }

  private flushSafely(): void {
    this.flush().catch((error: Error) => {
      if (this.error) return;
      this.error = error;
      this.onError(error);
    });
  }

  add(node: ScanNode, parentPath: string | null): void {
    this.addBlob(`${JSON.stringify(node)}\n`, parentPath);
  }

  /** Append a pre-serialized NDJSON chunk (one or many lines, one parent). */
  addBlob(blob: string, parentPath: string | null): void {
    if (!blob) return;
    this.nodeLines.push(blob);
    this.bufferedBytes += blob.length;
    if (parentPath !== null) {
      const target = childrenPath(this.scanId, parentPath);
      let lines = this.childrenLines.get(target);
      if (!lines) {
        lines = [];
        this.childrenLines.set(target, lines);
      }
      lines.push(blob);
      this.bufferedBytes += blob.length;
    }
    if (this.bufferedBytes >= 8 * 1024 * 1024) this.flushSafely();
  }

  /** Bytes produced but not yet on disk (buffered plus being written). */
  get backlogBytes(): number {
    return this.bufferedBytes + this.writingBytes;
  }

  flush(): Promise<void> {
    if (!this.nodeLines.length && !this.childrenLines.size) return this.flushChain;
    const nodeLines = this.nodeLines;
    const childrenLines = this.childrenLines;
    const size = this.bufferedBytes;
    this.nodeLines = [];
    this.childrenLines = new Map();
    this.bufferedBytes = 0;
    this.writingBytes += size;

    this.flushChain = this.flushChain.catch(() => {}).then(async () => {
      try {
        const writes: Array<[string, string]> = [];
        if (nodeLines.length) writes.push([nodesPath(this.scanId), nodeLines.join("")]);
        for (const [target, lines] of childrenLines) {
          writes.push([target, lines.join("")]);
        }
        await this.write(writes);
      } finally {
        this.writingBytes -= size;
        this.onDrain();
      }
    });
    return this.flushChain;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    try {
      await this.flush();
    } finally {
      await this.worker.terminate();
    }
    if (this.error) throw this.error;
  }
}

interface WorkerDirMessage {
  type: "dir";
  taskId: number;
  dirPath: string;
  /** Pre-serialized NDJSON lines for every entry in this chunk. */
  blob: string;
  /** Directory entries only — the ones the main thread must track. */
  dirEntries: Array<{ name: string; mtimeMs: number }>;
  entryCount: number;
  fileCount: number;
  fileBytes: number;
  entryErrors: ScanError[];
  dirError: { code: string; message: string } | null;
  done: boolean;
}

const WORKER_INBOX_LIMIT = 16;
// Workers enumerate far faster than the store can be written (a / scan on a
// Mac produced 6M entries in 20 s against 21 MB written and the heap hit
// 4 GB). Stop handing out directories while this much is still unwritten.
const WRITE_BACKLOG_LIMIT = 64 * 1024 * 1024;
const DISPATCH_BATCH = 1;

function workerScriptPath(): string {
  // Plain-JS worker lives next to this module in both dev (server/) and
  // compiled (dist-server/server/) layouts.
  return path.join(__dirname, "scan-worker.js");
}

async function scanTree(job: ScanJob, options: ScanOptions): Promise<void> {
  // Root node is scanned inline; the worker pool handles all descendants.
  const rootStats = await fsp.lstat(job.rootPath);
  const rootNode = makeNode(job.rootPath, "", rootStats, inferKind(rootStats));
  job.rootNodePath = rootNode.path;
  job.entriesScanned += 1;

  let failWrite: (error: Error) => void = () => {};
  const writer = new ScanWriter(job.id, (error) => failWrite(error));
  writer.add(rootNode, null);

  if (rootNode.kind !== "directory" || options.maxDepth < 1) {
    await writer.close();
    return;
  }
  job.dirs.set(rootNode.path, rootNode);

  const workerCount = options.workers;
  const workers: Worker[] = [];
  const outstanding: number[] = new Array(workerCount).fill(0);
  const queue: Array<{ dirPath: string; depth: number }> = [{ dirPath: rootNode.path, depth: 0 }];
  let inFlight = 0;
  let nextTaskId = 1;

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = async (error?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(spaceWatch);
      await Promise.all(workers.map((worker) => worker.terminate().catch(() => {})));
      const writeError = await writer.close().then(
        () => null,
        (closeError: Error) => closeError
      );
      error = error || writeError || undefined;
      if (error) reject(error);
      else resolve();
    };

    failWrite = (error) => void finish(error);
    // Stop terminates the workers right away instead of letting each finish
    // the directories already queued to it (up to 16 apiece, some huge).
    job.abort = () => void finish(new ScanCancelled());
    writer.onDrain = () => {
      if (settled) return;
      if (!job.cancelled) {
        dispatch();
        return;
      }
      // Cancelled while paused on backlog with nothing in flight: no worker
      // message will arrive to finish it, so finish here.
      queue.length = 0;
      if (inFlight === 0) void finish(new ScanCancelled());
    };

    // Stop before the drive fills: scan data usually lands on the drive being
    // scanned, and running it to ENOSPC breaks other programs too.
    const spaceWatch = setInterval(() => {
      freeBytes(SCAN_ROOT)
        .then((free) => {
          if (free < MIN_FREE_WHILE_RUNNING) void finish(new InsufficientSpaceError(SCAN_ROOT, free, MIN_FREE_WHILE_RUNNING));
        })
        .catch(() => {});
    }, 2000);

    const propagateSize = (fromPath: string, bytes: number) => {
      if (!bytes) return;
      job.bytesScanned += bytes;
      let current: ScanNode | undefined = job.dirs.get(fromPath);
      while (current) {
        current.size += bytes;
        current = current.parentPath ? job.dirs.get(current.parentPath) : undefined;
      }
    };

    const propagateErrors = (fromPath: string, count: number) => {
      if (!count) return;
      let current: ScanNode | undefined = job.dirs.get(fromPath);
      while (current) {
        current.errorCount += count;
        current = current.parentPath ? job.dirs.get(current.parentPath) : undefined;
      }
    };

    const dirDepth = new Map<number, number>();

    const dispatch = () => {
      while (queue.length) {
        if (writer.backlogBytes > WRITE_BACKLOG_LIMIT) return; // resumed by writer.onDrain
        let target = -1;
        for (let index = 0; index < workerCount; index += 1) {
          if ((outstanding[index] as number) < WORKER_INBOX_LIMIT && (target === -1 || (outstanding[index] as number) < (outstanding[target] as number))) {
            target = index;
          }
        }
        if (target === -1) return;
        const tasks: Array<{ taskId: number; dirPath: string }> = [];
        const batch = Math.min(DISPATCH_BATCH, WORKER_INBOX_LIMIT - (outstanding[target] as number), queue.length);
        for (let taken = 0; taken < batch; taken += 1) {
          const task = queue.pop() as { dirPath: string; depth: number };
          dirDepth.set(nextTaskId, task.depth);
          tasks.push({ taskId: nextTaskId, dirPath: task.dirPath });
          nextTaskId += 1;
        }
        outstanding[target] = (outstanding[target] as number) + tasks.length;
        inFlight += tasks.length;
        (workers[target] as Worker).postMessage({ type: "scan", tasks });
      }
    };

    const handleMessage = (workerIndex: number) => (message: WorkerDirMessage) => {
      if (message.type !== "dir" || settled) return;
      const { dirPath, done } = message;
      const depth = dirDepth.get(message.taskId) ?? 0;
      const parentNode = job.dirs.get(dirPath);

      if (message.dirError) {
        recordError(job, dirPath, message.dirError as NodeJS.ErrnoException);
        broadcastLog(job, "error", `${message.dirError.code} ${dirPath}`, { path: dirPath, code: message.dirError.code });
        if (parentNode) propagateErrors(dirPath, 1);
      }

      if (message.entryCount && parentNode) {
        broadcastLog(job, "scan", dirPath, { path: dirPath, depth });

        writer.addBlob(message.blob, dirPath);
        parentNode.totalChildren += message.entryCount;
        job.entriesScanned += message.entryCount;
        job.filesScanned += message.fileCount;

        for (const entryError of message.entryErrors) {
          job.errors.push(entryError);
        }
        if (job.errors.length > 1000) job.errors.splice(0, job.errors.length - 1000);

        for (const dirEntry of message.dirEntries) {
          const childPath = path.join(dirPath, dirEntry.name);
          job.dirsScanned += 1;
          job.dirs.set(childPath, {
            path: childPath,
            parentPath: dirPath,
            name: dirEntry.name,
            kind: "directory",
            size: 0,
            totalChildren: 0,
            errorCount: 0,
            modifiedAt: dirEntry.mtimeMs
          });
          if (depth + 1 < options.maxDepth) {
            queue.push({ dirPath: childPath, depth: depth + 1 });
          }
        }

        propagateSize(dirPath, message.fileBytes);
        propagateErrors(dirPath, message.entryErrors.length);
      }

      scheduleSnapshot(job);
      broadcastScan(job);

      if (done) {
        dirDepth.delete(message.taskId);
        outstanding[workerIndex] = (outstanding[workerIndex] as number) - 1;
        inFlight -= 1;

        if (job.cancelled) {
          queue.length = 0;
          if (inFlight === 0) void finish(new ScanCancelled());
          return;
        }

        dispatch();
        if (inFlight === 0 && queue.length === 0) void finish();
      }
    };

    for (let index = 0; index < workerCount; index += 1) {
      const worker = new Worker(workerScriptPath(), {
        workerData: { includeHidden: options.includeHidden }
      });
      worker.on("message", handleMessage(index));
      worker.on("error", (error) => void finish(error instanceof Error ? error : new Error(String(error))));
      workers.push(worker);
    }

    dispatch();
  });
}

export async function createScanJob(payload: CreateScanPayload): Promise<ScanJob> {
  const rootPath = normalizeScanPath(payload.rootPath);
  const stats = await fsp.stat(rootPath);
  if (!stats.isDirectory()) {
    const error = new Error("Scan path must be a directory") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }

  const options: ScanOptions = {
    maxDepth: clampInt(payload.maxDepth, 1, 64, 20),
    includeHidden: payload.includeHidden !== false,
    // Measured sweet spot: the main thread (dispatch + persistence) saturates
    // before the workers do, so adding workers past ~8 makes scans slower.
    workers: Math.max(2, Math.min(8, os.cpus().length - 1))
  };

  // Check space before deleting anything, so a refused start keeps the old
  // scan. Older scans are about to be removed, so their space counts as free
  // (removal runs in the background and has not freed it yet).
  const previous = (await listScans()).filter((scan) => scan.status !== "running");
  const sameRoot = previous.find((scan) => scan.rootPath === rootPath && scan.status === "complete");
  const required = Math.max(MIN_FREE_TO_START, sameRoot ? Math.round(estimateStoreBytes(sameRoot) * 1.25) : 0);
  const free = await freeBytes(SCAN_ROOT);
  const reclaimable = previous.reduce((sum, scan) => sum + estimateStoreBytes(scan), 0);
  if (free + reclaimable < required) throw new InsufficientSpaceError(SCAN_ROOT, free, required);

  // Only the latest scan is kept: a full-drive store can take gigabytes on the
  // very disk being scanned (that is how a C:\ scan hit ENOSPC).
  await deleteFinishedScans();

  const id = crypto.randomUUID();
  const job: ScanJob = {
    id,
    status: "running",
    rootPath,
    rootNodePath: rootPath,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    maxDepth: options.maxDepth,
    includeHidden: options.includeHidden,
    entriesScanned: 0,
    dirsScanned: 0,
    filesScanned: 0,
    bytesScanned: 0,
    errors: [],
    error: null,
    errorCode: null,
    cancelled: false,
    abort: null,
    dirs: new Map(),
    snapshotTimer: null,
    snapshotWrite: Promise.resolve(),
    lastBroadcastAt: 0,
    lastLogAt: 0
  };

  await fsp.mkdir(scanDir(id), { recursive: true });
  await fsp.mkdir(childrenRoot(id), { recursive: true });
  await fsp.writeFile(nodesPath(id), "");
  await fsp.writeFile(ownerPath(id), JSON.stringify({ pid: process.pid }));
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
      // Tell the UI first: the final write serializes every directory and
      // takes seconds on a big scan. Reads are served from memory (the job
      // stays in `jobs`) until it lands.
      broadcastLog(job, "success", `finished ${rootPath}`, { path: rootPath });
      broadcastScan(job);
      await queueSnapshotWrite(job, { includeDirs: true }).catch(() => {
        unpersistedMetas.set(id, makeMeta(job));
      });
      cacheDirsForScan(id, job.dirs); // free navigation on the scan just taken
      jobs.delete(id);
    })
    .catch(async (error: Error) => {
      const outOfSpace = error instanceof InsufficientSpaceError || (error as NodeJS.ErrnoException).code === "ENOSPC";
      job.errorCode = outOfSpace ? "INSUFFICIENT_SPACE" : null;
      job.error =
        error instanceof ScanCancelled
          ? "Scan cancelled"
          : outOfSpace
            ? `Stopped: the drive holding scan data (${SCAN_ROOT}) is almost full. Choose another location and scan again.`
            : error.message;
      job.status = error instanceof ScanCancelled ? "cancelled" : "failed";
      job.finishedAt = new Date().toISOString();
      if (job.snapshotTimer) clearTimeout(job.snapshotTimer);
      job.snapshotTimer = null;
      broadcastLog(job, job.status === "cancelled" ? "warn" : "error", `${job.status} ${rootPath}: ${job.error}`, { path: rootPath });
      broadcastScan(job);
      await queueSnapshotWrite(job, { includeDirs: true }).catch(() => {
        unpersistedMetas.set(id, makeMeta(job));
      });
      cacheDirsForScan(id, job.dirs);
      jobs.delete(id);
    });

  return job;
}

export async function cancelJob(id: string): Promise<ScanMeta | null> {
  const job = jobs.get(id);
  // An orphaned "running" snapshot gets settled by the read, so the client
  // receives a non-running meta instead of a 404 it cannot get past.
  if (!job) return readPersistedMeta(id);
  job.cancelled = true;
  job.abort?.();
  return makeMeta(job);
}

// A scan store can be hundreds of thousands of files (one children file per
// directory), so deleting it takes a while. Rename it out of the listing
// first — instant, and the UI updates at once — then remove it in the
// background. Leftovers from a quit mid-delete are swept on startup.
const DELETING_PREFIX = ".deleting-";

// fsp.rm queues one unlink per file on the shared libuv threadpool, so a 1M-file
// store held every thread for minutes and the running scan's writes queued
// behind it: backlog over the limit, dispatch paused, scan frozen. rmSync in a
// worker unlinks on that worker's own thread and never touches the pool.
// Removals run one at a time so several stores don't contend for the disk.
let removals: Promise<void> = Promise.resolve();

function removeInBackground(target: string): void {
  removals = removals.then(
    () =>
      new Promise<void>((resolve) => {
        const worker = new Worker(
          `require("fs").rmSync(require("worker_threads").workerData, { recursive: true, force: true });`,
          { eval: true, workerData: target }
        );
        worker.on("error", (error: Error) => console.error(`Failed to remove ${target}: ${error.message}`));
        worker.on("exit", () => resolve());
      })
  );
}

export async function deleteScan(id: string): Promise<void> {
  // 404s for unknown scans; "running" covers live scans in other processes too.
  if (jobs.has(id) && jobs.get(id)?.status !== "running") {
    const error = new Error("The scan is still being saved; try again in a moment") as ScanNotFoundError;
    error.statusCode = 409;
    throw error;
  }
  if ((await getScanMeta(id)).status === "running") {
    const error = new Error("Cancel the scan before deleting it") as ScanNotFoundError;
    error.statusCode = 409;
    throw error;
  }
  const target = path.join(SCAN_ROOT, `${DELETING_PREFIX}${id}`);
  await fsp.rename(scanDir(id), target);
  dirsCache.delete(id);
  unpersistedMetas.delete(id);
  broadcast({ type: "scan:deleted", scanId: id });
  removeInBackground(target);
}

/** Deletes every saved scan except running ones; returns the ids removed. */
export async function deleteFinishedScans(except: string | null = null): Promise<string[]> {
  const removed: string[] = [];
  for (const scan of await listScans()) {
    if (scan.id === except || scan.status === "running") continue;
    try {
      await deleteScan(scan.id);
      removed.push(scan.id);
    } catch (error) {
      console.error(`Failed to delete scan ${scan.id}: ${(error as Error).message}`);
    }
  }
  return removed;
}

async function writeAtomic(target: string, data: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, target);
}

export interface TrashApplied {
  freedBytes: number;
  scan: ScanMeta;
}

// Commits read-modify-write the same children files and dirs.json; one at a time.
let trashApplies: Promise<unknown> = Promise.resolve();

/**
 * Takes paths that just went to Trash out of a scan: subtracts each one's size
 * from every folder above it and from the scan totals, drops trashed folders
 * from the dirs map, and records the paths so listings and the nodes.ndjson
 * readers skip them. A settled scan also gets its parent children files,
 * dirs.json and meta rewritten. A scan still running or saving is edited in
 * memory (job.dirs and its counters), which its final snapshot then writes;
 * its children files are left alone because the writer may still append.
 * Returns null when nothing in the scan matched.
 */
export function applyTrashToScan(id: string, paths: string[]): Promise<TrashApplied | null> {
  const run = trashApplies.catch(() => {}).then(() => applyTrash(id, paths));
  trashApplies = run;
  return run;
}

async function applyTrash(id: string, paths: string[]): Promise<TrashApplied | null> {
  const job = jobs.get(id);
  const meta = job ? makeMeta(job) : await readPersistedMeta(id);
  if (!meta) return null;
  const dirs = job ? job.dirs : await loadDirsMap(id);

  const requested = new Set(paths);
  // A path inside another trashed folder is already counted by that folder.
  const isInsideRequested = (absPath: string) => {
    for (let current = path.dirname(absPath); ; current = path.dirname(current)) {
      if (requested.has(current)) return true;
      if (path.dirname(current) === current) return false;
    }
  };
  const targets = [...requested].filter((target) => target !== meta.rootPath && !isInsideRequested(target));

  const byParent = new Map<string, Set<string>>();
  for (const target of targets) {
    const parent = path.dirname(target);
    const set = byParent.get(parent) ?? new Set<string>();
    set.add(target);
    byParent.set(parent, set);
  }

  let freedBytes = 0;
  let removedEntries = 0;
  const removed: string[] = [];
  const removedDirs = new Set<string>();
  for (const [parent, wanted] of byParent) {
    const file = childrenPath(id, parent);
    const records = await readNdjson<ScanNode>(file);
    const kept = records.filter((record) => !wanted.has(record.path));
    if (kept.length === records.length) continue;
    for (const record of records) {
      if (!wanted.has(record.path)) continue;
      // Directory records keep the size they had when listed (0); the
      // propagated total lives in dirs.json.
      const size = record.kind === "directory" ? dirs.get(record.path)?.size ?? record.size ?? 0 : record.size || 0;
      for (let folder = dirs.get(parent); folder; folder = folder.parentPath ? dirs.get(folder.parentPath) : undefined) {
        folder.size = Math.max(0, folder.size - size);
      }
      freedBytes += size;
      removedEntries += 1;
      removed.push(record.path);
      if (record.kind === "directory") removedDirs.add(record.path);
    }
    const parentNode = dirs.get(parent);
    if (parentNode) parentNode.totalChildren = Math.max(0, parentNode.totalChildren - (records.length - kept.length));
    if (!job) await writeAtomic(file, kept.map((record) => `${JSON.stringify(record)}\n`).join(""));
  }
  if (!removed.length) return null;

  // One pass drops every trashed folder and everything below it.
  let dirsRemoved = 0;
  if (removedDirs.size) {
    for (const [dirPath, dir] of dirs) {
      let inside = false;
      for (let current = dirPath; ; current = path.dirname(current)) {
        if (removedDirs.has(current)) {
          inside = true;
          break;
        }
        if (path.dirname(current) === current) break;
      }
      if (!inside) continue;
      removedEntries += dir.totalChildren;
      dirsRemoved += 1;
      dirs.delete(dirPath);
    }
  }

  if (job) {
    job.bytesScanned = Math.max(0, job.bytesScanned - freedBytes);
    job.entriesScanned = Math.max(0, job.entriesScanned - removedEntries);
    job.dirsScanned = Math.max(0, job.dirsScanned - dirsRemoved);
    job.filesScanned = Math.max(0, job.filesScanned - (removedEntries - dirsRemoved));
    await addTrashed(id, removed);
    // Saving already (complete, final write queued): its dirs.json may have
    // been serialized before these edits, so write the dirs map once more.
    if (job.status !== "running") await queueSnapshotWrite(job, { includeDirs: true }).catch(() => {});
    return { freedBytes, scan: makeMeta(job) };
  }

  const progress = meta.progress;
  const updated: ScanMeta = {
    ...meta,
    progress: {
      ...progress,
      bytesScanned: Math.max(0, progress.bytesScanned - freedBytes),
      entriesScanned: Math.max(0, progress.entriesScanned - removedEntries),
      dirsScanned: Math.max(0, progress.dirsScanned - dirsRemoved),
      filesScanned: Math.max(0, progress.filesScanned - (removedEntries - dirsRemoved))
    }
  };
  await Promise.all([
    writeAtomic(dirsPath(id), JSON.stringify(Array.from(dirs.values()))),
    writeAtomic(snapshotPath(id), JSON.stringify(updated)),
    addTrashed(id, removed)
  ]);
  if (unpersistedMetas.has(id)) unpersistedMetas.set(id, updated);
  return { freedBytes, scan: updated };
}

export async function sweepDeletedScans(): Promise<void> {
  const entries = await fsp.readdir(SCAN_ROOT, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(DELETING_PREFIX)) {
      removeInBackground(path.join(SCAN_ROOT, entry.name));
    }
  }
}

export async function getStorageSettings(): Promise<StorageSettings> {
  return { scanRoot: SCAN_ROOT, defaultScanRoot: DEFAULT_SCAN_ROOT, freeBytes: await freeBytes(SCAN_ROOT) };
}

/**
 * Moves scan storage to `folder` (null = default). Scans at the old location
 * are deleted rather than moved: only the latest scan is kept anyway, and
 * copying gigabytes across drives is what the user is trying to avoid.
 */
export async function changeStorageLocation(folder: string | null): Promise<StorageSettings> {
  if ([...jobs.values()].some((job) => job.status === "running")) {
    const error = new Error("Wait for the running scan to finish or cancel it first") as ScanNotFoundError;
    error.statusCode = 409;
    throw error;
  }
  const oldScans = await listScans();
  const previousRoot = await setScanRoot(folder);
  if (previousRoot !== SCAN_ROOT) {
    for (const scan of oldScans) {
      dirsCache.delete(scan.id);
      unpersistedMetas.delete(scan.id);
      broadcast({ type: "scan:deleted", scanId: scan.id });
      removeInBackground(path.join(previousRoot, scan.id));
    }
  }
  return getStorageSettings();
}

export async function listScans(): Promise<ScanMeta[]> {
  await fsp.mkdir(SCAN_ROOT, { recursive: true });
  const entries = await fsp.readdir(SCAN_ROOT, { withFileTypes: true });
  const scans: ScanMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(DELETING_PREFIX)) continue;
    try {
      scans.push(await getScanMeta(entry.name));
    } catch {
      // Ignore incomplete temp folders.
    }
  }
  return scans.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export interface ScanNotFoundError extends Error {
  statusCode: number;
}

function notFound(): ScanNotFoundError {
  const error = new Error("Scan not found") as ScanNotFoundError;
  error.statusCode = 404;
  return error;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function runningElsewhere(id: string): Promise<boolean> {
  const owner = await readJsonFile<{ pid?: number } | null>(ownerPath(id), null);
  const pid = owner?.pid;
  return typeof pid === "number" && pid !== process.pid && isProcessAlive(pid);
}

// A snapshot still saying "running" whose owning process is gone belongs
// to a scan whose app was quit or crashed mid-run. Left as is, the UI treats it
// as in progress forever (Start disabled, Cancel 404s), even across restarts,
// so settle it as failed and persist that.
async function readPersistedMeta(id: string): Promise<ScanMeta | null> {
  const unpersisted = unpersistedMetas.get(id);
  if (unpersisted) return unpersisted;
  const meta = await readJsonFile<ScanMeta | null>(snapshotPath(id), null);
  if (!meta || meta.status !== "running" || jobs.has(id)) return meta;
  if (await runningElsewhere(id)) return meta;
  const settled: ScanMeta = {
    ...meta,
    status: "failed",
    error: "Interrupted: the app was closed while this scan was running",
    finishedAt: meta.finishedAt || new Date().toISOString()
  };
  const tmp = `${snapshotPath(id)}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp
    .writeFile(tmp, JSON.stringify(settled))
    .then(() => fsp.rename(tmp, snapshotPath(id)))
    .catch(() => {});
  return settled;
}

export async function getScanMeta(id: string): Promise<ScanMeta> {
  const active = jobs.get(id);
  if (active) return makeMeta(active);
  const meta = await readPersistedMeta(id);
  if (!meta) throw notFound();
  return meta;
}

interface ScanStore {
  meta: ScanMeta;
  dirs: Map<string, ScanNode> | null;
  errors: ScanError[];
  active: boolean;
}

export async function getScanStore(id: string): Promise<ScanStore> {
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
    readPersistedMeta(id),
    readJsonFile<ScanError[]>(errorsPath(id), [])
  ]);
  if (!meta) throw notFound();
  return { meta, dirs: null, errors, active: false };
}

function enrichNode(node: ScanNode | null, dirMap: Map<string, ScanNode> | null): ScanNode | null {
  if (!node) return null;
  if (!dirMap) return node;
  if (node.kind !== "directory") return node;
  return dirMap.get(node.path) || node;
}

function fallbackDirectoryNode(absPath: string, meta: ScanMeta): ScanNode {
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

// Parsed dirs.json for finished scans, keyed by scan id. Streaming the file
// per navigation request was O(file size) per click — 60s+ on multi-million
// entry scans. Parsing once and caching makes navigation O(1) after a single
// load; one slot is enough because the UI navigates one scan at a time.
const DIRS_CACHE_MAX = 1;
const dirsCache = new Map<string, Map<string, ScanNode>>();
const dirsCacheLoads = new Map<string, Promise<Map<string, ScanNode>>>();

export function cacheDirsForScan(id: string, dirs: Map<string, ScanNode>): void {
  dirsCache.delete(id);
  dirsCache.set(id, dirs);
  while (dirsCache.size > DIRS_CACHE_MAX) {
    const oldest = dirsCache.keys().next().value;
    if (oldest === undefined) break;
    dirsCache.delete(oldest);
  }
}

export function loadDirsMap(id: string): Promise<Map<string, ScanNode>> {
  const cached = dirsCache.get(id);
  if (cached) {
    cacheDirsForScan(id, cached); // refresh LRU position
    return Promise.resolve(cached);
  }
  // Coalesce concurrent requests so a burst of clicks parses the file once.
  const pending = dirsCacheLoads.get(id);
  if (pending) return pending;
  const load = (async () => {
    try {
      const list = await readJsonFile<ScanNode[]>(dirsPath(id), []);
      const map = new Map(list.map((node) => [node.path, node]));
      cacheDirsForScan(id, map);
      return map;
    } finally {
      dirsCacheLoads.delete(id);
    }
  })();
  dirsCacheLoads.set(id, load);
  return load;
}

export async function nodesToFolderPayload(id: string, requestedPath: string | null): Promise<FolderPayload> {
  const store = await getScanStore(id);
  const rootPath = store.meta.rootPath;
  const currentPath = requestedPath || rootPath;
  let node: ScanNode | null = store.dirs?.get(currentPath) || null;
  // Children files of a scan that was running when something went to Trash
  // still list it; skip those (settled scans have them rewritten).
  const isTrashed = await trashedFilter(id);
  const childRecords = (await readNdjson<ScanNode>(childrenPath(id, currentPath))).filter((record) => !isTrashed(record.path));
  let dirLookup = store.dirs;

  if (!dirLookup) {
    dirLookup = await loadDirsMap(id);
    node = dirLookup.get(currentPath) || node;
  }

  if (!node) node = fallbackDirectoryNode(currentPath, store.meta);
  node.totalChildren = childRecords.length || node.totalChildren || 0;

  const children = childRecords
    .map((child) => enrichNode(child, dirLookup))
    .filter((item): item is ScanNode => item !== null)
    .sort((a, b) => (b.size || 0) - (a.size || 0));

  return {
    scan: store.meta,
    node,
    children,
    errors: store.errors.slice(-200)
  };
}

function fuzzyScore(text: string, query: string): number {
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
    if (index === 0 || "/-_.".includes(source[index - 1] ?? "")) {
      score += 5;
    }
    lastIndex = index;
  }
  return score;
}

/**
 * Returns the subset of `paths` that are NOT recorded in the scan's node
 * index. Used to scope destructive operations (Trash) to paths the scan
 * actually produced, so the API can't be used against arbitrary files.
 *
 * Each path is looked up in its parent's children file, which holds just that
 * folder's entries. Streaming nodes.ndjson instead took 7-15 s per Move to Bin
 * on a 4M-entry scan (1.4 GB); it remains only as a fallback for paths the
 * children lookup misses.
 */
export async function findPathsMissingFromScan(id: string, paths: string[]): Promise<string[]> {
  const meta = await getScanMeta(id); // 404s for unknown scans
  const wanted = new Set(paths);
  wanted.delete(meta.rootPath); // the root itself is recorded in nodes.ndjson only

  const byParent = new Map<string, string[]>();
  for (const target of wanted) {
    const parent = path.dirname(target);
    const list = byParent.get(parent) ?? [];
    list.push(target);
    byParent.set(parent, list);
  }
  for (const [parent, targets] of byParent) {
    const siblings = await readNdjson<ScanNode>(childrenPath(id, parent));
    const recorded = new Set(siblings.map((node) => node.path));
    for (const target of targets) {
      if (recorded.has(target)) wanted.delete(target);
    }
  }
  if (!wanted.size) return [];

  const stream = fs.createReadStream(nodesPath(id), "utf8");
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!wanted.size) break;
    if (!line) continue;
    try {
      const node = JSON.parse(line) as ScanNode;
      wanted.delete(node.path);
    } catch {
      // Ignore malformed partial records from interrupted scans.
    }
  }
  stream.destroy();
  return Array.from(wanted);
}

export async function searchScan(id: string, query: string | null, limit = 80): Promise<SearchResponse> {
  const meta = await getScanMeta(id);
  const trimmed = String(query || "").trim();
  const lowered = trimmed.toLowerCase();
  if (!trimmed) return { scan: meta, query: trimmed, results: [] };

  interface Match {
    node: ScanNode;
    score: number;
    rank: number;
  }
  const matches: Match[] = [];

  function compareSearchMatches(a: Match, b: Match): number {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (b.score !== a.score) return b.score - a.score;
    if ((b.node.size || 0) !== (a.node.size || 0)) return (b.node.size || 0) - (a.node.size || 0);
    return a.node.path.localeCompare(b.node.path);
  }

  function consider(node: ScanNode): void {
    const nameLower = node.name.toLowerCase();
    const nameScore = fuzzyScore(node.name, trimmed) * 2;
    const pathScore = fuzzyScore(node.path, trimmed);
    const score = Math.max(nameScore, pathScore);
    if (score <= 0) return;
    const rank = nameLower.startsWith(lowered) ? 0 : 1;
    matches.push({ node, score, rank });
    matches.sort(compareSearchMatches);
    if (matches.length > limit * 4) matches.length = limit * 2;
  }

  const isTrashed = await trashedFilter(id);
  const stream = fs.createReadStream(nodesPath(id), "utf8");
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const node = JSON.parse(line) as ScanNode;
    if (!isTrashed(node.path)) consider(node);
  }

  return {
    scan: meta,
    query: trimmed,
    results: matches.sort(compareSearchMatches).slice(0, limit).map((item) => item.node)
  };
}
