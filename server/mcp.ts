// Stdio entry point for the read-only scan MCP, for agents that cannot reach
// the app's HTTP endpoint (the app serves the same tools at /mcp while it is
// open; this works with the app closed too, reading the scan store on disk).
//
//   claude mcp add disk-scans -- node /path/to/disk/dist-server/server/mcp.js
import readline from "readline";
import { handleMcpMessage, reply, type RpcMessage } from "./mcp-tools";

// stdout is the protocol channel; anything else printed there corrupts it.
console.log = console.error;
console.info = console.error;
console.warn = console.error;

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message: RpcMessage;
  try {
    message = JSON.parse(line) as RpcMessage;
  } catch {
    send(reply(null, { error: { code: -32700, message: "Parse error" } }));
    return;
  }
  void handleMcpMessage(message).then((response) => {
    if (response) send(response);
  });
});
input.on("close", () => process.exit(0));
