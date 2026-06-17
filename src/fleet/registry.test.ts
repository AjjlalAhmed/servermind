// FleetRegistry — in-memory SQLite so there are no side effects.

import { test, expect, describe } from "bun:test";
import { FleetRegistry } from "./registry.ts";
import { allocateIp } from "./wireguard.ts";
import type { StatusSnapshot } from "../status.ts";

const snap = (host: string) => ({ host: { hostname: host } }) as unknown as StatusSnapshot;

describe("FleetRegistry", () => {
  test("registers, lists, and marks online by recency", () => {
    const r = new FleetRegistry(":memory:");
    const now = 1_000_000;
    r.register("a1", "web-1", now);
    r.register("a2", "db-1", now - 60_000); // last seen 60s ago → offline

    const list = r.list(now);
    expect(list.map((s) => s.hostname).sort()).toEqual(["db-1", "web-1"]);
    const web = list.find((s) => s.id === "a1")!;
    const db = list.find((s) => s.id === "a2")!;
    expect(web.online).toBe(true);
    expect(db.online).toBe(false);
    r.close();
  });

  test("setStatus attaches the latest snapshot and refreshes last-seen", () => {
    const r = new FleetRegistry(":memory:");
    const now = 2_000_000;
    r.register("a1", "web-1", now - 60_000);
    r.setStatus("a1", snap("web-1"), now);
    const s = r.list(now)[0]!;
    expect(s.online).toBe(true); // refreshed by setStatus
    expect((s.status as any).host.hostname).toBe("web-1");
    r.close();
  });

  test("remove drops the server", () => {
    const r = new FleetRegistry(":memory:");
    r.register("a1", "web-1");
    r.remove("a1");
    expect(r.list()).toEqual([]);
    r.close();
  });

  test("setTools / getTools store an agent's advertised tools; remove clears them", () => {
    const r = new FleetRegistry(":memory:");
    r.register("a1", "web-1");
    expect(r.getTools("a1")).toEqual([]);
    r.setTools("a1", [{ name: "orders_db", description: "the orders db", takesQuery: true }]);
    expect(r.getTools("a1")).toHaveLength(1);
    expect(r.getTools("a1")[0]!.name).toBe("orders_db");
    r.remove("a1");
    expect(r.getTools("a1")).toEqual([]);
    r.close();
  });
});

describe("FleetRegistry — WireGuard mesh", () => {
  test("setMesh / meshOf round-trips pubkey + ip", () => {
    const r = new FleetRegistry(":memory:");
    r.register("agent-1", "vps-1");
    expect(r.meshOf("agent-1")).toBeNull();
    r.setMesh("agent-1", "PUBKEY1", "10.99.0.2");
    expect(r.meshOf("agent-1")).toEqual({ pubkey: "PUBKEY1", ip: "10.99.0.2" });
    r.close();
  });

  test("usedIps + allocateIp never collide across enrollments", () => {
    const r = new FleetRegistry(":memory:");
    r.register("a", "va"); r.setMesh("a", "PA", allocateIp(r.usedIps())!);
    r.register("b", "vb"); r.setMesh("b", "PB", allocateIp(r.usedIps())!);
    r.register("c", "vc"); r.setMesh("c", "PC", allocateIp(r.usedIps())!);
    const ips = r.meshPeers().map((p) => p.ip);
    expect(ips).toEqual(["10.99.0.2", "10.99.0.3", "10.99.0.4"]);
    expect(new Set(ips).size).toBe(3);
    r.close();
  });

  test("re-enrollment is idempotent: a reinstalled box keeps its IP", () => {
    const r = new FleetRegistry(":memory:");
    r.register("a", "va"); r.setMesh("a", "PA", "10.99.0.2");
    r.register("b", "vb"); r.setMesh("b", "PB", "10.99.0.3");
    const existing = r.meshOf("a")!;
    r.setMesh("a", "PA-NEW", existing.ip); // reinstall: rotate key, keep ip
    expect(r.meshOf("a")).toEqual({ pubkey: "PA-NEW", ip: "10.99.0.2" });
    r.register("c", "vc"); r.setMesh("c", "PC", allocateIp(r.usedIps())!);
    expect(r.meshOf("c")!.ip).toBe("10.99.0.4"); // new box gets next free, not a's
    r.close();
  });

  test("register() preserves an existing mesh assignment (status refresh can't wipe it)", () => {
    const r = new FleetRegistry(":memory:");
    r.register("a", "va"); r.setMesh("a", "PA", "10.99.0.2");
    r.register("a", "va"); // routine re-register
    expect(r.meshOf("a")).toEqual({ pubkey: "PA", ip: "10.99.0.2" });
    r.close();
  });

  test("remove() revokes the peer: drops from meshPeers and frees its IP", () => {
    const r = new FleetRegistry(":memory:");
    r.register("a", "va"); r.setMesh("a", "PA", "10.99.0.2");
    r.register("b", "vb"); r.setMesh("b", "PB", "10.99.0.3");
    expect(r.meshPeers().map((p) => p.id)).toEqual(["a", "b"]);
    r.remove("a");
    expect(r.meshPeers().map((p) => p.id)).toEqual(["b"]);
    expect(r.usedIps()).toEqual(["10.99.0.3"]);
    expect(allocateIp(r.usedIps())).toBe("10.99.0.2"); // freed slot is reusable
    r.close();
  });
});
