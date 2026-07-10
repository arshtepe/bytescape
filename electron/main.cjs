const { app, BrowserWindow, shell, dialog } = require("electron");
const { startServer } = require("../server");

let mainWindow = null;
let serverHandle = null;

async function createWindow() {
  if (!serverHandle) {
    serverHandle = await startServer({
      host: "127.0.0.1",
      port: 0
    });
  }

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1020,
    minHeight: 680,
    title: "Disk Space Visualizer",
    backgroundColor: "#f5f1e8",
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

app.whenReady()
  .then(createWindow)
  .catch((error) => {
    dialog.showErrorBox("Startup failed", error.stack || error.message || String(error));
    app.quit();
  });

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((error) => {
      dialog.showErrorBox("Startup failed", error.stack || error.message || String(error));
    });
  }
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
