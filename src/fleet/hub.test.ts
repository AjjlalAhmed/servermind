// End-to-end: spin up the controller hub + the agent connector in one process
// and verify enrollment + status actually flow over a real WebSocket. This
// proves the transport works without needing two machines.
//
// The join token comes from test-preload.ts (FLEET_JOIN_TOKEN=test-join-token).

import { test, expect } from "bun:test";
import { startFleetHub, fleetRegistry, fleetWebSocket } from "./hub.ts";
import { startAgentConnector } from "./connector.ts";

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("condition not met within timeout");
}

test("agent enrolls and its status reaches the controller registry", async () => {
  startFleetHub(":memory:");

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/fleet/agent") {
        if (srv.upgrade(req, { data: { agentId: null } })) return undefined;
        return new Response("expected websocket", { status: 426 });
      }
      return new Response("ok");
    },
    websocket: fleetWebSocket,
  });

  const id = "itest-agent-00000001";
  const agent = startAgentConnector({
    controllerUrl: `ws://localhost:${server.port}/fleet/agent`,
    token: "test-join-token",
    agentId: id,
    hostname: "itest-host",
    intervalMs: 100_000, // we only need the initial push
  });

  try {
    await waitFor(() => !!fleetRegistry()?.list().some((s) => s.id === id && s.status !== null), 8_000);
    const me = fleetRegistry()!.list().find((s) => s.id === id)!;
    expect(me.hostname).toBe("itest-host");
    expect(me.online).toBe(true);
    expect(me.status).not.toBeNull();
  } finally {
    agent.stop();
    server.stop(true);
  }
});

test("a wrong join token is rejected (agent never enrolls)", async () => {
  startFleetHub(":memory:");
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/fleet/agent") { if (srv.upgrade(req, { data: { agentId: null } })) return undefined; }
      return new Response("ok");
    },
    websocket: fleetWebSocket,
  });

  const agent = startAgentConnector({
    controllerUrl: `ws://localhost:${server.port}/fleet/agent`,
    token: "WRONG-token",
    agentId: "itest-agent-bad000001",
    hostname: "evil-host",
    intervalMs: 100_000,
  });

  try {
    await new Promise((r) => setTimeout(r, 600)); // give it a chance to (fail to) enroll
    expect(fleetRegistry()!.list().some((s) => s.id === "itest-agent-bad000001")).toBe(false);
  } finally {
    agent.stop();
    server.stop(true);
  }
});
