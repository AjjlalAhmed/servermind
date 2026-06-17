// Controller-side fleet hub: accepts agent WebSocket connections, authenticates
// the join token, and feeds status into the registry. Wired into Bun.serve in
// index.ts ONLY when FLEET_JOIN_TOKEN is set (otherwise standalone is untouched).

import { mkdirSync } from "node:fs";
import { timingSafeEqual, randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { config } from "../config.ts";
import type { DispatchResult } from "../tools/index.ts";
import { FleetRegistry } from "./registry.ts";
import { parseAgentMessage, invokeFrame, armFrame } from "./protocol.ts";

export interface WsData { agentId: string | null }

// Live agent connections + in-flight invoke requests awaiting a result.
const conns = new Map<string, ServerWebSocket<WsData>>();
const pending = new Map<string, { agentId: string; resolve: (r: DispatchResult) => void; timer: ReturnType<typeof setTimeout> }>();
const INVOKE_TIMEOUT_MS = 20_000;

export function fleetEnabled(): boolean {
  return config.fleet.joinToken !== "";
}

let registry: FleetRegistry | null = null;
export function fleetRegistry(): FleetRegistry | null {
  return registry;
}

function tokenOk(token: string): boolean {
  const a = Buffer.from(token);
  const b = Buffer.from(config.fleet.joinToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Same constant-time join-token check, for the HTTP enroll endpoint (index.ts).
export function fleetTokenOk(token: string): boolean {
  return fleetEnabled() && tokenOk(token);
}

// Bun WebSocket handlers for agent connections.
export const fleetWebSocket = {
  open(_ws: ServerWebSocket<WsData>) { /* await hello */ },
  message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
    const msg = parseAgentMessage(typeof raw === "string" ? raw : raw.toString("utf8"));
    if (!msg) return;

    if (msg.type === "hello") {
      if (!fleetEnabled() || !tokenOk(msg.data.token)) { ws.close(1008, "unauthorized"); return; }
      const id = msg.data.agentId;
      // Don't let a token holder silently hijack an id that's already connected —
      // refuse instead of overwriting the live socket (which would reroute that
      // agent's invokes/status to the newcomer).
      const live = conns.get(id);
      if (live && live !== ws) { ws.close(1008, "agent id already connected"); return; }
      // A known id must keep its recorded hostname; a different hostname on the
      // same id signals impersonation (a fresh box should use a fresh id).
      const known = registry?.hostnameOf(id);
      if (known && known !== msg.data.hostname) { ws.close(1008, "agent id/hostname mismatch"); return; }
      ws.data.agentId = id;
      conns.set(id, ws);
      registry?.register(id, msg.data.hostname);
      // Record the custom tools this agent exposes (names only) so the AI can be
      // offered them when an operator manages this server.
      registry?.setTools(id, msg.data.tools ?? []);
      ws.send(JSON.stringify({ type: "welcome" }));
      return;
    }

    if (msg.type === "status") {
      if (!ws.data.agentId) { ws.close(1008, "hello required first"); return; } // must enroll before sending data
      registry?.setStatus(ws.data.agentId, msg.snapshot);
      return;
    }

    if (msg.type === "result") {
      if (!ws.data.agentId) { ws.close(1008, "hello required first"); return; } // must enroll first
      const p = pending.get(msg.reqId);
      // Only the agent the invoke was dispatched to may answer it — otherwise any
      // connected socket that guessed a reqId could inject a forged tool result.
      if (p && p.agentId === ws.data.agentId) {
        clearTimeout(p.timer); pending.delete(msg.reqId); p.resolve({ content: msg.content, isError: msg.isError });
      }
    }
  },
  close(ws: ServerWebSocket<WsData>) {
    if (ws.data.agentId && conns.get(ws.data.agentId) === ws) conns.delete(ws.data.agentId);
    // last status is kept; the registry flips the agent "offline" after the timeout
  },
};

// Send a tool invocation to an agent and await its result. The agent enforces
// its OWN allowlist + arm gate — the controller cannot bypass them.
export function sendInvoke(agentId: string, name: string, input: unknown): Promise<DispatchResult> {
  const ws = conns.get(agentId);
  if (!ws) return Promise.resolve({ content: `agent '${agentId}' is offline`, isError: true });
  const reqId = randomUUID();
  return new Promise<DispatchResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      resolve({ content: `agent '${agentId}' did not respond in time`, isError: true });
    }, INVOKE_TIMEOUT_MS);
    pending.set(reqId, { agentId, resolve, timer });
    ws.send(invokeFrame(reqId, name, input));
  });
}

// Ask an agent to flip its own arm switch. Returns false if it's offline.
export function sendArm(agentId: string, on: boolean): boolean {
  const ws = conns.get(agentId);
  if (!ws) return false;
  ws.send(armFrame(on));
  return true;
}

export function isAgentConnected(agentId: string): boolean {
  return conns.has(agentId);
}

// Drop an agent: close its connection (if any) and forget it. A still-running
// agent will re-enroll on reconnect — true credential revocation arrives with
// per-agent tokens (a later phase); this clears stale/offline entries.
export function removeAgent(agentId: string): void {
  const ws = conns.get(agentId);
  if (ws) { try { ws.close(1000, "removed"); } catch { /* ignore */ } conns.delete(agentId); }
  registry?.remove(agentId);
}

// Initialize the registry (persisted to data/fleet.db). Call once at startup
// when the hub is enabled. `dbPath` override is used by tests.
export function startFleetHub(dbPath?: string): FleetRegistry {
  if (!dbPath) {
    const dir = new URL("../../data/", import.meta.url).pathname;
    try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    dbPath = dir + "fleet.db";
  }
  registry = new FleetRegistry(dbPath);
  return registry;
}
