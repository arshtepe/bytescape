import crypto from "crypto";
import fsp from "fs/promises";
import path from "path";
import { readJsonFile, trashedPath } from "./fs-utils";

// Paths moved to Trash after a scan settled. Folder views read the rewritten
// children files and dirs.json, but nodes.ndjson can be gigabytes, so instead of
// rewriting it its readers (search, file types, cleanup) skip anything at or
// under one of these paths.
const cache = new Map<string, string[]>();

export async function readTrashed(id: string): Promise<string[]> {
  const cached = cache.get(id);
  if (cached) return cached;
  const list = await readJsonFile<string[]>(trashedPath(id), []);
  cache.set(id, list);
  return list;
}

export async function addTrashed(id: string, paths: string[]): Promise<void> {
  const list = Array.from(new Set([...(await readTrashed(id)), ...paths]));
  const target = trashedPath(id);
  const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(list));
  await fsp.rename(tmp, target);
  cache.set(id, list);
}

/** Returns a check for "this path, or a folder above it, went to Trash". */
export async function trashedFilter(id: string): Promise<(absPath: string) => boolean> {
  const list = await readTrashed(id);
  if (!list.length) return () => false;
  const trashed = new Set(list);
  return (absPath) => {
    for (let current = absPath; ; ) {
      if (trashed.has(current)) return true;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  };
}
