import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import readline from "readline";
import crypto from "crypto";
import type { CleanupResponse, CleanupSuggestion, ScanNode } from "../shared/types";
import { nodesPath } from "./fs-utils";
import { trashedFilter } from "./trashed";
import { classifyFileName } from "./file-classify";
import { getScanMeta, getScanStore, loadDirsMap } from "./scan-engine";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const LARGE_ARCHIVE_BYTES = 50 * 1024 * 1024;
const DUPLICATE_MIN_BYTES = 1024 * 1024;
const MAX_AGGREGATE_PATHS = 2000;
const MAX_SUGGESTIONS = 100;
const MAX_DUPLICATE_GROUPS_TO_VERIFY = 40;
const SAMPLE_CHUNK = 64 * 1024;

interface CacheDirRule {
  names: string[];
  reason: string;
  /** Sibling files/dirs, any of which must exist for the rule to apply. Empty = no marker needed. */
  markers: string[];
  /** Only suggest when the directory hasn't changed for 30 days. */
  ageGated: boolean;
}

const CACHE_DIR_RULES: CacheDirRule[] = [
  { names: ["node_modules"], reason: "Rebuildable · npm install", markers: ["package.json"], ageGated: true },
  { names: ["target"], reason: "Rebuildable · build output", markers: ["Cargo.toml", "pom.xml"], ageGated: true },
  {
    names: ["build", "dist", "out", ".next", ".nuxt"],
    reason: "Rebuildable · build output",
    markers: ["package.json", "CMakeLists.txt", "Makefile", "pyproject.toml", "build.gradle", "settings.gradle"],
    ageGated: true
  },
  { names: ["CoreSimulator"], reason: "Unused simulator runtimes", markers: [], ageGated: true },
  { names: ["DerivedData", ".gradle", ".cache"], reason: "Cache · safe to delete", markers: [], ageGated: false }
];

const COPY_NAME_PATTERN = /^(.*?)(?: copy\d*| \(\d+\))$/i;

function isUnderGit(nodePath: string): boolean {
  return nodePath.includes(`${path.sep}.git${path.sep}`) || nodePath.endsWith(`${path.sep}.git`);
}

/**
 * O(path depth) ancestor membership test. The naive `some(startsWith)` per
 * node is O(nodes × matched dirs) — hundreds of millions of string scans on a
 * multi-million-entry scan, which made /cleanup run for minutes.
 */
function makeAncestorChecker(members: Set<string>): (candidate: string) => boolean {
  return (candidate: string): boolean => {
    if (!members.size) return false;
    let current = candidate;
    for (;;) {
      if (members.has(current)) return true;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  };
}

function monthsAgo(modifiedAt: number | null): number {
  if (!modifiedAt) return 0;
  return Math.max(0, Math.round((Date.now() - modifiedAt) / (30 * 24 * 60 * 60 * 1000)));
}

function suggestionId(seed: string): string {
  return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 16);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function anyMarkerExists(parentDir: string, markers: string[]): Promise<boolean> {
  if (!markers.length) return true;
  const checks = await Promise.all(markers.map((marker) => pathExists(path.join(parentDir, marker))));
  return checks.some(Boolean);
}

/** SHA-1 over the first and last 64KB — cheap, order-of-magnitude-confident duplicate confirmation. */
async function sampleHash(filePath: string, size: number): Promise<string | null> {
  try {
    const handle = await fsp.open(filePath, "r");
    try {
      const hash = crypto.createHash("sha1");
      const headLength = Math.min(SAMPLE_CHUNK, size);
      const head = Buffer.alloc(headLength);
      await handle.read(head, 0, headLength, 0);
      hash.update(head);
      if (size > SAMPLE_CHUNK) {
        const tailLength = Math.min(SAMPLE_CHUNK, size - SAMPLE_CHUNK);
        const tail = Buffer.alloc(tailLength);
        await handle.read(tail, 0, tailLength, size - tailLength);
        hash.update(tail);
      }
      return hash.digest("hex");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function loadDirNodes(id: string): Promise<ScanNode[]> {
  const store = await getScanStore(id);
  if (store.dirs) return Array.from(store.dirs.values());
  return Array.from((await loadDirsMap(id)).values());
}

async function findCacheDirSuggestions(dirs: ScanNode[]): Promise<CleanupSuggestion[]> {
  const sortedByDepth = [...dirs].sort((a, b) => a.path.length - b.path.length);
  const matchedPaths = new Set<string>();
  const isNestedInMatched = makeAncestorChecker(matchedPaths);
  const suggestions: CleanupSuggestion[] = [];
  const now = Date.now();

  for (const dir of sortedByDepth) {
    if (!dir.size || isUnderGit(dir.path)) continue;
    // Depth-sorted iteration guarantees ancestors were processed first.
    if (isNestedInMatched(dir.path)) continue;

    const rule = CACHE_DIR_RULES.find((candidate) => candidate.names.includes(dir.name));
    if (!rule) continue;
    if (rule.ageGated && dir.modifiedAt && now - dir.modifiedAt < THIRTY_DAYS_MS) continue;
    if (!(await anyMarkerExists(path.dirname(dir.path), rule.markers))) continue;

    matchedPaths.add(dir.path);
    suggestions.push({
      id: suggestionId(`cache:${dir.path}`),
      name: dir.name,
      path: dir.path,
      paths: [dir.path],
      size: dir.size,
      reason: rule.reason,
      category: "cache"
    });
  }

  return suggestions;
}

/** "china holidays copy" next to "china holidays" → duplicate folder. */
function findCopyNamedDirSuggestions(dirs: ScanNode[], excluded: (p: string) => boolean): CleanupSuggestion[] {
  const byPath = new Map(dirs.map((dir) => [dir.path, dir]));
  const suggestions: CleanupSuggestion[] = [];
  for (const dir of dirs) {
    if (dir.size < DUPLICATE_MIN_BYTES || excluded(dir.path) || isUnderGit(dir.path)) continue;
    const match = dir.name.match(COPY_NAME_PATTERN);
    if (!match || !match[1]) continue;
    const original = byPath.get(path.join(path.dirname(dir.path), match[1]));
    if (!original || original.kind !== "directory") continue;
    suggestions.push({
      id: suggestionId(`dupdir:${dir.path}`),
      name: dir.name,
      path: dir.path,
      paths: [dir.path],
      size: dir.size,
      reason: "Duplicate folder",
      category: "duplicate"
    });
  }
  return suggestions;
}

interface DuplicateCandidate {
  name: string;
  path: string;
  size: number;
}

/** name+size match is only a hint; confirm with content samples before suggesting. */
async function findVerifiedFileDuplicates(candidates: DuplicateCandidate[]): Promise<CleanupSuggestion[]> {
  const byIdentity = new Map<string, DuplicateCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.name.toLowerCase()}::${candidate.size}`;
    const group = byIdentity.get(key);
    if (group) group.push(candidate);
    else byIdentity.set(key, [candidate]);
  }

  const groups = Array.from(byIdentity.values())
    .filter((group) => group.length >= 2)
    .sort((a, b) => (b[0] as DuplicateCandidate).size - (a[0] as DuplicateCandidate).size)
    .slice(0, MAX_DUPLICATE_GROUPS_TO_VERIFY);

  const suggestions: CleanupSuggestion[] = [];
  for (const group of groups) {
    const sorted = [...group].sort((a, b) => a.path.localeCompare(b.path));
    const original = sorted[0] as DuplicateCandidate;
    const originalHash = await sampleHash(original.path, original.size);
    if (!originalHash) continue;
    for (const duplicate of sorted.slice(1)) {
      const duplicateHash = await sampleHash(duplicate.path, duplicate.size);
      if (duplicateHash !== originalHash) continue;
      suggestions.push({
        id: suggestionId(`dup:${duplicate.path}`),
        name: duplicate.name,
        path: duplicate.path,
        paths: [duplicate.path],
        size: duplicate.size,
        reason: `Duplicate of ${path.basename(original.path)}`,
        category: "duplicate"
      });
    }
  }
  return suggestions;
}

export async function suggestCleanup(id: string): Promise<CleanupResponse> {
  const meta = await getScanMeta(id);
  const dirs = await loadDirNodes(id);

  const cacheSuggestions = await findCacheDirSuggestions(dirs);
  const isInsideCacheDir = makeAncestorChecker(new Set(cacheSuggestions.map((item) => item.path)));

  const copyDirSuggestions = findCopyNamedDirSuggestions(dirs, isInsideCacheDir);

  const duplicateCandidates: DuplicateCandidate[] = [];
  const archiveSuggestions: CleanupSuggestion[] = [];
  let oldLogCount = 0;
  let oldLogBytes = 0;
  const oldLogPaths: string[] = [];
  let oldLogTruncated = false;

  const isTrashed = await trashedFilter(id);
  const stream = fs.createReadStream(nodesPath(id), "utf8");
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let node: ScanNode;
    try {
      node = JSON.parse(line) as ScanNode;
    } catch {
      continue;
    }
    if (!node || node.kind !== "file" || isTrashed(node.path)) continue;
    if (isInsideCacheDir(node.path) || isUnderGit(node.path)) continue;

    const classification = classifyFileName(node.name || node.path);
    const age = node.modifiedAt ? Date.now() - node.modifiedAt : 0;

    if (classification.type === "archives" && node.size >= LARGE_ARCHIVE_BYTES && age >= NINETY_DAYS_MS) {
      archiveSuggestions.push({
        id: suggestionId(`archive:${node.path}`),
        name: node.name,
        path: node.path,
        paths: [node.path],
        size: node.size,
        reason: `Large archive · ${monthsAgo(node.modifiedAt)} mo old`,
        category: "cache"
      });
      continue;
    }

    if (classification.extension === "log" && age >= NINETY_DAYS_MS) {
      oldLogCount += 1;
      oldLogBytes += node.size || 0;
      if (oldLogPaths.length < MAX_AGGREGATE_PATHS) oldLogPaths.push(node.path);
      else oldLogTruncated = true;
      continue;
    }

    if (node.size >= DUPLICATE_MIN_BYTES) {
      duplicateCandidates.push({ name: node.name, path: node.path, size: node.size });
    }
  }

  const fileDuplicates = await findVerifiedFileDuplicates(duplicateCandidates);

  const suggestions: CleanupSuggestion[] = [...cacheSuggestions, ...copyDirSuggestions, ...archiveSuggestions, ...fileDuplicates];

  if (oldLogPaths.length > 0) {
    suggestions.push({
      id: suggestionId(`logs:${meta.rootPath}`),
      name: `*.log (${oldLogCount} files)`,
      path: path.dirname(oldLogPaths[0] as string),
      paths: oldLogPaths,
      size: oldLogBytes,
      reason: oldLogTruncated ? `Old logs · 90+ days (first ${oldLogPaths.length})` : "Old logs · 90+ days",
      category: "cache"
    });
  }

  suggestions.sort((a, b) => b.size - a.size);
  const capped = suggestions.slice(0, MAX_SUGGESTIONS);

  // The snapshot may predate deletions — drop suggestions whose primary path
  // no longer exists so the UI never offers to trash a ghost.
  const existence = await Promise.all(capped.map((item) => pathExists(item.path)));
  const alive = capped.filter((_, index) => existence[index]);

  return { scan: meta, generatedAt: new Date().toISOString(), suggestions: alive };
}
