// FleetRegistry — in-memory SQLite so there are no side effects.

import { test, expect, describe } from "bun:test";
import { FleetRegistry } from "./registry.ts";
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
});
