// Tests for Server Memory rendering + note derivation. Hermetic: they exercise
// the pure helpers with a synthetic profile, so no probes run and no file is
// written.

import { test, expect, describe } from "bun:test";
import { deriveNotes, renderProfileBlock, getServerProfileBlock, type ServerProfile } from "./profile.ts";

const sample: ServerProfile = {
  updatedAt: "2026-06-24T00:00:00.000Z",
  host: { hostname: "box", uname: "Linux box 6.8.0", uptime: "up 3 days", cores: 4 },
  resources: { memUsedPct: 88, memTotal: "3.8G", diskUsedPct: 20, swap: "none" },
  services: { monitored: { nginx: "active", mysql: "failed" }, failed: ["worker-daemon.service"] },
  pm2: ["api", "web"],
  ports: [{ port: 80, proc: "nginx" }, { port: 3306, proc: "mysqld" }, { port: 6379, proc: "" }],
  datastores: { redis: "ok", mysql: "down" },
  customTools: ["emaildb"],
  notes: [],
};

describe("deriveNotes", () => {
  const notes = deriveNotes(sample);
  test("flags a failed unit", () => {
    expect(notes.some((n) => n.includes("failed systemd unit") && n.includes("worker-daemon.service"))).toBe(true);
  });
  test("flags a non-active monitored unit", () => {
    expect(notes.some((n) => n.includes("mysql") && n.includes("failed"))).toBe(true);
  });
  test("flags missing swap and high memory pressure", () => {
    expect(notes.some((n) => n.includes("no swap"))).toBe(true);
    expect(notes.some((n) => n.includes("memory pressure"))).toBe(true);
  });
  test("does not flag disk when usage is low", () => {
    expect(notes.some((n) => n.includes("disk pressure"))).toBe(false);
  });
  test("flags a down datastore", () => {
    expect(notes.some((n) => n.toLowerCase().includes("mysql probe"))).toBe(true);
  });
});

describe("renderProfileBlock", () => {
  const block = renderProfileBlock({ ...sample, notes: deriveNotes(sample) });
  test("includes the header and host line", () => {
    expect(block).toContain("Server profile");
    expect(block).toContain("box");
    expect(block).toContain("4 cores");
  });
  test("surfaces FAILED units prominently", () => {
    expect(block).toContain("FAILED: worker-daemon.service");
  });
  test("lists ports (with and without a process name) and custom tools", () => {
    expect(block).toContain("80(nginx)");
    expect(block).toContain("6379"); // no proc name → bare port
    expect(block).toContain("Custom tools available: emaildb");
  });
  test("includes a Notes line when notes exist", () => {
    expect(block).toContain("Notes:");
  });
});

describe("getServerProfileBlock", () => {
  test("is empty before any refresh has populated the cache", () => {
    expect(getServerProfileBlock()).toBe("");
  });
});
