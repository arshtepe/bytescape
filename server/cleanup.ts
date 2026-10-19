import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import readline from "readline";
import crypto from "crypto";
import { execFile } from "child_process";
import type { CleanupResponse, CleanupSuggestion, ScanNode } from "../shared/types";
import { nodesPath } from "./fs-utils";
import { trashedFilter } from "./trashed";
import { classifyFileName } from "./file-classify";
import { getScanMeta, getScanStore, loadDirsMap } from "./scan-engine";

// Everything here is a suggestion the UI can move to Trash in one click, so
// it errs towards missing things rather than offering something that cannot
// be rebuilt. Only `safe` suggestions (rebuildable output, known caches) are
// pre-selected; duplicates, archives and logs are offered for review.

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const LARGE_ARCHIVE_BYTES = 50 * 1024 * 1024;
const DUPLICATE_MIN_BYTES = 1024 * 1024;
const MAX_AGGREGATE_PATHS = 2000;
const MAX_SUGGESTIONS = 100;
const MAX_DUPLICATE_GROUPS_TO_VERIFY = 40;
/** Duplicates are confirmed by hashing whole files; stop once this much has been read. */
const MAX_DUPLICATE_BYTES_TO_HASH = 8 * 1024 * 1024 * 1024;

const HOME = os.homedir();

/** Project output that the project's own tooling recreates. */
interface ProjectOutputRule {
  names: string[];
  reason: string;
  /** Files next to the folder, any of which marks it as a project. */
  markers: string[];
  /** The folder must be git-ignored: names like build/ or dist/ are also used for real sources and assets. */
  requireGitIgnored: boolean;
}

const PROJECT_OUTPUT_RULES: ProjectOutputRule[] = [
  { names: ["node_modules"], reason: "Rebuildable · npm install", markers: ["package.json"], requireGitIgnored: false },
  { names: [".next", ".nuxt"], reason: "Rebuildable · build output", markers: ["package.json"], requireGitIgnored: false },
  { names: ["target"], reason: "Rebuildable · build output", markers: ["Cargo.toml", "pom.xml"], requireGitIgnored: false },
  {
    names: ["build", "dist", "out"],
    reason: "Rebuildable · build output",
    markers: ["package.json", "CMakeLists.txt", "Makefile", "pyproject.toml", "build.gradle", "settings.gradle"],
    requireGitIgnored: true
  }
];

/** Tool caches, by exact location: each is recreated on demand by its tool. */
const KNOWN_CACHES: Array<{ path: string; reason: string }> = [
  { path: path.join(HOME, "Library", "Developer", "Xcode", "DerivedData"), reason: "Xcode cache · rebuilt on next build" },
  { path: path.join(HOME, ".gradle", "caches"), reason: "Gradle cache · downloaded again" },
  { path: path.join(HOME, ".npm", "_cacache"), reason: "npm cache · downloaded again" },
  { path: path.join(HOME, "Library", "Caches", "Homebrew"), reason: "Homebrew cache · downloaded again" },
  { path: path.join(HOME, "Library", "Caches", "pip"), reason: "pip cache · downloaded again" },
  { path: path.join(HOME, ".cache", "pip"), reason: "pip cache · downloaded again" }
];

/** Synced folders: trashing a file there deletes it on every device. */
const CLOUD_FOLDER = /^(Dropbox|Google Drive|OneDrive.*|iCloud Drive.*|Box|Box Sync|pCloud Drive|MEGA)$/i;

function isInsideOrEqual(target: string, dir: string): boolean {
  return target === dir || target.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/**
 * True for paths in the user's own files: inside the home folder, but not in
 * ~/Library or AppData (app data and settings), hidden folders (tool installs
 * such as ~/.nvm or ~/.vscode), app bundles, or cloud-synced folders. Only the
 * folders above `target` are checked, so `.next` itself can still match.
 */
function isUserArea(target: string): boolean {
  if (!isInsideOrEqual(target, HOME) || target === HOME) return false;
  const above = path.relative(HOME, target).split(path.sep).slice(0, -1);
  if (above[0] === "Library" || above[0] === "AppData" || above[0] === "Applications") return false;
  return !above.some((part) => part.startsWith(".") || part.endsWith(".app") || part === "node_modules" || CLOUD_FOLDER.test(part));
}

const LOGS_DIR = path.join(HOME, "Library", "Logs");

/** Old logs: the user area or ~/Library/Logs, never a database's write-ahead log. */
function isSafeLogPath(target: string): boolean {
  if (/[\\/](leveldb|IndexedDB|Local Storage|Session Storage)[\\/]/i.test(target)) return false;
  return isUserArea(target) || isInsideOrEqual(target, LOGS_DIR);
}

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

function displayPath(target: string): string {
  return isInsideOrEqual(target, HOME) ? `~${target.slice(HOME.length)}` : target;
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

/** `git check-ignore`: true only when the folder sits in a git repo that ignores it. */
function isGitIgnored(dir: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["-C", path.dirname(dir), "check-ignore", "-q", dir], { timeout: 5000 }, (error) => resolve(!error));
  });
}

/** SHA-1 of the whole file. Sampling the ends called different files with equal headers (disk images, archives) duplicates. */
async function fullHash(filePath: string): Promise<string | null> {
  try {
    const hash = crypto.createHash("sha1");
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

async function loadDirNodes(id: string): Promise<ScanNode[]> {
  const store = await getScanStore(id);
  if (store.dirs) return Array.from(store.dirs.values());
  return Array.from((await loadDirsMap(id)).values());
}

/**
 * Newest modification time anywhere below each candidate folder (by folder
 * mtimes). A folder's own mtime only changes when its direct entries do, so a
 * node_modules used daily could still look 30 days old.
 */
function newestInside(dirs: ScanNode[], candidates: Set<string>): Map<string, number> {
  const newest = new Map<string, number>();
  if (!candidates.size) return newest;
  for (const dir of dirs) {
    const modifiedAt = dir.modifiedAt || 0;
    for (let current = dir.path; ; ) {
      if (candidates.has(current) && modifiedAt > (newest.get(current) || 0)) newest.set(current, modifiedAt);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return newest;
}

async function findProjectOutputSuggestions(dirs: ScanNode[]): Promise<CleanupSuggestion[]> {
  const sortedByDepth = [...dirs].sort((a, b) => a.path.length - b.path.length);
  const matched = new Set<string>();
  const isNestedInMatched = makeAncestorChecker(matched);
  const candidates: Array<{ dir: ScanNode; rule: ProjectOutputRule }> = [];

  for (const dir of sortedByDepth) {
    if (!dir.size || isUnderGit(dir.path) || !isUserArea(dir.path)) continue;
    // Depth-sorted iteration guarantees ancestors were processed first.
    if (isNestedInMatched(dir.path)) continue;
    const rule = PROJECT_OUTPUT_RULES.find((candidate) => candidate.names.includes(dir.name));
    if (!rule) continue;
    if (!(await anyMarkerExists(path.dirname(dir.path), rule.markers))) continue;
    if (rule.requireGitIgnored && !(await isGitIgnored(dir.path))) continue;
    matched.add(dir.path);
    candidates.push({ dir, rule });
  }

  const newest = newestInside(dirs, new Set(candidates.map((item) => item.dir.path)));
  const now = Date.now();
  return candidates
    .filter(({ dir }) => {
      const modifiedAt = newest.get(dir.path) || dir.modifiedAt;
      return Boolean(modifiedAt) && now - (modifiedAt as number) >= THIRTY_DAYS_MS;
    })
    .map(({ dir, rule }) => ({
      id: suggestionId(`cache:${dir.path}`),
      name: dir.name,
      path: dir.path,
      paths: [dir.path],
      size: dir.size,
      reason: rule.reason,
      category: "cache" as const,
      safe: true
    }));
}

function findKnownCacheSuggestions(dirs: ScanNode[]): CleanupSuggestion[] {
  const byPath = new Map(dirs.map((dir) => [dir.path, dir]));
  const suggestions: CleanupSuggestion[] = [];
  for (const cache of KNOWN_CACHES) {
    const dir = byPath.get(cache.path);
    if (!dir || !dir.size) continue;
    suggestions.push({
      id: suggestionId(`known:${cache.path}`),
      name: dir.name,
      path: dir.path,
      paths: [dir.path],
      size: dir.size,
      reason: cache.reason,
      category: "cache",
      safe: true
    });
  }
  return suggestions;
}

interface DuplicateCandidate {
  name: string;
  path: string;
  size: number;
  modifiedAt: number | null;
}

/**
 * Same name and size is only a hint; whole-file hashes decide. The copy kept
 * is the oldest one (then the shortest path), and the suggestion names it in
 * full so the user can see what stays.
 */
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
  let hashedBytes = 0;
  for (const group of groups) {
    const groupBytes = (group[0] as DuplicateCandidate).size * group.length;
    if (hashedBytes + groupBytes > MAX_DUPLICATE_BYTES_TO_HASH) continue;
    hashedBytes += groupBytes;
    const byHash = new Map<string, DuplicateCandidate[]>();
    for (const file of group) {
      const hash = await fullHash(file.path);
      if (!hash) continue;
      const same = byHash.get(hash) ?? [];
      same.push(file);
      byHash.set(hash, same);
    }
    for (const same of byHash.values()) {
      if (same.length < 2) continue;
      const [kept, ...copies] = [...same].sort(
        (a, b) => (a.modifiedAt || Infinity) - (b.modifiedAt || Infinity) || a.path.length - b.path.length
      ) as [DuplicateCandidate, ...DuplicateCandidate[]];
      for (const copy of copies) {
        suggestions.push({
          id: suggestionId(`dup:${copy.path}`),
          name: copy.name,
          path: copy.path,
          paths: [copy.path],
          size: copy.size,
          reason: `Same as ${displayPath(kept.path)}`,
          category: "duplicate",
          safe: false
        });
      }
    }
  }
  return suggestions;
}

function commonParent(paths: string[]): string {
  let common = path.dirname(paths[0] as string);
  for (const target of paths) {
    while (!isInsideOrEqual(target, common)) {
      const parent = path.dirname(common);
      if (parent === common) return common;
      common = parent;
    }
  }
  return common;
}

export async function suggestCleanup(id: string): Promise<CleanupResponse> {
  const meta = await getScanMeta(id);
  const dirs = await loadDirNodes(id);

  const folderSuggestions = [...findKnownCacheSuggestions(dirs), ...(await findProjectOutputSuggestions(dirs))];
  const isInsideSuggestedFolder = makeAncestorChecker(new Set(folderSuggestions.map((item) => item.path)));
  // A known cache can sit inside a project folder suggestion or the other way round; keep the outer one.
  const folders = folderSuggestions.filter(
    (item) => !folderSuggestions.some((other) => other !== item && isInsideOrEqual(item.path, other.path) && item.path !== other.path)
  );

  const duplicateCandidates: DuplicateCandidate[] = [];
  const archiveSuggestions: CleanupSuggestion[] = [];
  let oldLogCount = 0;
  let oldLogBytes = 0;
  const oldLogPaths: string[] = [];

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
    if (isInsideSuggestedFolder(node.path) || isUnderGit(node.path)) continue;

    const classification = classifyFileName(node.name || node.path);
    // A file with no recorded mtime counts as new, never as old.
    const age = node.modifiedAt ? Date.now() - node.modifiedAt : 0;

    if (classification.extension === "log") {
      if (age >= NINETY_DAYS_MS && isSafeLogPath(node.path) && oldLogPaths.length < MAX_AGGREGATE_PATHS) {
        oldLogCount += 1;
        oldLogBytes += node.size || 0;
        oldLogPaths.push(node.path);
      }
      continue;
    }

    if (!isUserArea(node.path)) continue;

    if (classification.type === "archives" && node.size >= LARGE_ARCHIVE_BYTES && age >= NINETY_DAYS_MS) {
      archiveSuggestions.push({
        id: suggestionId(`archive:${node.path}`),
        name: node.name,
        path: node.path,
        paths: [node.path],
        size: node.size,
        reason: `Large archive · ${monthsAgo(node.modifiedAt)} mo old · may be your only copy`,
        category: "other",
        safe: false
      });
      continue;
    }

    if (node.size >= DUPLICATE_MIN_BYTES) {
      duplicateCandidates.push({ name: node.name, path: node.path, size: node.size, modifiedAt: node.modifiedAt });
    }
  }

  const fileDuplicates = await findVerifiedFileDuplicates(duplicateCandidates);

  const suggestions: CleanupSuggestion[] = [...folders, ...archiveSuggestions, ...fileDuplicates];

  if (oldLogPaths.length > 0) {
    suggestions.push({
      id: suggestionId(`logs:${meta.rootPath}`),
      name: `${oldLogCount} old .log file${oldLogCount === 1 ? "" : "s"}`,
      path: commonParent(oldLogPaths),
      paths: oldLogPaths,
      size: oldLogBytes,
      reason: "Old logs · 90+ days",
      category: "other",
      safe: false
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
