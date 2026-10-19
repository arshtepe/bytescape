import path from "path";
import { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, Notification, shell, Tray, type MenuItemConstructorOptions } from "electron";
import { startServer, type ServerHandle } from "../server/index";
import { agentPrompt } from "../server/mcp-tools";

// Fixed so agents can be pointed at a stable MCP URL; falls back to a random
// port when it's taken (e.g. a dev server), and the copied prompt follows.
const PREFERRED_PORT = 5178;

let mainWindow: BrowserWindow | null = null;
let serverHandle: ServerHandle | null = null;
let tray: Tray | null = null;

async function startAppServer(): Promise<ServerHandle> {
  try {
    return await startServer({ host: "127.0.0.1", port: PREFERRED_PORT });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    return startServer({ host: "127.0.0.1", port: 0 });
  }
}

function mcpUrl(): string | null {
  return serverHandle ? `${serverHandle.url}/mcp` : null;
}

function copyToClipboard(text: string | null, what: string): void {
  if (!text) return;
  clipboard.writeText(text);
  if (Notification.isSupported()) new Notification({ title: "Bytescape", body: `${what} copied to clipboard` }).show();
}

function agentMenuItems(): MenuItemConstructorOptions[] {
  return [
    { label: "Copy Agent Prompt", click: () => copyToClipboard(mcpUrl() && agentPrompt(mcpUrl() as string), "Agent prompt") },
    { label: "Copy MCP Server URL", click: () => copyToClipboard(mcpUrl(), "MCP server URL") }
  ];
}

function installMenus(): void {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { label: "Agent", submenu: agentMenuItems() },
    { role: "windowMenu" }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  const icon = nativeImage.createFromPath(path.join(__dirname, "..", "..", "build", "tray.png"));
  tray = new Tray(icon);
  tray.setToolTip("Bytescape");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Window", click: () => showWindow() },
      { type: "separator" },
      ...agentMenuItems(),
      { type: "separator" },
      { role: "quit" }
    ])
  );
}

function showWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  createWindow().catch((error: Error) => dialog.showErrorBox("Startup failed", error.stack || error.message || String(error)));
}

async function createWindow(): Promise<void> {
  if (!serverHandle) {
    serverHandle = await startAppServer();
  }

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1020,
    minHeight: 680,
    title: "Bytescape",
    backgroundColor: "#eef0f3",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  await mainWindow.loadURL(serverHandle.url);
}

app
  .whenReady()
  .then(async () => {
    await createWindow();
    installMenus();
  })
  .catch((error: Error) => {
    dialog.showErrorBox("Startup failed", error.stack || error.message || String(error));
    app.quit();
  });

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) showWindow();
});

app.on("before-quit", async () => {
  if (serverHandle) {
    const handle = serverHandle;
    serverHandle = null;
    await handle.close().catch(() => {});
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
