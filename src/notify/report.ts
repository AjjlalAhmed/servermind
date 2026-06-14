// Turns a StatusSnapshot into (a) discrete alerts when thresholds are crossed
// and (b) a human-readable daily digest. Pure functions — no I/O — so they're
// easy to reason about and test.

import { getAlerts } from "../settings.ts";
import type { StatusSnapshot } from "../status.ts";

export interface Alert {
  key: string; // stable id used for alert cooldown
  subject: string;
  body: string;
}

export function evaluateAlerts(s: StatusSnapshot): Alert[] {
  const host = s.host.hostname || "server";
  const out: Alert[] = [];

  if (s.metrics.disk.usedPct >= getAlerts().diskPct) {
    out.push({
      key: "disk",
      subject: `⚠️ ${host}: disk ${s.metrics.disk.usedPct}% full`,
      body: `Disk usage on ${s.metrics.disk.mount} is ${s.metrics.disk.usedPct}% (alert threshold ${getAlerts().diskPct}%).`,
    });
  }
  if (s.metrics.memory.usedPct >= getAlerts().memPct) {
    out.push({
      key: "mem",
      subject: `⚠️ ${host}: memory ${s.metrics.memory.usedPct}%`,
      body: `Memory usage is ${s.metrics.memory.usedPct}% (alert threshold ${getAlerts().memPct}%).`,
    });
  }
  for (const [unit, state] of Object.entries(s.services)) {
    if (state !== "active") {
      out.push({
        key: `svc:${unit}`,
        subject: `🔴 ${host}: ${unit} is ${state}`,
        body: `Service ${unit} is "${state}" (expected "active").`,
      });
    }
  }
  return out;
}

// A single digest covering the whole fleet — the controller's own box plus every
// connected agent, one line each, with a fleet-wide issue count.
export function buildFleetDigest(
  controller: StatusSnapshot,
  agents: Array<{ hostname: string; online: boolean; status: StatusSnapshot | null }>,
): { subject: string; body: string } {
  let issues = 0;
  const line = (name: string, online: boolean, s: StatusSnapshot | null): string => {
    if (!online) { issues++; return `  ✗ ${name} — OFFLINE`; }
    if (!s) return `  • ${name} — no data yet`;
    const n = evaluateAlerts(s).length;
    issues += n;
    return `  ${n ? "⚠" : "✓"} ${name} — disk ${s.metrics.disk.usedPct}%, mem ${s.metrics.memory.usedPct}%, load ${s.metrics.cpu.load1}${n ? ` (${n} issue${n > 1 ? "s" : ""})` : ""}`;
  };

  const L: string[] = [];
  L.push("ServerMind fleet report");
  L.push(new Date().toISOString());
  L.push("");
  L.push(line(`${controller.host.hostname || "controller"} (controller)`, true, controller));
  for (const ag of agents) L.push(line(ag.hostname, ag.online, ag.status));
  L.push("");
  L.push(issues ? `⚠️  ${issues} issue(s) across ${agents.length + 1} server(s).` : `✓  All ${agents.length + 1} servers healthy.`);
  L.push("");
  L.push("— ServerMind");

  return {
    subject: `ServerMind fleet: ${agents.length + 1} servers — ${issues ? `${issues} issue(s)` : "all good"}`,
    body: L.join("\n"),
  };
}

export function buildDigest(s: StatusSnapshot): { subject: string; body: string } {
  const host = s.host.hostname || "server";
  const alerts = evaluateAlerts(s);
  const L: string[] = [];

  L.push(`ServerMind daily report — ${host}`);
  L.push(s.timestamp);
  L.push("");
  L.push(`CPU load   : ${s.metrics.cpu.load1} (1m)  ·  ${s.metrics.cpu.cores} cores`);
  L.push(`Memory     : ${s.metrics.memory.usedPct}% used`);
  L.push(`Disk (${s.metrics.disk.mount}) : ${s.metrics.disk.usedPct}% used`);
  if (s.host.uptime) L.push(`Uptime     : ${s.host.uptime}`);

  L.push("");
  L.push("Services");
  const svc = Object.entries(s.services);
  if (svc.length) for (const [unit, state] of svc) L.push(`  ${state === "active" ? "✓" : "✗"} ${unit} — ${state}`);
  else L.push("  (none monitored)");

  if (s.pm2?.ok && Array.isArray(s.pm2.processes) && s.pm2.processes.length) {
    L.push("");
    L.push("PM2 processes");
    for (const p of s.pm2.processes as Array<{ name: string; status: string; cpu: number; memoryMB: number; restarts: number }>) {
      L.push(`  ${p.status === "online" ? "✓" : "✗"} ${p.name} — ${p.status} (cpu ${p.cpu}% · ${p.memoryMB}MB · ↻${p.restarts})`);
    }
  }

  L.push("");
  L.push(alerts.length ? `⚠️  ${alerts.length} issue(s) need attention:` : "✓  All checks passing.");
  for (const a of alerts) L.push(`   - ${a.body}`);
  L.push("");
  L.push("— ServerMind");

  return {
    subject: `ServerMind: ${host} — ${alerts.length ? `${alerts.length} issue(s)` : "all good"}`,
    body: L.join("\n"),
  };
}
