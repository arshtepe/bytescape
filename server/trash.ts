import crypto from "crypto";
import type { TrashJob } from "../shared/types";
import { broadcast } from "./broadcast";
import { applyTrashToScan } from "./scan-engine";

const UNDO_WINDOW_MS = 6000;

// `trash` ships ESM-only. TypeScript downlevels a normal `import()` to
// `require()` under a CommonJS target, which throws ERR_REQUIRE_ESM for this
// package. Going through `new Function` hides the call from that downlevel
// transform so it stays a genuine dynamic import at runtime.
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<{ default: (paths: string[], options?: { glob?: boolean }) => Promise<void> }>;

async function moveToTrash(paths: string[]): Promise<void> {
  const { default: trash } = await dynamicImport("trash");
  // Every path here is a fully-resolved literal filesystem path from the scan
  // index, never a pattern — disable trash's default glob expansion so a
  // filename containing [ ] ( ) ! etc. can't be misinterpreted as a glob.
  await trash(paths, { glob: false });
}

interface InternalTrashJob extends TrashJob {
  timer: ReturnType<typeof setTimeout> | null;
}

const trashJobs = new Map<string, InternalTrashJob>();

function toPublic(job: InternalTrashJob): TrashJob {
  return {
    id: job.id,
    scanId: job.scanId,
    paths: job.paths,
    firesAt: job.firesAt,
    status: job.status,
    error: job.error,
    freedBytes: job.freedBytes
  };
}

function broadcastJob(job: InternalTrashJob): void {
  broadcast({ type: "trash:update", job: toPublic(job) });
}

export function enqueueTrash(scanId: string, paths: string[]): TrashJob {
  const cleanPaths = Array.from(new Set(paths.filter((item): item is string => typeof item === "string" && item.length > 0)));
  const job: InternalTrashJob = {
    id: crypto.randomUUID(),
    scanId,
    paths: cleanPaths,
    firesAt: Date.now() + UNDO_WINDOW_MS,
    status: "pending",
    error: null,
    freedBytes: null,
    timer: null
  };

  job.timer = setTimeout(() => {
    job.timer = null;
    moveToTrash(job.paths)
      .then(async () => {
        // The files are in Trash either way; a failed scan update only means
        // the scan still shows them until the next one.
        const applied = await applyTrashToScan(job.scanId, job.paths).catch((error: Error) => {
          console.error(`Failed to update scan ${job.scanId} after Trash: ${error.message}`);
          return null;
        });
        if (applied) {
          job.freedBytes = applied.freedBytes;
          broadcast({ type: "scan:update", scan: applied.scan });
        }
        job.status = "committed";
        broadcastJob(job);
      })
      .catch((error: Error) => {
        job.status = "failed";
        job.error = error.message;
        broadcastJob(job);
      });
  }, UNDO_WINDOW_MS);

  trashJobs.set(job.id, job);
  broadcastJob(job);
  return toPublic(job);
}

export function cancelTrash(jobId: string): TrashJob | null {
  const job = trashJobs.get(jobId);
  if (!job) return null;
  // No timer while still pending means the move has already started: too late
  // to undo, and reporting "cancelled" would restore a file that is in Trash.
  if (job.status !== "pending" || !job.timer) return toPublic(job);

  clearTimeout(job.timer);
  job.timer = null;
  job.status = "cancelled";
  broadcastJob(job);
  return toPublic(job);
}

export function getTrashJob(jobId: string): TrashJob | null {
  const job = trashJobs.get(jobId);
  return job ? toPublic(job) : null;
}
