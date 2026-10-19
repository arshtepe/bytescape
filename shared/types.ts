export type ScanStatus = "running" | "complete" | "cancelled" | "failed";

export type NodeKind = "file" | "directory" | "symlink" | "inaccessible" | "other";

export interface ScanProgress {
  entriesScanned: number;
  dirsScanned: number;
  filesScanned: number;
  bytesScanned: number;
  errors: number;
}

export interface ScanMeta {
  id: string;
  status: ScanStatus;
  rootPath: string;
  startedAt: string;
  finishedAt: string | null;
  /** Depth/hidden params the scan ran with; older snapshots may lack them. */
  maxDepth?: number;
  includeHidden?: boolean;
  error: string | null;
  /** Set when the scan stopped because its storage location ran low on space. */
  errorCode?: "INSUFFICIENT_SPACE" | null;
  progress: ScanProgress;
  storagePath: string;
}

export interface ScanNode {
  path: string;
  parentPath: string;
  name: string;
  kind: NodeKind;
  size: number;
  totalChildren: number;
  errorCount: number;
  modifiedAt: number | null;
}

export interface ScanError {
  path: string;
  code: string;
  message: string;
}

export interface RootChoice {
  label: string;
  path: string;
}

export interface RootsResponse {
  readOnly: true;
  scanStoragePath: string;
  platform: string;
  roots: RootChoice[];
}

export interface FolderPayload {
  scan: ScanMeta;
  node: ScanNode;
  children: ScanNode[];
  errors: ScanError[];
}

export type FileCategory =
  | "images"
  | "videos"
  | "audio"
  | "archives"
  | "documents"
  | "code"
  | "data"
  | "apps"
  | "other";

export interface FileTypeSummary {
  type: FileCategory | "all";
  label: string;
  count: number;
  totalSize: number;
}

export interface FileClassification {
  extension: string;
  type: FileCategory;
  typeLabel: string;
  groupKey: string;
  groupLabel: string;
}

export interface FileRecord {
  path: string;
  directory: string;
  name: string;
  size: number;
  modifiedAt: number | null;
  type: FileCategory;
  extension: string;
}

export interface FileGroup {
  key: string;
  extension: string;
  label: string;
  type: FileCategory;
  typeLabel: string;
  count: number;
  totalSize: number;
  files: FileRecord[];
  visibleFiles: number;
}

export interface FileGroupsResponse {
  scan: ScanMeta;
  filter: string;
  extensionQuery: string;
  generatedAt: string;
  types: FileTypeSummary[];
  groups: FileGroup[];
}

export interface FilesForGroupResponse {
  scan: ScanMeta;
  group: { key: string; extension?: string; label?: string; type?: FileCategory; typeLabel?: string };
  offset: number;
  limit: number;
  totalCount: number;
  totalSize: number;
  files: FileRecord[];
  nextOffset: number | null;
  generatedAt: string;
}

export interface TopFilesResponse {
  scan: ScanMeta;
  totalCount: number;
  totalSize: number;
  files: FileRecord[];
  generatedAt: string;
}

export interface SearchResponse {
  scan: ScanMeta;
  query: string;
  results: ScanNode[];
}

export type CleanupCategory = "duplicate" | "cache" | "other";

export interface CleanupSuggestion {
  id: string;
  name: string;
  /** Representative path shown in the UI. */
  path: string;
  /** Actual filesystem paths this suggestion would move to Trash (usually just [path]). */
  paths: string[];
  size: number;
  reason: string;
  category: CleanupCategory;
  /** Rebuildable output or a known cache: pre-selected for Trash. Others are shown for review only. */
  safe?: boolean;
}

export interface CleanupResponse {
  scan: ScanMeta;
  generatedAt: string;
  suggestions: CleanupSuggestion[];
}

export interface TrashRequest {
  paths: string[];
}

export interface TrashJob {
  id: string;
  scanId: string;
  paths: string[];
  firesAt: number;
  status: "pending" | "committed" | "cancelled" | "failed";
  error: string | null;
  /** Bytes taken out of the scan once committed; null while pending, or when
   * the scan could not be updated (it was still running). */
  freedBytes: number | null;
}

export interface TrashResponse {
  job: TrashJob;
}

export type LogLevel = "info" | "scan" | "warn" | "error" | "success";

export interface LogEntry {
  id: string;
  scanId: string;
  at: string;
  level: LogLevel;
  message: string;
  path?: string;
  code?: string;
}

export type SocketMessage =
  | { type: "hello"; scans: ScanMeta[] }
  | { type: "scan:update"; scan: ScanMeta }
  | { type: "scan:deleted"; scanId: string }
  | { type: "scan:log"; log: LogEntry }
  | { type: "trash:update"; job: TrashJob };

export interface StorageSettings {
  scanRoot: string;
  defaultScanRoot: string;
  freeBytes: number;
}

export interface McpSettings {
  enabled: boolean;
  url: string;
  addCommand: string;
  prompt: string;
}
