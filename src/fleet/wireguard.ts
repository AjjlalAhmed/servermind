// Self-hosted WireGuard control plane (no third party).
//
// This module is the PURE core: it generates WireGuard keypairs, allocates mesh
// IPs, and renders config text. It performs NO privileged action itself — writing
// /etc/wireguard/wg0.conf and reloading the interface is done by a separate,
// narrowly-scoped applier (see mesh.ts) so the dangerous capability is isolated
// and auditable. Everything here is deterministic and unit-tested.
//
// Key-handling note: generateKeypair() runs on the AGENT (in the installer), so a
// private key NEVER crosses the network — only the public key is sent to the
// controller. The controller stores public keys only.
//
// WireGuard keys are raw 32-byte Curve25519 keys, base64-encoded. We derive them
// from Bun's built-in X25519 (node:crypto) so neither side needs the `wg` binary
// just to mint keys — the last 32 bytes of the DER encoding ARE the raw key.

import { generateKeyPairSync } from "node:crypto";

export interface WgKeypair {
  privateKey: string; // base64, 44 chars
  publicKey: string;  // base64, 44 chars
}

/** Generate a WireGuard keypair (Curve25519), byte-identical to `wg genkey`. */
export function generateKeypair(): WgKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const priv = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return { privateKey: priv.toString("base64"), publicKey: pub.toString("base64") };
}

/** True if s looks like a WireGuard base64 key (32 bytes → 43 chars + '='). */
export function isWgKey(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9+/]{43}=$/.test(s);
}

// ── mesh addressing (configurable CIDR — fix for the /24 ~253-agent cap) ──────
// The controller always takes the first usable host of the range (e.g. .1 in a
// /24, .0.1 in a /16). Default /24 fits ~253 agents; set a /16 for big fleets.

export interface MeshConfig {
  cidr: string; // e.g. "10.99.0.0/24" (default) or "10.99.0.0/16" for large fleets
}

export const DEFAULT_MESH: MeshConfig = { cidr: "10.99.0.0/24" };

const ip2int = (ip: string): number =>
  ip.split(".").reduce((a, o) => ((a << 8) + (Number(o) & 255)) >>> 0, 0) >>> 0;
const int2ip = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

interface Range { firstHost: number; lastHost: number; prefix: number }
function parseRange(m: MeshConfig): Range {
  const [base, p] = m.cidr.split("/");
  const prefix = Number(p);
  if (!base || !Number.isInteger(prefix) || prefix < 8 || prefix > 30) {
    throw new Error(`invalid mesh CIDR: ${m.cidr} (expect base/prefix, prefix 8–30)`);
  }
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ip2int(base) & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { firstHost: (network + 1) >>> 0, lastHost: (broadcast - 1) >>> 0, prefix };
}

export function prefixOf(m: MeshConfig = DEFAULT_MESH): number {
  return parseRange(m).prefix;
}

/** The controller's own mesh address — the first usable host of the range. */
export function controllerIp(m: MeshConfig = DEFAULT_MESH): string {
  return int2ip(parseRange(m).firstHost);
}

// Allocate the lowest free host, skipping the controller and anything already
// handed out. Returns null when the range is exhausted.
export function allocateIp(used: Iterable<string>, m: MeshConfig = DEFAULT_MESH): string | null {
  const r = parseRange(m);
  const taken = new Set<string>(used);
  taken.add(controllerIp(m)); // controller's host is never assignable
  for (let h = r.firstHost; h <= r.lastHost; h++) {
    const ip = int2ip(h >>> 0);
    if (!taken.has(ip)) return ip;
  }
  return null;
}

// ── config rendering (pure) ──────────────────────────────────────────────────

export interface AgentConfigInput {
  agentPrivateKey: string;
  agentIp: string;             // e.g. 10.99.0.2
  controllerPublicKey: string;
  controllerEndpoint: string;  // host:port reachable by the agent, e.g. 203.0.113.5:51820
  m?: MeshConfig;
}

// The /etc/wireguard/wg0.conf written on the AGENT box (at install time). The
// agent routes only the mesh subnet over the tunnel (AllowedIPs = the CIDR), so
// WireGuard is NOT a default gateway — it never captures the box's other traffic.
export function renderAgentConfig(i: AgentConfigInput): string {
  const m = i.m ?? DEFAULT_MESH;
  return [
    "[Interface]",
    `PrivateKey = ${i.agentPrivateKey}`,
    `Address = ${i.agentIp}/32`,
    "",
    "[Peer]",
    `PublicKey = ${i.controllerPublicKey}`,
    `Endpoint = ${i.controllerEndpoint}`,
    `AllowedIPs = ${m.cidr}`,
    "PersistentKeepalive = 25", // hole-punch through NAT so the controller can reach back
    "",
  ].join("\n");
}

export interface PeerBlockInput {
  publicKey: string;
  agentIp: string;
  hostname?: string;
}

// A single [Peer] block for one agent. AllowedIPs is the agent's single /32 — so
// the controller only ever routes that one address to that one peer (no peer can
// claim another's IP).
export function renderControllerPeer(i: PeerBlockInput): string {
  return [
    i.hostname ? `# ${i.hostname}` : "# agent",
    "[Peer]",
    `PublicKey = ${i.publicKey}`,
    `AllowedIPs = ${i.agentIp}/32`,
    "",
  ].join("\n");
}

export interface ControllerInterfaceInput {
  privateKey: string;
  listenPort: number; // default 51820
  m?: MeshConfig;
}

// `Address` is a wg-quick-only directive — the native `wg setconf`/`syncconf`
// rejects it. So we omit it for the SYNC variant (live reload) and include it
// only in the DISK variant (used by `wg-quick up` for bring-up + reboot).
function renderControllerInterface(i: ControllerInterfaceInput, forSync: boolean): string {
  const m = i.m ?? DEFAULT_MESH;
  return [
    "[Interface]",
    ...(forSync ? [] : [`Address = ${controllerIp(m)}/${prefixOf(m)}`]),
    `ListenPort = ${i.listenPort}`,
    `PrivateKey = ${i.privateKey}`,
    "",
  ].join("\n");
}

// Render the WHOLE controller wg0.conf from the interface + the current peer list.
// We re-render the entire file on every change (idempotent, registry-driven)
// rather than appending — so restarts and re-enrollments converge instead of
// drifting, and a removed peer truly disappears.
//
// opts.forSync → the STRIPPED native format for `wg syncconf` (no `Address`).
// Default → the full wg-quick format written to /etc/wireguard/wg0.conf.
export function renderControllerConfig(
  iface: ControllerInterfaceInput,
  peers: PeerBlockInput[],
  opts: { forSync?: boolean } = {},
): string {
  const forSync = opts.forSync === true;
  const head = forSync
    ? "" // syncconf reads this verbatim; keep it pure native config
    : "# Managed by ServerMind — do not edit by hand (regenerated on every fleet change).\n\n";
  const body = [renderControllerInterface(iface, forSync), ...peers.map((p) => renderControllerPeer(p))];
  return head + body.join("\n");
}
