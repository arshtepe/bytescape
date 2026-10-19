// Must be set before libuv's threadpool is first used: scan persistence fans
// out many concurrent appendFile calls and the default 4 threads bottleneck it.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = "16";

import http from "http";
import { WebSocketServer } from "ws";
import { checkBrowserBoundary, router } from "./http";
import { createScanJob, getScanStore, jobs, listScans, sweepDeletedScans } from "./scan-engine";
import { installCrashHandlers } from "./crash-reporter";
import { setSocketServer } from "./broadcast";
import { SCAN_ROOT, CRASH_ROOT } from "./fs-utils";

// Deliberately not the generic PORT/HOST env vars: those are commonly claimed
// by whatever frontend dev tooling launches this alongside (e.g. Vite), which
// caused the API server to collide with the client's own port.
const PORT = Number(process.env.SERVER_PORT || 5178);
const HOST = process.env.SERVER_HOST || "127.0.0.1";

export interface ServerHandle {
  server: http.Server;
  wss: WebSocketServer;
  url: string;
  close: () => Promise<void>;
}

export interface StartServerOptions {
  host?: string;
  port?: number;
  installCrashHandlers?: boolean;
}

export function startServer(options: StartServerOptions = {}): Promise<ServerHandle> {
  const host = options.host || HOST;
  const port = options.port ?? PORT;
  if (options.installCrashHandlers !== false) installCrashHandlers();
  void sweepDeletedScans();

  const server = http.createServer((req, res) => {
    router(req, res).catch((error: Error) => {
      console.error(error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  });

  const wss = new WebSocketServer({
    server,
    path: "/ws",
    // The log stream carries full filesystem paths; without this check any
    // webpage could open ws://127.0.0.1:<port>/ws and read them. Same
    // loopback Host/Origin rules as the HTTP router.
    verifyClient: ({ req }: { req: http.IncomingMessage }) => checkBrowserBoundary(req) === null
  });
  setSocketServer(wss);
  wss.on("connection", async (ws) => {
    ws.send(JSON.stringify({ type: "hello", scans: await listScans().catch(() => []) }));
  });

  // ws re-emits the HTTP server's errors on wss; with no listener there, a
  // listen failure (EADDRINUSE) became an uncaughtException that the crash
  // handler turns into process exit, before the caller could fall back.
  wss.on("error", (error) => console.error(`WebSocket server error: ${error.message}`));

  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      wss.close();
      reject(error);
    });
    server.listen(port, host, () => {
      server.removeAllListeners("error");
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      const url = `http://${host}:${actualPort}`;
      console.log(`Bytescape running at ${url}`);
      console.log(`Scan snapshots stored in ${SCAN_ROOT}`);
      console.log(`Crash reports stored in ${CRASH_ROOT}`);
      resolve({
        server,
        wss,
        url,
        close: () =>
          new Promise<void>((closeResolve) => {
            setSocketServer(null);
            wss.close(() => {
              server.close(() => closeResolve());
            });
          })
      });
    });
  });
}

async function runCliScan(): Promise<void> {
  const job = await createScanJob({ rootPath: process.argv[3] || ".", maxDepth: 20, includeHidden: true });
  while (jobs.has(job.id)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const store = await getScanStore(job.id);
  console.log(JSON.stringify(store.meta, null, 2));
}

if (process.argv[2] === "--scan") {
  runCliScan().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
