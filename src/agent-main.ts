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
