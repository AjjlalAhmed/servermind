// Fleet-aware AI tools: fleet_list summarizes the registry; fleet_run targets a
// server (and errors helpfully on an unknown one).

import { test, expect, describe } from "bun:test";
import { startFleetHub } from "./hub.ts";
import { dispatchFleetTool, isFleetTool, agentCustomToolDefs } from "./tools.ts";
import type { StatusSnapshot } from "../status.ts";

const snap = (over: { disk?: number; mem?: number }) => ({
  metrics: { cpu: { load1: 0.5, cores: 4 }, memory: { usedPct: over.mem ?? 30 }, disk: { usedPct: over.disk ?? 40 } },
  redis: { connected: true },
  mysql: { ok: true },
  pm2: { ok: true, processes: [{}, {}] },
}) as unknown as StatusSnapshot;

describe("fleet tools", () => {
  test("isFleetTool recognizes fleet tools (with or without mcp prefix)", () => {
    expect(isFleetTool("fleet_list")).toBe(true);
    expect(isFleetTool("mcp__servermind__fleet_run")).toBe(true);
    expect(isFleetTool("run_shell")).toBe(false);
  });

  test("fleet_list summarizes every server's health", async () => {
    const reg = startFleetHub(":memory:");
    reg.register("a1", "web-1");
    reg.setStatus("a1", snap({ disk: 55 }));
    reg.register("a2", "db-1");
    reg.setStatus("a2", snap({ disk: 95 }));

    const r = await dispatchFleetTool("fleet_list", {});
    expect(r.isError).toBe(false);
    const d = JSON.parse(r.content);
    expect(d.count).toBe(2);
    const web = d.servers.find((s: any) => s.server === "web-1");
    expect(web.redis).toBe(true);
    expect(web.mysql).toBe(true);
    expect(web.pm2).toBe(2);
    expect(d.servers.find((s: any) => s.server === "db-1").diskPct).toBe(95);
  });

  test("fleet_run on an unknown server returns a helpful error", async () => {
    startFleetHub(":memory:");
    const r = await dispatchFleetTool("fleet_run", { server: "ghost", tool: "run_shell", input: { command: "df -h" } });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("no server matches");
  });

  test("fleet_run rejects a non-allowlisted tool", async () => {
    startFleetHub(":memory:");
    const r = await dispatchFleetTool("fleet_run", { server: "all", tool: "rm", input: {} });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("must be one of");
  });

  test("agentCustomToolDefs builds OpenAI defs from an agent's advertised tools", () => {
    const reg = startFleetHub(":memory:");
    reg.register("a1", "web-1");
    reg.setTools("a1", [
      { name: "active_orders", description: "count active orders", takesQuery: false },
      { name: "orders_db", description: "query the orders db", takesQuery: true },
    ]);
    const defs = agentCustomToolDefs("a1");
    expect(defs.map((d) => d.function.name).sort()).toEqual(["active_orders", "orders_db"]);
    const frozen = defs.find((d) => d.function.name === "active_orders")!;
    expect(frozen.function.parameters.required).toEqual([]);
    const console = defs.find((d) => d.function.name === "orders_db")!;
    expect(console.function.parameters.required).toEqual(["query"]);
    expect((console.function.parameters.properties as any).query.type).toBe("string");
    // An agent with nothing advertised yields no defs.
    expect(agentCustomToolDefs("missing")).toEqual([]);
  });
});
