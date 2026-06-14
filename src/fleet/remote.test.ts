// End-to-end Phase 2: the controller invokes tools on a connected agent over the
// WebSocket, and the agent's OWN arm gate decides whether mutations run. Proves
// the controller cannot bypass the agent's safety boundary.

import { test, expect } from "bun:test";
import { startFleetHub, fleetWebSocket } from "./hub.ts";
import { startAgentConnector } from "./connector.ts";
import { RemoteAgent } from "./remote.ts";

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error("condition not met within timeout");
}

test("controller invokes tools on a remote agent; the agent enforces its own arm gate", async () => {
  startFleetHub(":memory:");
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/fleet/agent") { if (srv.upgrade(req, { data: { agentId: null } })) return undefined; }
      return new Response("ok");
    },
    websocket: fleetWebSocket,
  });

  const id = "itest-remote-00000001";
  const conn = startAgentConnector({
    controllerUrl: `ws://localhost:${server.port}/fleet/agent`,
    token: "test-join-token",
    agentId: id,
    hostname: "itest-remote",
    intervalMs: 100_000,
  });
  const agent = new RemoteAgent(id);

  try {
    // wait until the agent has enrolled (a status snapshot has landed)
    await waitFor(() => agent.status().then(() => true, () => false), 8_000);

    // 1) read-only tool runs remotely (a forbidden command is rejected by the
    //    allowlist, NOT the arm gate)
    const ro = await agent.invoke("run_shell", { command: "rm -rf /" }, false);
    expect(ro.isError).toBe(true);
    expect(ro.content).not.toContain("DISARMED");

    // 2) a mutation while the agent is DISARMED is refused by the agent
    const blocked = await agent.invoke("pm2_action", { action: "restart", name: "x" }, false);
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain("DISARMED");

    // 3) arm the agent (over the wire), then the same mutation is no longer
    //    DISARMED — it reaches execution (which fails for other reasons in test,
    //    but crucially the gate let it through)
    agent.setArmed(true);
    await new Promise((r) => setTimeout(r, 200)); // let the arm command apply on the agent
    const allowed = await agent.invoke("pm2_action", { action: "restart", name: "x" }, false);
    expect(allowed.content).not.toContain("DISARMED");
  } finally {
    conn.stop();
    server.stop(true);
  }
});
