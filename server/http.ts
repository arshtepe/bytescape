import fsp from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import type { IncomingMessage, ServerResponse } from "http";
import type { CreateScanPayload } from "./scan-engine";
import {
  cancelJob,
  changeStorageLocation,
  createScanJob,
  deleteScan,
  findPathsMissingFromScan,
  getScanMeta,
  getStorageSettings,
  listScans,
  makeMeta,
  nodesToFolderPayload,
  searchScan
} from "./scan-engine";
import { fileGroupsForScan, filesForGroup, topFilesForScan } from "./file-classify";
import { suggestCleanup } from "./cleanup";
import { cancelTrash, enqueueTrash } from "./trash";
import { pickFolder } from "./pick-folder";
import { agentPrompt, handleMcpMessage, MCP_DISABLED_CODE, MCP_DISABLED_MESSAGE, reply, type RpcMessage } from "./mcp-tools";
import { clampInt, getContentType, getRootChoices, isMcpEnabled, normalizeScanPath, PROJECT_ROOT, SCAN_ROOT, setMcpEnabled } from "./fs-utils";

const DIST_DIR = path.join(PROJECT_ROOT, "dist");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

/**
 * This server binds to loopback, but that alone doesn't stop browsers: a
 * malicious website can fire cross-origin requests at 127.0.0.1 (CSRF via
 * no-preflight content types) or point an attacker-controlled DNS name at
 * 127.0.0.1 (DNS rebinding, which arrives with a non-loopback Host header).
 * Reject anything whose Host or Origin isn't loopback. A missing Origin is
 * allowed — Electron page loads, curl, and same-origin fetches may omit it.
 */
export function checkBrowserBoundary(req: IncomingMessage): string | null {
  const host = req.headers.host || "";
  try {
    if (!isLoopbackHostname(new URL(`http://${host}`).hostname)) return "Forbidden host";
  } catch {
    return "Forbidden host";
  }

  const origin = req.headers.origin;
  if (origin) {
    try {
      if (!isLoopbackHostname(new URL(origin).hostname)) return "Forbidden origin";
    } catch {
      return "Forbidden origin";
    }
  }
  return null;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  // Requiring JSON forces browsers into a CORS preflight for cross-origin
  // calls (text/plain posts skip it), and we never send CORS headers, so the
  // preflight fails — mutating endpoints become unreachable from web pages.
  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    const error = new Error("Content-Type must be application/json") as Error & { statusCode?: number };
    error.statusCode = 415;
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      // Parse here, not unguarded: a throw inside this event handler is an
      // uncaughtException, and the crash handler exits the whole server.
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch {
        const error = new Error("Invalid JSON body") as Error & { statusCode?: number };
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function openInFileManager(targetPath: string): Promise<{ openedPath: string; mode: "reveal" | "open" }> {
  const normalized = normalizeScanPath(targetPath);
  let stats;
  try {
    stats = await fsp.stat(normalized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const isDirectory = stats?.isDirectory() || false;
  const parentDir = isDirectory ? normalized : path.dirname(normalized);
  const launch = (command: string, args: string[]) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false });
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

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = new URL(req.url || "/", `http://${req.headers.host}`);
  const baseDir = await fsp
    .stat(DIST_DIR)
    .then(() => DIST_DIR)
    .catch(() => PUBLIC_DIR);
  const requested = parsed.pathname === "/" ? "/index.html" : parsed.pathname;
  const decodedPath = decodeURIComponent(requested);
  let filePath = path.normalize(path.join(baseDir, decodedPath));
  // path.relative-based boundary: a bare startsWith(baseDir) lets encoded
  // traversal reach sibling directories sharing the prefix (e.g. dist-server).
  const relative = path.relative(baseDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && baseDir === DIST_DIR) {
      const content = await fsp.readFile(path.join(DIST_DIR, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(content);
      return;
    }
    const code = (error as NodeJS.ErrnoException).code;
    sendJson(res, code === "ENOENT" ? 404 : 500, { error: code === "ENOENT" ? "Not found" : (error as Error).message });
  }
}

export async function router(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const boundaryError = checkBrowserBoundary(req);
    if (boundaryError) {
      sendJson(res, 403, { error: boundaryError });
      return;
    }

    const parsed = new URL(req.url || "/", `http://${req.headers.host}`);

    // MCP over Streamable HTTP, stateless: every POST carries one JSON-RPC
    // message (or a batch) and gets a plain JSON reply. No server-initiated
    // stream, so GET is not offered. Same loopback boundary as the API.
    if (parsed.pathname === "/mcp") {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" }).end();
        return;
      }
      if (!isMcpEnabled()) {
        sendJson(res, 503, reply(null, { error: { code: MCP_DISABLED_CODE, message: MCP_DISABLED_MESSAGE } }));
        return;
      }
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        sendJson(res, statusCode || 400, reply(null, { error: { code: -32700, message: (error as Error).message } }));
        return;
      }
      const messages = (Array.isArray(body) ? body : [body]) as RpcMessage[];
      const replies = (await Promise.all(messages.map(handleMcpMessage))).filter((item) => item !== null);
      if (!replies.length) {
        res.writeHead(202).end(); // notifications only
        return;
      }
      sendJson(res, 200, Array.isArray(body) ? replies : replies[0]);
      return;
    }

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

    if (req.method === "POST" && parsed.pathname === "/api/pick-folder") {
      const payload = await readBody(req); // also enforces the JSON content-type boundary
      const title = payload.purpose === "storage" ? "Choose where to save scan data" : "Choose a folder to scan";
      sendJson(res, 200, { path: await pickFolder(title) });
      return;
    }

    if (parsed.pathname === "/api/settings/mcp") {
      if (req.method === "POST") {
        const payload = await readBody(req);
        if (typeof payload.enabled !== "boolean") {
          sendJson(res, 400, { error: "enabled must be true or false" });
          return;
        }
        await setMcpEnabled(payload.enabled);
      }
      if (req.method === "GET" || req.method === "POST") {
        // The host the UI reached us on is the one agents on this machine use.
        const url = `http://${req.headers.host}/mcp`;
        sendJson(res, 200, {
          enabled: isMcpEnabled(),
          url,
          addCommand: `claude mcp add --transport http disk-scans ${url}`,
          prompt: agentPrompt(url)
        });
        return;
      }
    }

    if (parsed.pathname === "/api/settings/storage") {
      if (req.method === "GET") {
        sendJson(res, 200, await getStorageSettings());
        return;
      }
      if (req.method === "POST") {
        const payload = await readBody(req);
        if (payload.path !== null && (typeof payload.path !== "string" || !path.isAbsolute(payload.path))) {
          sendJson(res, 400, { error: "path must be an absolute folder path, or null for the default location" });
          return;
        }
        sendJson(res, 200, await changeStorageLocation(payload.path as string | null));
        return;
      }
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
      const payload = (await readBody(req)) as CreateScanPayload;
      const job = await createScanJob(payload);
      sendJson(res, 202, { scan: makeMeta(job) });
      return;
    }

    if (req.method === "POST" && parsed.pathname === "/api/trash") {
      const payload = await readBody(req);
      const paths = Array.isArray(payload.paths) ? payload.paths.filter((item): item is string => typeof item === "string") : [];
      const scanId = typeof payload.scanId === "string" ? payload.scanId : "";
      if (!paths.length || !scanId) {
        sendJson(res, 400, { error: "scanId and paths are required" });
        return;
      }
      // Only paths recorded by the referenced scan may be trashed.
      const missing = await findPathsMissingFromScan(scanId, paths);
      if (missing.length) {
        sendJson(res, 403, { error: `Paths not part of scan: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}` });
        return;
      }
      sendJson(res, 202, { job: enqueueTrash(scanId, paths) });
      return;
    }

    const trashUndoMatch = parsed.pathname.match(/^\/api\/trash\/([^/]+)\/undo$/);
    if (trashUndoMatch && req.method === "POST") {
      const jobId = trashUndoMatch[1] as string;
      const job = cancelTrash(jobId);
      if (!job) {
        sendJson(res, 404, { error: "Trash job not found" });
        return;
      }
      sendJson(res, 200, { job });
      return;
    }

    const scanMatch = parsed.pathname.match(/^\/api\/scans\/([^/]+)$/);
    const childrenMatch = parsed.pathname.match(/^\/api\/scans\/([^/]+)\/children$/);
    const searchMatch = parsed.pathname.match(/^\/api\/scans\/([^/]+)\/search$/);
    const cleanupMatch = parsed.pathname.match(/^\/api\/scans\/([^/]+)\/cleanup$/);
    const fileGroupMatch = parsed.pathname.match(/^\/api\/scans\/([^/]+)\/files\/group$/);
    const fileTopMatch = parsed.pathname.match(/^\/api\/scans\/([^/]+)\/files\/top$/);
    const filesMatch = parsed.pathname.match(/^\/api\/scans\/([^/]+)\/files$/);
    const cancelMatch = parsed.pathname.match(/^\/api\/scans\/([^/]+)\/cancel$/);

    if (scanMatch && req.method === "GET") {
      sendJson(res, 200, { scan: await getScanMeta(scanMatch[1] as string) });
      return;
    }

    if (childrenMatch && req.method === "GET") {
      sendJson(res, 200, await nodesToFolderPayload(childrenMatch[1] as string, parsed.searchParams.get("path")));
      return;
    }

    if (searchMatch && req.method === "GET") {
      const limit = clampInt(parsed.searchParams.get("limit"), 1, 200, 80);
      sendJson(res, 200, await searchScan(searchMatch[1] as string, parsed.searchParams.get("q"), limit));
      return;
    }

    if (cleanupMatch && req.method === "GET") {
      sendJson(res, 200, await suggestCleanup(cleanupMatch[1] as string));
      return;
    }

    if (filesMatch && req.method === "GET") {
      sendJson(
        res,
        200,
        await fileGroupsForScan(filesMatch[1] as string, {
          type: parsed.searchParams.get("type") || "all",
          q: parsed.searchParams.get("q") || "",
          includeFiles: parsed.searchParams.get("includeFiles") === "true",
          limit: parsed.searchParams.get("limit"),
          groupLimit: parsed.searchParams.get("groupLimit")
        })
      );
      return;
    }

    if (fileGroupMatch && req.method === "GET") {
      sendJson(
        res,
        200,
        await filesForGroup(fileGroupMatch[1] as string, {
          key: parsed.searchParams.get("key") || "",
          offset: parsed.searchParams.get("offset"),
          limit: parsed.searchParams.get("limit")
        })
      );
      return;
    }

    if (fileTopMatch && req.method === "GET") {
      sendJson(
        res,
        200,
        await topFilesForScan(fileTopMatch[1] as string, {
          key: parsed.searchParams.get("key") || "",
          type: parsed.searchParams.get("type") || "all",
          q: parsed.searchParams.get("q") || "",
          limit: parsed.searchParams.get("limit")
        })
      );
      return;
    }

    if (scanMatch && req.method === "DELETE") {
      await deleteScan(scanMatch[1] as string);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (cancelMatch && req.method === "POST") {
      const scan = await cancelJob(cancelMatch[1] as string);
      if (!scan) {
        sendJson(res, 404, { error: "Scan is not currently running" });
        return;
      }
      sendJson(res, 200, { scan });
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode || 500;
    const details = (error as { details?: Record<string, unknown> }).details;
    sendJson(res, statusCode, { error: (error as Error).message, ...details });
  }
}
