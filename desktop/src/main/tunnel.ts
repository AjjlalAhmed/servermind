// SSH tunnel manager. For each controller we open ONE outbound SSH connection
// and forward a random local port -> the controller's 127.0.0.1:5500. This is
// exactly `ssh -L <local>:127.0.0.1:5500 user@controller`, just managed and
// auto-reconnecting. The controller stays bound to localhost; nothing new is
// exposed to the network.

import { Client, type ConnectConfig } from "ssh2";
import net from "net";
import crypto from "crypto";
import { promises as fs } from "fs";
import { getController, getSecret, upsertController, type ControllerConfig } from "./store";

export type TunnelState = "connecting" | "connected" | "reconnecting" | "closed" | "error";

export interface TunnelStatus {
  id: string;
  state: TunnelState;
  localPort?: number;
  url?: string;
  message?: string;
  hostKeyFingerprint?: string;
}

type Listener = (status: TunnelStatus) => void;

interface Active {
  conn: Client;
  server: net.Server;
  localPort: number;
  closingByUser: boolean;
  reconnectTimer?: NodeJS.Timeout;
}

const fingerprint = (key: Buffer): string =>
  crypto.createHash("sha256").update(key).digest("base64");

export class TunnelManager {
  private active = new Map<string, Active>();
  private status = new Map<string, TunnelStatus>();
  private listeners = new Set<Listener>();

  onStatus(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(s: TunnelStatus): void {
    this.status.set(s.id, s);
    for (const fn of this.listeners) fn(s);
  }

  getStatus(id: string): TunnelStatus {
    return this.status.get(id) ?? { id, state: "closed" };
  }

  /** Open (or no-op if already up) the tunnel for a controller. */
  async connect(id: string): Promise<TunnelStatus> {
    if (this.active.has(id)) return this.getStatus(id);

    const cfg = await getController(id);
    if (!cfg) throw new Error(`Unknown controller: ${id}`);

    // Direct mode: no SSH, no port-forward. The controller is already reachable
    // from this machine (local Docker / LAN / tailnet), so we just hand the
    // dashboard window the address as-is.
    if (cfg.connection === "direct") {
      const host = cfg.host.trim() || "127.0.0.1";
      const status: TunnelStatus = {
        id,
        state: "connected",
        url: `http://${host}:${cfg.remotePort}`,
      };
      this.emit(status);
      return status;
    }

    this.emit({ id, state: "connecting" });
    return this.establish(cfg);
  }

  private async establish(cfg: ControllerConfig): Promise<TunnelStatus> {
    const id = cfg.id;
    const conn = new Client();
    const connectCfg = await this.buildConnectConfig(cfg);

    return new Promise<TunnelStatus>((resolve, reject) => {
      let settled = false;

      conn.on("ready", async () => {
        // Stand up a local listener; each inbound socket gets its own
        // direct-tcpip channel to the controller's ServerMind port.
        const server = net.createServer((socket) => {
          conn.forwardOut(
            "127.0.0.1",
            0,
            cfg.remoteHost,
            cfg.remotePort,
            (err, stream) => {
              if (err) {
                socket.destroy();
                return;
              }
              socket.pipe(stream).pipe(socket);
              socket.on("error", () => stream.destroy());
              stream.on("error", () => socket.destroy());
            }
          );
        });

        server.on("error", (e) => {
          this.emit({ id, state: "error", message: e.message });
        });

        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          const localPort = typeof addr === "object" && addr ? addr.port : 0;
          this.active.set(id, { conn, server, localPort, closingByUser: false });
          const status: TunnelStatus = {
            id,
            state: "connected",
            localPort,
            url: `http://127.0.0.1:${localPort}`,
          };
          this.emit(status);
          if (!settled) {
            settled = true;
            resolve(status);
          }
        });
      });

      conn.on("error", (err) => {
        this.emit({ id, state: "error", message: err.message });
        if (!settled) {
          settled = true;
          reject(err);
        } else {
          this.scheduleReconnect(cfg);
        }
      });

      conn.on("close", () => {
        const a = this.active.get(id);
        if (a && !a.closingByUser) {
          this.emit({ id, state: "reconnecting" });
          this.scheduleReconnect(cfg);
        }
        try {
          a?.server.close();
        } catch {
          /* already closed */
        }
        this.active.delete(id);
      });

      conn.connect(connectCfg);
    });
  }

  private scheduleReconnect(cfg: ControllerConfig): void {
    const id = cfg.id;
    const existing = this.active.get(id);
    if (existing?.reconnectTimer) return;
    const timer = setTimeout(() => {
      this.establish(cfg).catch(() => {
        /* error already emitted; will retry on next close */
      });
    }, 3000);
    timer.unref?.();
    // Track the timer even though the connection is gone, so we don't stack them.
    this.active.set(id, {
      ...(existing ?? ({} as Active)),
      reconnectTimer: timer,
    } as Active);
  }

  /** Build the ssh2 connect config, including TOFU host-key pinning. */
  private async buildConnectConfig(cfg: ControllerConfig): Promise<ConnectConfig> {
    const base: ConnectConfig = {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      // Trust On First Use: pin the host key on first connect, then require it
      // to match on every reconnect. A changed key aborts the connection.
      hostVerifier: (key: Buffer): boolean => {
        const fp = fingerprint(key);
        if (!cfg.pinnedHostKey) {
          cfg.pinnedHostKey = fp;
          void upsertController(cfg); // persist the pin
          this.emit({ ...this.getStatus(cfg.id), id: cfg.id, hostKeyFingerprint: fp });
          return true;
        }
        return crypto.timingSafeEqual(
          Buffer.from(cfg.pinnedHostKey),
          Buffer.from(fp)
        );
      },
    };

    if (cfg.authMethod === "agent") {
      const sock = process.env.SSH_AUTH_SOCK;
      if (!sock) throw new Error("No SSH agent found (SSH_AUTH_SOCK unset).");
      return { ...base, agent: sock };
    }

    if (cfg.authMethod === "key") {
      if (!cfg.keyPath) throw new Error("Key auth selected but no key path set.");
      const privateKey = await fs.readFile(cfg.keyPath);
      const passphrase = await getSecret(cfg.id);
      return { ...base, privateKey, passphrase };
    }

    // password
    const password = await getSecret(cfg.id);
    if (!password) throw new Error("Password auth selected but no password saved.");
    return { ...base, password };
  }

  disconnect(id: string): void {
    const a = this.active.get(id);
    if (!a) {
      this.emit({ id, state: "closed" });
      return;
    }
    a.closingByUser = true;
    if (a.reconnectTimer) clearTimeout(a.reconnectTimer);
    try {
      a.server.close();
    } catch {
      /* noop */
    }
    try {
      a.conn.end();
    } catch {
      /* noop */
    }
    this.active.delete(id);
    this.emit({ id, state: "closed" });
  }

  disconnectAll(): void {
    for (const id of [...this.active.keys()]) this.disconnect(id);
  }
}

export const tunnels = new TunnelManager();
