// Preload: the only surface the renderer can touch. Exposes a narrow, typed API
// over IPC via contextBridge — no Node, no ipcRenderer leak into the page.

import { contextBridge, ipcRenderer } from "electron";

export type ConnectionMode = "ssh" | "direct";

export interface ControllerView {
  id: string;
  connection: ConnectionMode;
  label: string;
  host: string;
  port: number;
  username: string;
  authMethod: "agent" | "key" | "password";
  keyPath?: string;
  remoteHost: string;
  remotePort: number;
  pinnedHostKey?: string;
}

export interface SaveControllerInput {
  id?: string;
  connection?: ConnectionMode;
  label: string;
  host: string;
  port?: number;
  username: string;
  authMethod: "agent" | "key" | "password";
  keyPath?: string;
  remotePort?: number;
  secret?: string;
}

export interface TunnelStatus {
  id: string;
  state: "connecting" | "connected" | "reconnecting" | "closed" | "error";
  localPort?: number;
  url?: string;
  message?: string;
  hostKeyFingerprint?: string;
}

const api = {
  listControllers: (): Promise<ControllerView[]> => ipcRenderer.invoke("controllers:list"),
  saveController: (input: SaveControllerInput): Promise<ControllerView> =>
    ipcRenderer.invoke("controllers:save", input),
  deleteController: (id: string): Promise<void> => ipcRenderer.invoke("controllers:delete", id),
  connect: (id: string): Promise<TunnelStatus> => ipcRenderer.invoke("tunnel:connect", id),
  disconnect: (id: string): Promise<void> => ipcRenderer.invoke("tunnel:disconnect", id),
  status: (id: string): Promise<TunnelStatus> => ipcRenderer.invoke("tunnel:status", id),
  openDashboard: (id: string): Promise<void> => ipcRenderer.invoke("dashboard:open", id),
  onStatus: (cb: (s: TunnelStatus) => void): void => {
    ipcRenderer.on("tunnel:status", (_e, s: TunnelStatus) => cb(s));
  },
};

contextBridge.exposeInMainWorld("servermind", api);

export type ServerMindApi = typeof api;
