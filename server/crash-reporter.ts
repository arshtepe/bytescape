import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { CRASH_ROOT } from "./fs-utils";
import { jobs, makeMeta } from "./scan-engine";

let crashHandlersInstalled = false;

function serializeError(error: unknown) {
  if (!error) return null;
  const err = error as Error & { code?: string };
  return {
    name: err.name || "Error",
    message: err.message || String(error),
    stack: err.stack || null,
    code: err.code || null
  };
}

async function saveCrashReport(kind: string, error: unknown): Promise<string> {
  await fsp.mkdir(CRASH_ROOT, { recursive: true });
  const id = crypto.randomUUID();
  const target = path.join(CRASH_ROOT, `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}.json`);
  const report = {
    id,
    kind,
    at: new Date().toISOString(),
    pid: process.pid,
    platform: process.platform,
    node: process.version,
    cwd: process.cwd(),
    argv: process.argv,
    memoryUsage: process.memoryUsage(),
    activeScans: Array.from(jobs.values()).map(makeMeta),
    error: serializeError(error)
  };
  await fsp.writeFile(target, JSON.stringify(report, null, 2));
  console.error(`Crash report saved: ${target}`);
  return target;
}

export function installCrashHandlers(): void {
  if (crashHandlersInstalled) return;
  crashHandlersInstalled = true;

  process.on("uncaughtException", (error) => {
    saveCrashReport("uncaughtException", error)
      .catch((writeError: Error) => console.error(`Failed to save crash report: ${writeError.message}`))
      .finally(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    saveCrashReport("unhandledRejection", error)
      .catch((writeError: Error) => console.error(`Failed to save crash report: ${writeError.message}`))
      .finally(() => process.exit(1));
  });

  process.on("warning", (warning) => {
    saveCrashReport("warning", warning).catch((writeError: Error) =>
      console.error(`Failed to save warning report: ${writeError.message}`)
    );
  });
}
