// Bridge between the renderer (control panel) and the main-process modules.
// Every channel is request/response via ipcMain.handle, except tunnel status,
// which is pushed to the renderer as it changes.

import { BrowserWindow, ipcMain, shell } from "electron";
import crypto from "crypto";
import path from "path";
import {
  deleteController,
  listControllers,
  setSecret,
  upsertController,
  type AuthMethod,
  type ConnectionMode,
  type ControllerConfig,
} from "./store";
import { tunnels, type TunnelStatus } from "./tunnel";

export interface SaveControllerInput {
  id?: string;
  connection?: ConnectionMode;
  label: string;
  host: string;
  port?: number;
  username: string;
  authMethod: AuthMethod;
  keyPath?: string;
  remotePort?: number;
  secret?: string; // password or key passphrase (encrypted at rest)
}

const dashboardWindows = new Map<string, BrowserWindow>();

export function registerIpc(getMain: () => BrowserWindow | null): void {
  // Forward every tunnel status change to the control panel.
  tunnels.onStatus((status: TunnelStatus) => {
    getMain()?.webContents.send("tunnel:status", status);
  });

  ipcMain.handle("controllers:list", () => listControllers());

  ipcMain.handle("controllers:save", async (_e, input: SaveControllerInput) => {
    const id = input.id ?? crypto.randomUUID();
    const cfg: ControllerConfig = {
      id,
      connection: input.connection === "direct" ? "direct" : "ssh",
      label: input.label.trim() || input.host,
      host: input.host.trim(),
      port: input.port && input.port > 0 ? input.port : 22,
      username: input.username.trim(),
      authMethod: input.authMethod,
      keyPath: input.keyPath?.trim() || undefined,
      remoteHost: "127.0.0.1",
      remotePort: input.remotePort && input.remotePort > 0 ? input.remotePort : 5500,
    };
    await upsertController(cfg);
    if (input.secret !== undefined) await setSecret(id, input.secret);
    return cfg;
  });

  ipcMain.handle("controllers:delete", async (_e, id: string) => {
    tunnels.disconnect(id);
    await deleteController(id);
  });

  ipcMain.handle("tunnel:connect", (_e, id: string) => tunnels.connect(id));
  ipcMain.handle("tunnel:disconnect", (_e, id: string) => tunnels.disconnect(id));
  ipcMain.handle("tunnel:status", (_e, id: string) => tunnels.getStatus(id));

  // Open the controller's own ServerMind dashboard in a dedicated window that
  // loads the tunneled localhost URL. It's a plain browser surface — no Node,
  // no preload, sandboxed — so a hostile page can never reach the host.
  ipcMain.handle("dashboard:open", async (_e, id: string) => {
    const status = tunnels.getStatus(id);
    if (status.state !== "connected" || !status.url) {
      throw new Error("Tunnel is not connected.");
    }
    const existing = dashboardWindows.get(id);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 1200,
      height: 820,
      title: "ServerMind",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    // New windows: only hand http(s) links to the OS browser. A hostile
    // controller page could otherwise request file://, smb://, or a custom
    // scheme to trigger an OS protocol handler — deny everything else.
    win.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const { protocol } = new URL(url);
        if (protocol === "http:" || protocol === "https:") void shell.openExternal(url);
      } catch {
        /* malformed URL — ignore */
      }
      return { action: "deny" };
    });
    // Pin in-window navigation to the tunnel origin; block the page from
    // navigating this window elsewhere (e.g. to file://).
    const origin = new URL(status.url).origin;
    win.webContents.on("will-navigate", (e, url) => {
      if (new URL(url).origin !== origin) e.preventDefault();
    });
    dashboardWindows.set(id, win);
    win.on("closed", () => dashboardWindows.delete(id));
    await win.loadURL(status.url);
  });
}

export const PRELOAD_PATH = path.join(__dirname, "..", "preload", "preload.js");
