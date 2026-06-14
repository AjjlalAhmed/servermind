// Tests for alert evaluation + digest building (pure functions).

import { test, expect, describe } from "bun:test";
import { evaluateAlerts, buildDigest, buildFleetDigest } from "./report.ts";
import type { StatusSnapshot } from "../status.ts";

function snap(over: { disk?: number; mem?: number; services?: Record<string, string> } = {}): StatusSnapshot {
  return {
    timestamp: "2026-06-14T00:00:00.000Z",
    host: { uname: "Linux test", hostname: "testbox", uptime: "up 3 days" },
    cpu: { loadavg: "0.1 0.2 0.3", cores: 4 },
    memory: { raw: "" },
    disk: { raw: "" },
    metrics: {
      cpu: { load1: 0.1, load5: 0.2, load15: 0.3, cores: 4 },
      memory: { totalBytes: 100, usedBytes: 0, availBytes: 0, usedPct: over.mem ?? 30, swapTotal: 0, swapUsed: 0 },
      disk: { sizeBytes: 100, usedBytes: 0, availBytes: 0, usedPct: over.disk ?? 40, mount: "/" },
    },
    pm2: { ok: true, processes: [{ name: "api", pm_id: 0, status: "online", cpu: 1, memoryMB: 80, restarts: 0, uptime: 1 }] },
    redis: {},
    mysql: { ok: true, detail: "" },
    services: over.services ?? { nginx: "active", redis: "active" },
  } as StatusSnapshot;
}

describe("evaluateAlerts", () => {
  test("a healthy server produces no alerts", () => {
    expect(evaluateAlerts(snap())).toEqual([]);
  });

  test("high disk, high memory, and a downed service each alert", () => {
    const alerts = evaluateAlerts(snap({ disk: 95, mem: 96, services: { nginx: "inactive", redis: "active" } }));
    const keys = alerts.map((a) => a.key).sort();
    expect(keys).toEqual(["disk", "mem", "svc:nginx"]);
  });

  test("a service in any non-active state alerts", () => {
    const alerts = evaluateAlerts(snap({ services: { caddy: "failed" } }));
    expect(alerts.some((a) => a.key === "svc:caddy")).toBe(true);
  });
});

describe("buildDigest", () => {
  test("clean server → 'all good' subject, no issues listed", () => {
    const d = buildDigest(snap());
    expect(d.subject).toContain("all good");
    expect(d.body).toContain("All checks passing");
    expect(d.body).toContain("testbox");
  });

  test("problems → issue count in subject and body", () => {
    const d = buildDigest(snap({ disk: 99 }));
    expect(d.subject).toContain("1 issue");
    expect(d.body).toContain("need attention");
  });
});

describe("buildFleetDigest", () => {
  test("covers the controller + every agent and counts fleet-wide issues", () => {
    const d = buildFleetDigest(snap(), [
      { hostname: "web-1", online: true, status: snap() },
      { hostname: "db-1", online: false, status: null },
      { hostname: "cache-1", online: true, status: snap({ disk: 99 }) },
    ]);
    expect(d.subject).toContain("4 servers"); // controller + 3 agents
    expect(d.subject).toContain("issue");      // db-1 offline + cache-1 disk = 2 issues
    expect(d.body).toContain("web-1");
    expect(d.body).toContain("db-1 — OFFLINE");
    expect(d.body).toContain("(controller)");
  });
});
