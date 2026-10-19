// Read-only MCP tools over saved scans, so agents can query results. They
// read the scan store on disk plus live in-memory jobs, so a scan still
// running shows as "running" with its progress so far.
import type { ScanMeta, ScanNode } from "../shared/types";
import { getScanMeta, listScans, nodesToFolderPayload, searchScan } from "./scan-engine";
import { suggestCleanup } from "./cleanup";
import { fileGroupsForScan, topFilesForScan } from "./file-classify";
import { clampInt, isMcpEnabled, SCAN_ROOT } from "./fs-utils";

export const SERVER_INFO = { name: "bytescape", version: "1.1.0" };
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type Args = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Args) => Promise<unknown>;
}

const scanIdProp = {
  scanId: { type: "string", description: "Scan id from list_scans. Defaults to the most recent scan." }
};

function human(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function scanSummary(scan: ScanMeta) {
  return {
    id: scan.id,
    status: scan.status,
    rootPath: scan.rootPath,
    startedAt: scan.startedAt,
    finishedAt: scan.finishedAt,
    error: scan.error,
    totalSize: human(scan.progress.bytesScanned),
    bytes: scan.progress.bytesScanned,
    files: scan.progress.filesScanned,
    directories: scan.progress.dirsScanned,
    errors: scan.progress.errors
  };
}

function nodeSummary(node: ScanNode) {
  return {
    path: node.path,
    kind: node.kind,
    size: human(node.size),
    bytes: node.size,
    ...(node.kind === "directory" ? { children: node.totalChildren } : {}),
    ...(node.errorCount ? { errors: node.errorCount } : {})
  };
}

async function resolveScanId(args: Args): Promise<string> {
  if (typeof args.scanId === "string" && args.scanId) return args.scanId;
  const [latest] = await listScans();
  if (!latest) throw new Error(`No saved scans in ${SCAN_ROOT}. Run a scan in the app first.`);
  return latest.id;
}

const tools: Tool[] = [
  {
    name: "list_scans",
    description: "List saved disk scans, newest first, with status, root path and total size.",
    inputSchema: { type: "object", properties: {} },
    run: async () => ({ scans: (await listScans()).map(scanSummary) })
  },
  {
    name: "get_scan",
    description: "Status and totals of one scan (progress counts while it is still running).",
    inputSchema: { type: "object", properties: { ...scanIdProp } },
    run: async (args) => scanSummary(await getScanMeta(await resolveScanId(args)))
  },
  {
    name: "list_folder",
    description:
      "Children of a folder in a scan, largest first, with sizes. Omit path for the scan root. Use it to drill down to what takes the space.",
    inputSchema: {
      type: "object",
      properties: {
        ...scanIdProp,
        path: { type: "string", description: "Absolute folder path inside the scan. Defaults to the scan root." },
        limit: { type: "integer", description: "Max children to return (1-500, default 50)." }
      }
    },
    run: async (args) => {
      const id = await resolveScanId(args);
      const payload = await nodesToFolderPayload(id, typeof args.path === "string" ? args.path : null);
      const limit = clampInt(args.limit, 1, 500, 50);
      return {
        scan: scanSummary(payload.scan),
        folder: nodeSummary(payload.node),
        totalChildren: payload.children.length,
        children: payload.children.slice(0, limit).map(nodeSummary)
      };
    }
  },
  {
    name: "search_scan",
    description: "Fuzzy-search file and folder names/paths in a scan.",
    inputSchema: {
      type: "object",
      properties: {
        ...scanIdProp,
        query: { type: "string", description: "Name or path fragment." },
        limit: { type: "integer", description: "Max results (1-200, default 40)." }
      },
      required: ["query"]
    },
    run: async (args) => {
      const id = await resolveScanId(args);
      const result = await searchScan(id, String(args.query ?? ""), clampInt(args.limit, 1, 200, 40));
      return { query: result.query, results: result.results.map(nodeSummary) };
    }
  },
  {
    name: "largest_files",
    description: "Largest files in a scan, optionally limited to a type or extension.",
    inputSchema: {
      type: "object",
      properties: {
        ...scanIdProp,
        type: {
          type: "string",
          enum: ["all", "images", "videos", "audio", "archives", "documents", "code", "data", "apps", "other"],
          description: "File category, default all."
        },
        extension: { type: "string", description: "Extension filter, e.g. mp4." },
        limit: { type: "integer", description: "Max files (1-50, default 20)." }
      }
    },
    run: async (args) => {
      const id = await resolveScanId(args);
      const result = await topFilesForScan(id, {
        type: typeof args.type === "string" ? args.type : "all",
        q: typeof args.extension === "string" ? args.extension : "",
        limit: clampInt(args.limit, 1, 50, 20)
      });
      return {
        matchingFiles: result.totalCount,
        matchingSize: human(result.totalSize),
        files: result.files.map((file) => ({ path: file.path, size: human(file.size), bytes: file.size, type: file.type }))
      };
    }
  },
  {
    name: "file_types",
    description: "Space used per file type and per extension in a scan.",
    inputSchema: {
      type: "object",
      properties: {
        ...scanIdProp,
        limit: { type: "integer", description: "Max extension groups (1-500, default 40)." }
      }
    },
    run: async (args) => {
      const id = await resolveScanId(args);
      const result = await fileGroupsForScan(id, { type: "all", limit: clampInt(args.limit, 1, 500, 40) });
      return {
        types: result.types
          .filter((item) => item.count)
          .map((item) => ({ type: item.type, label: item.label, files: item.count, size: human(item.totalSize), bytes: item.totalSize })),
        extensions: result.groups.map((group) => ({
          extension: group.extension || group.label,
          type: group.type,
          files: group.count,
          size: human(group.totalSize),
          bytes: group.totalSize
        }))
      };
    }
  },
  {
    name: "cleanup_suggestions",
    description: "Reclaimable-space suggestions for a finished scan (caches, build output, duplicates, ...). Read-only: nothing is deleted.",
    inputSchema: { type: "object", properties: { ...scanIdProp } },
    run: async (args) => {
      const id = await resolveScanId(args);
      const result = await suggestCleanup(id);
      return {
        totalReclaimable: human(result.suggestions.reduce((sum, item) => sum + item.size, 0)),
        suggestions: result.suggestions.map((item) => ({
          name: item.name,
          category: item.category,
          reason: item.reason,
          size: human(item.size),
          bytes: item.size,
          paths: item.paths
        }))
      };
    }
  }
];

export const MCP_DISABLED_CODE = -32001;
export const MCP_DISABLED_MESSAGE = "Agent access is turned off in Bytescape (For agents screen).";

export interface RpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export function reply(id: RpcMessage["id"], body: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, ...body };
}

/**
 * Short prompt a user pastes into an agent so it knows the server exists and
 * how to use it. Copied from the app menu / tray (electron/main.ts).
 */
export function agentPrompt(mcpUrl: string): string {
  return [
    `Bytescape is running on my machine and serves my disk scan results over a read-only MCP server at ${mcpUrl} (Streamable HTTP, no auth, loopback only).`,
    `Add it as an MCP server (Claude Code: \`claude mcp add --transport http disk-scans ${mcpUrl}\`), or POST JSON-RPC to it directly.`,
    `Tools: ${tools.map((tool) => tool.name).join(", ")}. scanId defaults to the latest scan; use list_folder to drill into what takes space.`,
    "It is read-only: if something should be deleted, tell me what and why instead of deleting it yourself."
  ].join("\n");
}

/**
 * Handles one JSON-RPC message and returns the response to send, or null for
 * notifications (and responses), which get no reply. Transport-agnostic: the
 * app's HTTP server (/mcp) and the stdio entry point (mcp.ts) both use it.
 */
export async function handleMcpMessage(message: RpcMessage): Promise<Record<string, unknown> | null> {
  const { id, method, params = {} } = message;
  const isRequest = id !== undefined && id !== null;
  if (!method) return null; // a response to us; we never send requests
  // Turned off from the app's "For agents" screen: refuse everything, on both
  // transports (the stdio process reads the setting per call).
  if (!isMcpEnabled()) {
    return isRequest ? reply(id, { error: { code: MCP_DISABLED_CODE, message: MCP_DISABLED_MESSAGE } }) : null;
  }

  try {
    let result: unknown;
    switch (method) {
      case "initialize": {
        const requested = String(params.protocolVersion || "");
        result = {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions:
            "Read-only access to disk scans made by Bytescape. Start with list_scans or get_scan, then list_folder to drill into what uses space. scanId defaults to the latest scan."
        };
        break;
      }
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
        break;
      case "tools/call": {
        const tool = tools.find((item) => item.name === params.name);
        if (!tool) {
          return reply(id, { error: { code: -32602, message: `Unknown tool: ${String(params.name)}` } });
        }
        try {
          const output = await tool.run((params.arguments as Args) || {});
          result = { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
        } catch (error) {
          // Tool failures go back as results so the agent can read and recover.
          result = { content: [{ type: "text", text: (error as Error).message }], isError: true };
        }
        break;
      }
      default:
        if (!isRequest) return null; // notifications (initialized, cancelled, ...) need no reply
        return reply(id, { error: { code: -32601, message: `Method not found: ${method}` } });
    }
    return isRequest ? reply(id, { result }) : null;
  } catch (error) {
    return isRequest ? reply(id, { error: { code: -32603, message: (error as Error).message } }) : null;
  }
}

