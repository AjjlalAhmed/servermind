// Controller-side fleet hub: accepts agent WebSocket connections, authenticates
// the join token, and feeds status into the registry. Wired into Bun.serve in
// index.ts ONLY when FLEET_JOIN_TOKEN is set (otherwise standalone is untouched).

import { mkdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { config } from "../config.ts";
import { FleetRegistry } from "./registry.ts";
import { parseAgentMessage } from "./protocol.ts";

export interface WsData { agentId: string | null }

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

// Bun WebSocket handlers for agent connections.
export const fleetWebSocket = {
  open(_ws: ServerWebSocket<WsData>) { /* await hello */ },
  message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
    const msg = parseAgentMessage(typeof raw === "string" ? raw : raw.toString("utf8"));
    if (!msg) return;

    if (msg.type === "hello") {
      if (!fleetEnabled() || !tokenOk(msg.data.token)) { ws.close(1008, "unauthorized"); return; }
      ws.data.agentId = msg.data.agentId;
      registry?.register(msg.data.agentId, msg.data.hostname);
      ws.send(JSON.stringify({ type: "welcome" }));
      return;
    }

    if (msg.type === "status") {
      if (!ws.data.agentId) { ws.close(1008, "hello required first"); return; } // must enroll before sending data
      registry?.setStatus(ws.data.agentId, msg.snapshot);
    }
  },
  close(_ws: ServerWebSocket<WsData>) { /* keep last status; "online" flips off on timeout */ },
};

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
