// Controller-side WireGuard mesh orchestration.
//
// Split into two layers on purpose:
//   • Orchestration (enrollAgent / revokeAgent / controllerConfigText) is PURE
//     and dependency-injected — it computes the next wg0.conf from the registry
//     and is fully unit-tested.
//   • The single PRIVILEGED action (atomically write /etc/wireguard/wg0.conf,
//     then `sudo -n wg syncconf wg0`) lives in fileApplier() — the only place
//     that touches root, via the narrowly-scoped sudoers rule. Nothing here can
//     get a shell; it can only re-render and reload that one interface.

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { exec } from "../tools/exec.ts";
import {
  generateKeypair,
  isWgKey,
  allocateIp,
  renderControllerConfig,
  DEFAULT_MESH,
  type MeshConfig,
} from "./wireguard.ts";
import type { FleetRegistry } from "./registry.ts";

export interface MeshIdentity {
  privateKey: string;  // controller's WG private key (stays on the controller)
  publicKey: string;   // handed to agents so they can reach back
  listenPort: number;  // UDP port the controller listens on (default 51820)
  endpoint: string;    // host:port agents dial, e.g. 203.0.113.5:51820
}

// The two rendered forms of the controller config:
//   disk — wg-quick format (with Address) for /etc/wireguard/wg0.conf (bring-up + reboot)
//   sync — native stripped format (no Address) for `wg syncconf` (live reload)
export interface MeshTexts { disk: string; sync: string }

// Applies the rendered config. Injected so orchestration stays testable;
// production uses fileApplier(), tests use a recording stub.
export type Applier = (texts: MeshTexts) => Promise<{ ok: boolean; error?: string }>;

// Render the controller's ENTIRE config (both forms) from the current registry
// state. We always render the whole file (never append) so removals truly
// disappear and restarts/re-enrollments converge.
export function meshTexts(reg: FleetRegistry, id: MeshIdentity, m: MeshConfig = DEFAULT_MESH): MeshTexts {
  const peers = reg.meshPeers().map((p) => ({ publicKey: p.pubkey, agentIp: p.ip, hostname: p.hostname }));
  const iface = { privateKey: id.privateKey, listenPort: id.listenPort, m };
  return {
    disk: renderControllerConfig(iface, peers),
    sync: renderControllerConfig(iface, peers, { forSync: true }),
  };
}

export interface EnrollInput {
  id: string;       // agent id
  hostname: string;
  pubkey: string;   // agent's PUBLIC key (its private key never leaves the box)
}

export interface EnrollResult {
  assignedIp: string;
  controllerPublicKey: string;
  controllerEndpoint: string;
  cidr: string;
}

// Idempotently enroll an agent into the mesh: reuse its existing IP if it has one
// (reinstall keeps its address — only the key rotates), else allocate the lowest
// free one. Persists pubkey+ip, re-renders + applies wg0.conf, and returns what
// the agent needs to build its own config.
export async function enrollAgent(
  reg: FleetRegistry,
  id: MeshIdentity,
  input: EnrollInput,
  m: MeshConfig,
  apply: Applier,
): Promise<EnrollResult | { error: string }> {
  if (!isWgKey(input.pubkey)) return { error: "invalid agent public key" };
  const existing = reg.meshOf(input.id);
  const ip = existing?.ip ?? allocateIp(reg.usedIps(), m);
  if (!ip) return { error: "mesh address space exhausted — widen MESH_CIDR" };

  reg.setMesh(input.id, input.pubkey, ip);
  const res = await apply(meshTexts(reg, id, m));
  if (!res.ok) return { error: res.error ?? "failed to apply mesh config" };

  return { assignedIp: ip, controllerPublicKey: id.publicKey, controllerEndpoint: id.endpoint, cidr: m.cidr };
}

// Revoke an agent: remove it from the registry (which frees its IP and drops it
// from meshPeers) AND re-render+reload wg0.conf — one operation so the two can
// never drift apart. After this the agent's key is no longer accepted.
export async function revokeAgent(
  reg: FleetRegistry,
  id: MeshIdentity,
  agentId: string,
  m: MeshConfig,
  apply: Applier,
): Promise<{ ok: boolean; error?: string }> {
  reg.remove(agentId);
  return apply(meshTexts(reg, id, m));
}

// ── privileged layer (the only thing that touches root) ──────────────────────

// Load the controller's WG identity from disk, or mint one on first use. Only the
// keypair is persisted; listenPort/endpoint come from config each boot.
export function loadOrCreateIdentity(path: string, opts: { listenPort: number; endpoint: string }): MeshIdentity {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { privateKey?: string; publicKey?: string };
    if (isWgKey(j.privateKey) && isWgKey(j.publicKey)) {
      return { privateKey: j.privateKey, publicKey: j.publicKey, listenPort: opts.listenPort, endpoint: opts.endpoint };
    }
  } catch { /* no identity yet — create one below */ }
  const kp = generateKeypair();
  writeFileSync(path, JSON.stringify({ privateKey: kp.privateKey, publicKey: kp.publicKey }), { mode: 0o600 });
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, listenPort: opts.listenPort, endpoint: opts.endpoint };
}

// The real applier. Both files are owned by the controller's user (set up by the
// installer) so the WRITE needs no privilege; only the reload is privileged, via
// the scoped sudoers rule. `sudo -n` never prompts; a missing rule fails loudly.
//
//   • configPath (/etc/wireguard/wg0.conf) — full wg-quick format, for `wg-quick
//     up` on bring-up and reboot. Kept current so a restart converges.
//   • syncPath (a sibling .sync file) — stripped native format fed to
//     `wg syncconf`, which applies peer add/remove to the LIVE interface with no
//     downtime (existing tunnels stay up).
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 }); // 600 so the private key isn't world-readable
  renameSync(tmp, path);                     // atomic swap — no half-written config
}

// Write both config forms to disk (as the controller's user — no privilege).
export function writeMeshFiles(configPath: string, syncPath: string, texts: MeshTexts): void {
  atomicWrite(configPath, texts.disk);
  atomicWrite(syncPath, texts.sync);
}

export function fileApplier(configPath: string, syncPath: string, iface = "wg0"): Applier {
  return async (texts) => {
    try {
      writeMeshFiles(configPath, syncPath, texts);
    } catch (e) {
      return { ok: false, error: `write ${configPath}: ${(e as Error).message}` };
    }
    const r = await exec(["sudo", "-n", "wg", "syncconf", iface, syncPath]);
    if (r.ok) return { ok: true };
    return { ok: false, error: r.stderr.trim() || `wg syncconf ${iface} exited ${r.code}` };
  };
}

// Boot-time bring-up: write the current config, then (re)create the interface.
// `wg syncconf` needs the interface to already exist, so on boot we go through
// wg-quick. Idempotent: down (ignored if not up) then up — a brief blip only at
// startup, when nothing is connected yet.
export async function bringUpInterface(
  iface: string,
  configPath: string,
  syncPath: string,
  texts: MeshTexts,
): Promise<{ ok: boolean; error?: string }> {
  try {
    writeMeshFiles(configPath, syncPath, texts);
  } catch (e) {
    return { ok: false, error: `write ${configPath}: ${(e as Error).message}` };
  }
  await exec(["sudo", "-n", "wg-quick", "down", iface]); // ignore — may not be up
  const r = await exec(["sudo", "-n", "wg-quick", "up", iface]);
  if (r.ok) return { ok: true };
  return { ok: false, error: r.stderr.trim() || `wg-quick up ${iface} exited ${r.code}` };
}
