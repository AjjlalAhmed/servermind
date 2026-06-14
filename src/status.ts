// Aggregated point-in-time snapshot of every monitored service. Backs the
// GET /status route and the UI status strip. All probes run in parallel and
// failures are captured per-probe rather than failing the whole snapshot.

import * as os from "node:os";
import { config } from "./config.ts";
import { getMonitoredUnits } from "./settings.ts";
import { exec } from "./tools/exec.ts";
import { pm2Action } from "./tools/pm2.ts";
import { redisProbe } from "./tools/redis.ts";
import { mysqlPing } from "./tools/mysql.ts";

async function systemctlActive(unit: string): Promise<{ unit: string; active: string }> {
  const r = await exec(["systemctl", "is-active", unit], { timeoutMs: 6_000 });
  return { unit, active: (r.stdout || r.stderr).trim() || "unknown" };
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0] ?? "";
}

// Parse `free -b` into structured byte counts. Columns: total used free shared
// buff/cache available. Meaningful pressure metric = (total - available)/total.
function parseFreeBytes(raw: string) {
  const out: { totalBytes: number; usedBytes: number; availBytes: number; usedPct: number; swapTotal: number; swapUsed: number } =
    { totalBytes: 0, usedBytes: 0, availBytes: 0, usedPct: 0, swapTotal: 0, swapUsed: 0 };
  for (const line of raw.split("\n")) {
    const c = line.trim().split(/\s+/);
    if (/^Mem:/i.test(line)) {
      out.totalBytes = +c[1]! || 0;
      out.availBytes = +c[6]! || +c[3]! || 0;
      out.usedBytes = out.totalBytes - out.availBytes;
      out.usedPct = out.totalBytes ? Math.round((out.usedBytes / out.totalBytes) * 100) : 0;
    } else if (/^Swap:/i.test(line)) {
      out.swapTotal = +c[1]! || 0;
      out.swapUsed = +c[2]! || 0;
    }
  }
  return out;
}

// Parse `df -P <mount>` data line: Filesystem 1024-blocks Used Available Capacity Mounted.
function parseDf(raw: string) {
  const line = raw.trim().split("\n")[1] ?? "";
  const c = line.trim().split(/\s+/);
  const blocks = +c[1]! || 0, used = +c[2]! || 0, avail = +c[3]! || 0;
  return {
    sizeBytes: blocks * 1024,
    usedBytes: used * 1024,
    availBytes: avail * 1024,
    usedPct: parseInt(c[4] ?? "0", 10) || 0,
    mount: c[5] ?? "/",
  };
}

export interface StatusSnapshot {
  timestamp: string;
  host: { uname: string; hostname: string; uptime: string };
  cpu: { loadavg: string; cores: number };
  memory: { raw: string };
  disk: { raw: string };
  metrics: {
    cpu: { load1: number; load5: number; load15: number; cores: number };
    memory: ReturnType<typeof parseFreeBytes>;
    disk: ReturnType<typeof parseDf>;
  };
  pm2: { ok: boolean; processes?: unknown; error?: string };
  redis: unknown;
  mysql: { ok: boolean; detail: string };
  services: Record<string, string>;
}

export async function getStatusSnapshot(): Promise<StatusSnapshot> {
  const [uname, uptime, loadavg, mem, memBytes, disk, dfRoot, pm2, redis, mysql, units] = await Promise.all([
    exec(["uname", "-a"], { timeoutMs: 5_000 }),
    exec(["uptime", "-p"], { timeoutMs: 5_000 }),
    exec(["cat", "/proc/loadavg"], { timeoutMs: 5_000 }),
    exec(["free", "-h"], { timeoutMs: 5_000 }),
    exec(["free", "-b"], { timeoutMs: 5_000 }),
    exec(["df", "-h"], { timeoutMs: 6_000 }),
    exec(["df", "-P", "/"], { timeoutMs: 6_000 }),
    pm2Action("list"),
    redisProbe(),
    mysqlPing(),
    Promise.all(getMonitoredUnits().map(systemctlActive)),
  ]);

  const services: Record<string, string> = {};
  for (const s of units) services[s.unit] = s.active;

  const cores = os.cpus()?.length || 0;
  const la = loadavg.stdout.trim().split(/\s+/);

  return {
    timestamp: new Date().toISOString(),
    host: {
      uname: uname.stdout.trim(),
      hostname: os.hostname(),
      uptime: uptime.stdout.trim() || uptime.stderr.trim(),
    },
    cpu: {
      loadavg: loadavg.stdout.trim(),
      cores,
    },
    memory: { raw: mem.stdout.trim() },
    disk: { raw: disk.stdout.trim() },
    metrics: {
      cpu: { load1: +la[0]! || 0, load5: +la[1]! || 0, load15: +la[2]! || 0, cores },
      memory: parseFreeBytes(memBytes.stdout),
      disk: parseDf(dfRoot.stdout),
    },
    pm2: pm2.ok
      ? { ok: true, processes: pm2.processes ?? pm2.output }
      : { ok: false, error: pm2.error },
    redis,
    mysql: { ok: mysql.ok, detail: firstLine(mysql.output) },
    services,
  };
}
