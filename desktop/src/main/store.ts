// Persistent app state. Two tiers:
//   • Non-secret config (controller list, host-key pins) → plain JSON in userData.
//   • Secrets (key passphrase / SSH password) → encrypted with Electron's
//     safeStorage (OS-keychain-backed) before they ever touch disk.
//
// The app itself NEVER stores anything an SSH server depends on. Delete this
// file and you lose a saved list, nothing more — the controller is untouched.

import { app, safeStorage } from "electron";
import { promises as fs } from "fs";
import path from "path";

export type AuthMethod = "agent" | "key" | "password";
export type ConnectionMode = "ssh" | "direct";

export interface ControllerConfig {
  id: string;
  label: string;
  // "ssh": open an SSH tunnel to `host` and forward to remoteHost:remotePort.
  // "direct": no SSH — the dashboard is already reachable at host:remotePort
  //           from this machine (local Docker, LAN, or a tailnet).
  connection: ConnectionMode;
  host: string; // controller hostname / IP (SSH host, or direct address)
  port: number; // SSH port (usually 22) — ignored for direct
  username: string; // SSH user — ignored for direct
  authMethod: AuthMethod;
  keyPath?: string; // path to private key (authMethod === "key")
  remoteHost: string; // where ServerMind binds on the controller (127.0.0.1)
  remotePort: number; // ServerMind port on the controller (5500)
  pinnedHostKey?: string; // sha256 base64 of the SSH host key (TOFU)
}

interface PersistShape {
  controllers: ControllerConfig[];
  secrets: Record<string, string>; // controllerId -> base64 ciphertext
}

const EMPTY: PersistShape = { controllers: [], secrets: {} };

function statePath(): string {
  return path.join(app.getPath("userData"), "state.json");
}

let cache: PersistShape | null = null;

async function load(): Promise<PersistShape> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(statePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistShape>;
    const controllers = (parsed.controllers ?? []).map((c) => ({
      ...c,
      connection: c.connection ?? "ssh", // default for pre-direct-mode saves
    }));
    cache = { controllers, secrets: parsed.secrets ?? {} };
  } catch {
    cache = { ...EMPTY };
  }
  return cache;
}

async function flush(): Promise<void> {
  if (!cache) return;
  await fs.writeFile(statePath(), JSON.stringify(cache, null, 2), { mode: 0o600 });
}

/** Public, secret-free view of every saved controller. */
export async function listControllers(): Promise<ControllerConfig[]> {
  return (await load()).controllers;
}

export async function getController(id: string): Promise<ControllerConfig | undefined> {
  return (await load()).controllers.find((c) => c.id === id);
}

export async function upsertController(cfg: ControllerConfig): Promise<void> {
  const s = await load();
  const i = s.controllers.findIndex((c) => c.id === cfg.id);
  if (i >= 0) s.controllers[i] = cfg;
  else s.controllers.push(cfg);
  await flush();
}

export async function deleteController(id: string): Promise<void> {
  const s = await load();
  s.controllers = s.controllers.filter((c) => c.id !== id);
  delete s.secrets[id];
  await flush();
}

/** Encrypt and store a secret (password or key passphrase) for a controller. */
export async function setSecret(id: string, secret: string): Promise<void> {
  const s = await load();
  if (!secret) {
    delete s.secrets[id];
  } else if (safeStorage.isEncryptionAvailable()) {
    s.secrets[id] = safeStorage.encryptString(secret).toString("base64");
  } else {
    // No OS keychain backing available — refuse to persist plaintext.
    throw new Error("OS secure storage is unavailable; cannot save the secret.");
  }
  await flush();
}

export async function getSecret(id: string): Promise<string | undefined> {
  const s = await load();
  const enc = s.secrets[id];
  if (!enc) return undefined;
  return safeStorage.decryptString(Buffer.from(enc, "base64"));
}
