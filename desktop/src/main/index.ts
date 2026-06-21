// Main process entry. Creates the control-panel window, registers IPC, and
// tears tunnels down on quit. Hardened defaults: context isolation on, no node
// in the renderer, sandboxed.

import { app, BrowserWindow } from "electron";
import path from "path";
import { registerIpc, PRELOAD_PATH } from "./ipc";
import { tunnels } from "./tunnel";

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 720,
    minWidth: 380,
    title: "ServerMind",
    webPreferences: {
      preload: PRELOAD_PATH,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  void mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerIpc(() => mainWindow);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  tunnels.disconnectAll();
});
