import type {
  CleanupResponse,
  FileGroupsResponse,
  FilesForGroupResponse,
  FolderPayload,
  RootsResponse,
  ScanMeta,
  SearchResponse,
  McpSettings,
  StorageSettings,
  TopFilesResponse,
  TrashResponse
} from "../shared/types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: Record<string, unknown>
  ) {
    super(message);
  }
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) throw new ApiError(payload.error || "Request failed", response.status, payload);
  return payload as T;
}

export function getRoots(): Promise<RootsResponse> {
  return api("/api/roots");
}

export function listScans(): Promise<{ scans: ScanMeta[] }> {
  return api("/api/scans");
}

export function createScan(input: { rootPath: string; maxDepth: number; includeHidden: boolean }): Promise<{ scan: ScanMeta }> {
  return api("/api/scans", { method: "POST", body: JSON.stringify(input) });
}

export function getScan(scanId: string): Promise<{ scan: ScanMeta }> {
  return api(`/api/scans/${scanId}`);
}

export function getFolder(scanId: string, folderPath?: string | null): Promise<FolderPayload> {
  const query = folderPath ? `?path=${encodeURIComponent(folderPath)}` : "";
  return api(`/api/scans/${scanId}/children${query}`);
}

export function searchScan(scanId: string, query: string, limit = 80): Promise<SearchResponse> {
  return api(`/api/scans/${scanId}/search?q=${encodeURIComponent(query)}&limit=${limit}`);
}

export function deleteScan(scanId: string): Promise<{ ok: true }> {
  return api(`/api/scans/${scanId}`, { method: "DELETE" });
}

export function cancelScan(scanId: string): Promise<{ scan: ScanMeta }> {
  return api(`/api/scans/${scanId}/cancel`, { method: "POST" });
}

export function getCleanupSuggestions(scanId: string): Promise<CleanupResponse> {
  return api(`/api/scans/${scanId}/cleanup`);
}

export function trashPaths(scanId: string, paths: string[]): Promise<TrashResponse> {
  return api("/api/trash", { method: "POST", body: JSON.stringify({ scanId, paths }) });
}

export function undoTrash(jobId: string): Promise<TrashResponse> {
  return api(`/api/trash/${jobId}/undo`, { method: "POST" });
}

export function openInFolder(path: string): Promise<{ openedPath: string; mode: string }> {
  return api("/api/open-in-folder", { method: "POST", body: JSON.stringify({ path }) });
}

export function pickFolder(purpose: "scan" | "storage" = "scan"): Promise<{ path: string | null }> {
  return api("/api/pick-folder", { method: "POST", body: JSON.stringify({ purpose }) });
}

export function getStorage(): Promise<StorageSettings> {
  return api("/api/settings/storage");
}

export function setStorage(path: string | null): Promise<StorageSettings> {
  return api("/api/settings/storage", { method: "POST", body: JSON.stringify({ path }) });
}

export interface FileGroupsParams {
  type: string;
  q: string;
  includeFiles?: boolean;
  limit?: number;
  groupLimit?: number;
}

export function getFileGroups(scanId: string, params: FileGroupsParams): Promise<FileGroupsResponse> {
  const search = new URLSearchParams({
    type: params.type,
    q: params.q,
    limit: String(params.limit ?? 240),
    includeFiles: String(params.includeFiles ?? false)
  });
  if (params.groupLimit) search.set("groupLimit", String(params.groupLimit));
  return api(`/api/scans/${scanId}/files?${search.toString()}`);
}

export function getFileGroupFiles(scanId: string, key: string, offset: number, limit = 50): Promise<FilesForGroupResponse> {
  const search = new URLSearchParams({ key, offset: String(offset), limit: String(limit) });
  return api(`/api/scans/${scanId}/files/group?${search.toString()}`);
}

export function getTopFiles(
  scanId: string,
  params: { key?: string; type?: string; q?: string; limit?: number }
): Promise<TopFilesResponse> {
  const search = new URLSearchParams();
  if (params.key) search.set("key", params.key);
  if (params.type) search.set("type", params.type);
  if (params.q) search.set("q", params.q);
  search.set("limit", String(params.limit ?? 10));
  return api(`/api/scans/${scanId}/files/top?${search.toString()}`);
}

export function getMcp(): Promise<McpSettings> {
  return api("/api/settings/mcp");
}

export function setMcp(enabled: boolean): Promise<McpSettings> {
  return api("/api/settings/mcp", { method: "POST", body: JSON.stringify({ enabled }) });
}
