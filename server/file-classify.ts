import fs from "fs";
import path from "path";
import readline from "readline";
import type {
  FileCategory,
  FileClassification,
  FileGroup,
  FileGroupsResponse,
  FileRecord,
  FilesForGroupResponse,
  FileTypeSummary,
  ScanNode,
  TopFilesResponse
} from "../shared/types";
import { clampInt, nodesPath } from "./fs-utils";
import { trashedFilter } from "./trashed";
import { getScanMeta } from "./scan-engine";

interface FileTypeDef {
  type: FileCategory;
  label: string;
  extensions: string[];
}

export const FILE_TYPE_DEFS: FileTypeDef[] = [
  { type: "images", label: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "svg", "ico"] },
  { type: "videos", label: "Videos", extensions: ["mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv", "flv", "mpg", "mpeg"] },
  { type: "audio", label: "Audio", extensions: ["mp3", "wav", "flac", "aac", "m4a", "ogg", "opus", "aif", "aiff"] },
  { type: "archives", label: "Archives", extensions: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "dmg", "iso", "pkg"] },
  { type: "documents", label: "Documents", extensions: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key", "rtf", "txt", "md"] },
  {
    type: "code",
    label: "Code",
    extensions: [
      "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "cc", "cpp", "h", "hpp", "cs", "php",
      "sh", "zsh", "bash", "html", "css", "scss", "sass"
    ]
  },
  { type: "data", label: "Data", extensions: ["json", "xml", "yaml", "yml", "csv", "tsv", "sqlite", "sqlite3", "db", "log", "ndjson", "parquet", "avro"] },
  { type: "apps", label: "Apps", extensions: ["app", "exe", "apk", "ipa", "bin", "dylib", "so", "framework"] },
  { type: "other", label: "Other", extensions: [] }
];

const FILE_TYPE_BY_EXTENSION = new Map<string, FileTypeDef>(
  FILE_TYPE_DEFS.flatMap((definition) => definition.extensions.map((extension) => [extension, definition] as const))
);

const OTHER_DEF = FILE_TYPE_DEFS[FILE_TYPE_DEFS.length - 1] as FileTypeDef;

export function classifyFileName(name: string): FileClassification {
  const extension = path.extname(name || "").toLowerCase().replace(/^\./, "");
  const definition = FILE_TYPE_BY_EXTENSION.get(extension) || OTHER_DEF;
  return {
    extension,
    type: definition.type,
    typeLabel: definition.label,
    groupKey: extension ? `${definition.type}:${extension}` : `${definition.type}:no-extension`,
    groupLabel: extension ? `.${extension}` : "No extension"
  };
}

export function normalizeExtensionQuery(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/^\./, "");
}

export function addTopFile(files: FileRecord[], file: FileRecord, limit: number): void {
  files.push(file);
  files.sort((a, b) => {
    if ((b.size || 0) !== (a.size || 0)) return (b.size || 0) - (a.size || 0);
    return a.path.localeCompare(b.path);
  });
  if (files.length > limit) files.length = limit;
}

function toFileRecord(node: ScanNode, classification: FileClassification): FileRecord {
  return {
    path: node.path,
    directory: path.dirname(node.path),
    name: node.name || path.basename(node.path),
    size: node.size || 0,
    modifiedAt: node.modifiedAt || null,
    type: classification.type,
    extension: classification.extension
  };
}

interface FileGroupsOptions {
  type?: string;
  q?: string;
  includeFiles?: boolean | string;
  limit?: unknown;
  groupLimit?: unknown;
}

export async function fileGroupsForScan(id: string, options: FileGroupsOptions = {}): Promise<FileGroupsResponse> {
  const meta = await getScanMeta(id);
  const typeFilter = String(options.type || "all");
  const extensionQuery = normalizeExtensionQuery(options.q);
  const includeFiles = options.includeFiles === true || options.includeFiles === "true";
  const groupLimit = clampInt(options.groupLimit, 1, 300, 80);
  const maxGroups = clampInt(options.limit, 1, 500, 160);

  const groups = new Map<string, FileGroup>();
  const summaries = new Map<FileCategory, FileTypeSummary>(
    FILE_TYPE_DEFS.map((definition) => [definition.type, { type: definition.type, label: definition.label, count: 0, totalSize: 0 }])
  );
  const allSummary: FileTypeSummary = { type: "all", label: "All", count: 0, totalSize: 0 };

  function getGroup(classification: FileClassification): FileGroup {
    let group = groups.get(classification.groupKey);
    if (!group) {
      group = {
        key: classification.groupKey,
        extension: classification.extension,
        label: classification.groupLabel,
        type: classification.type,
        typeLabel: classification.typeLabel,
        count: 0,
        totalSize: 0,
        files: [],
        visibleFiles: 0
      };
      groups.set(classification.groupKey, group);
    }
    return group;
  }

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
      addTopFile(group.files, toFileRecord(node, classification), groupLimit);
    }
  }

  const orderedGroups = Array.from(groups.values())
    .sort((a, b) => {
      if (b.totalSize !== a.totalSize) return b.totalSize - a.totalSize;
      if (b.count !== a.count) return b.count - a.count;
      return a.label.localeCompare(b.label);
    })
    .slice(0, maxGroups)
    .map((group) => ({ ...group, visibleFiles: group.files.length }));

  return {
    scan: meta,
    filter: typeFilter,
    extensionQuery,
    generatedAt: new Date().toISOString(),
    types: [allSummary, ...FILE_TYPE_DEFS.map((definition) => summaries.get(definition.type) as FileTypeSummary)],
    groups: orderedGroups
  };
}

interface FilesForGroupOptions {
  key?: string;
  offset?: unknown;
  limit?: unknown;
}

export async function filesForGroup(id: string, options: FilesForGroupOptions = {}): Promise<FilesForGroupResponse> {
  const meta = await getScanMeta(id);
  const key = String(options.key || "");
  const offset = clampInt(options.offset, 0, 1_000_000, 0);
  const limit = clampInt(options.limit, 1, 200, 50);
  const keep = offset + limit;
  const files: FileRecord[] = [];
  let totalCount = 0;
  let totalSize = 0;
  let group: FilesForGroupResponse["group"] | null = null;

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
    const classification = classifyFileName(node.name || node.path);
    if (classification.groupKey !== key) continue;
    group = {
      key: classification.groupKey,
      extension: classification.extension,
      label: classification.groupLabel,
      type: classification.type,
      typeLabel: classification.typeLabel
    };
    const file = toFileRecord(node, classification);
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

interface TopFilesOptions {
  type?: string;
  q?: string;
  key?: string;
  limit?: unknown;
}

export async function topFilesForScan(id: string, options: TopFilesOptions = {}): Promise<TopFilesResponse> {
  const meta = await getScanMeta(id);
  const typeFilter = String(options.type || "all");
  const extensionQuery = normalizeExtensionQuery(options.q);
  const key = String(options.key || "");
  const limit = clampInt(options.limit, 1, 50, 10);
  const files: FileRecord[] = [];
  let totalCount = 0;
  let totalSize = 0;

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
    const classification = classifyFileName(node.name || node.path);
    if (key && classification.groupKey !== key) continue;
    if (!key && typeFilter !== "all" && classification.type !== typeFilter) continue;
    if (!key && extensionQuery && !classification.extension.includes(extensionQuery)) continue;

    const file = toFileRecord(node, classification);
    totalCount += 1;
    totalSize += file.size;
    addTopFile(files, file, limit);
  }

  return { scan: meta, totalCount, totalSize, files, generatedAt: new Date().toISOString() };
}
