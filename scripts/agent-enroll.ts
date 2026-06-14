// Agent-side mesh enrollment (run by setup-mesh-agent.sh at install time).
//
// Generates THIS box's WireGuard keypair locally — the private key never leaves
// the machine; only the public key is sent to the controller. Enrolls over the
// controller's public HTTP endpoint (the one bootstrap hop), writes wg0.conf, and
// prints the controller's MESH ws URL on stdout for the installer to wire in.
//
// All diagnostics go to stderr so stdout is exactly the mesh URL.
//
// Env: SERVERMIND_CONTROLLER (public wss URL), FLEET_JOIN_TOKEN,
//      [SERVERMIND_AGENT_ID], [WG_DIR=/etc/wireguard], [WG_IFACE=wg0]

import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeypair, renderAgentConfig } from "../src/fleet/wireguard.ts";

const log = (m: string) => console.error(`  [enroll] ${m}`);
const fail = (m: string): never => { console.error(`  enrollment failed: ${m}`); process.exit(1); };

const controllerUrl = (process.env.SERVERMIND_CONTROLLER || "").trim();
const token = (process.env.FLEET_JOIN_TOKEN || "").trim();
const wgDir = process.env.WG_DIR || "/etc/wireguard";
const iface = process.env.WG_IFACE || "wg0";
if (!controllerUrl || !token) fail("set SERVERMIND_CONTROLLER and FLEET_JOIN_TOKEN.");

// A stable per-agent id, shared with agent-main.ts (same data/agent-id file).
function loadAgentId(): string {
  const dir = new URL("../data/", import.meta.url).pathname;
  const file = dir + "agent-id";
  try { const e = readFileSync(file, "utf8").trim(); if (e) return e; } catch { /* create below */ }
  const id = process.env.SERVERMIND_AGENT_ID?.trim() || randomBytes(16).toString("hex");
  try { mkdirSync(dir, { recursive: true }); writeFileSync(file, id, { mode: 0o600 }); } catch { /* ignore */ }
  return id;
}

// Derive the enroll endpoint from the (public) controller ws URL:
//   wss://host/fleet/agent  →  https://host/fleet/enroll
const enrollUrl = controllerUrl.replace(/^ws/, "http").replace(/\/fleet\/agent\/?$/, "/fleet/enroll");

const agentId = loadAgentId();
const host = hostname();
const kp = generateKeypair(); // private key stays here — only kp.publicKey is sent

log(`enrolling ${host} (${agentId.slice(0, 8)}…) at ${enrollUrl}`);
let data: { assignedIp: string; controllerPublicKey: string; controllerEndpoint: string; cidr: string; controllerMeshUrl: string };
try {
  const resp = await fetch(enrollUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, agentId, hostname: host, pubkey: kp.publicKey }),
  });
  if (!resp.ok) fail(`controller returned ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  data = await resp.json();
} catch (e) {
  fail(`could not reach the controller enroll endpoint: ${(e as Error).message}`);
}

if (!data!.assignedIp || !data!.controllerMeshUrl) fail("controller response missing fields.");

const conf = renderAgentConfig({
  agentPrivateKey: kp.privateKey,
  agentIp: data!.assignedIp,
  controllerPublicKey: data!.controllerPublicKey,
  controllerEndpoint: data!.controllerEndpoint,
  m: { cidr: data!.cidr },
});
mkdirSync(wgDir, { recursive: true });
writeFileSync(`${wgDir}/${iface}.conf`, conf, { mode: 0o600 });
log(`assigned ${data!.assignedIp}; wrote ${wgDir}/${iface}.conf`);

// stdout = exactly the mesh URL the installer should set as SERVERMIND_CONTROLLER.
console.log(data!.controllerMeshUrl);
