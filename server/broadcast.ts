import type { WebSocketServer } from "ws";
import type { SocketMessage } from "../shared/types";

let wss: WebSocketServer | null = null;

export function setSocketServer(server: WebSocketServer | null): void {
  wss = server;
}

export function broadcast(payload: SocketMessage): void {
  if (!wss) return;
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}
