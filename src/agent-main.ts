// Agent entry point — `bun run agent`.
//
// Runs ServerMind in agent-only mode: no web UI, no auth, no AI. It dials out to
// a controller and reports status. The box's safety boundary (read-only
// allowlist + arm switch) stays here and is enforced locally when the controller
// later invokes tools (Phase 2).
//
// Configure with env (or the install flags that set them):
//   SERVERMIND_CONTROLLER = wss://controller.example.com/fleet/agent
//   FLEET_JOIN_TOKEN      = <join token from the controller>

import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "./config.ts";
import { startAgentConnector } from "./fleet/connector.ts";

// A stable per-agent id, persisted so the controller recognizes this box across
// restarts. (Phase 2 swaps the shared join token for a per-agent credential.)
function loadAgentId(): string {
  const dir = new URL("../data/", import.meta.url).pathname;
  const file = dir + "agent-id";
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch { /* no id file yet — create one below */ }
  const id = process.env.SERVERMIND_AGENT_ID?.trim() || randomBytes(16).toString("hex");
  try { mkdirSync(dir, { recursive: true }); writeFileSync(file, id, { mode: 0o600 }); } catch { /* ignore */ }
  return id;
}

const controllerUrl = config.fleet.controllerUrl;
const token = config.fleet.joinToken;

if (!controllerUrl || !token) {
  console.error("agent: set SERVERMIND_CONTROLLER (ws/wss URL) and FLEET_JOIN_TOKEN, then `bun run agent`.");
  process.exit(1);
}

// The hello frame carries the (long-lived, shared) join token, so a plaintext
// ws:// hop to a remote controller would leak it to any on-path observer. Require
// wss:// unless the controller is local or insecure transport is explicitly
// opted into (FLEET_ALLOW_INSECURE=1, e.g. the docker-compose simulation).
{
  const insecureOk = /^(1|true|yes)$/i.test((process.env.FLEET_ALLOW_INSECURE || "").trim());
  let host = "";
  try { host = new URL(controllerUrl).hostname; } catch { console.error(`agent: invalid SERVERMIND_CONTROLLER URL: ${controllerUrl}`); process.exit(1); }
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (controllerUrl.startsWith("ws://") && !isLocal && !insecureOk) {
    console.error(
      `agent: refusing to send the join token over plaintext ws:// to '${host}'. ` +
        `Use wss:// (recommended), or set FLEET_ALLOW_INSECURE=1 for trusted local/test networks.`,
    );
    process.exit(1);
  }
}

const agentId = loadAgentId();
console.log(`\n  ServerMind agent — ${hostname()} (${agentId.slice(0, 8)}…)`);
console.log(`  → controller: ${controllerUrl}\n`);

startAgentConnector({
  controllerUrl,
  token,
  agentId,
  hostname: hostname(),
  version: "1.0.0",
  log: (m) => console.log(`  [agent] ${m}`),
});
