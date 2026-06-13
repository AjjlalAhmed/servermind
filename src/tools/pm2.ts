// pm2_action: inspect and control PM2-managed processes.

import { exec } from "./exec.ts";
import { config } from "../config.ts";

// PM2 invocation (e.g. ["pm2"] or ["sudo","-n","pm2"]). PM2 is per-user, so this
// is how ServerMind reaches another user's PM2 daemon when configured.
const PM2 = config.pm2Command;

export type Pm2Action = "list" | "restart" | "stop" | "start" | "logs";

// Process names: alnum, dash, underscore, dot. No shell chars (we don't shell
// out anyway, but this keeps inputs sane and avoids flag injection).
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

const MUTATING: Pm2Action[] = ["restart", "stop", "start"];

export interface Pm2Outcome {
  ok: boolean;
  action: Pm2Action;
  name?: string;
  output: string;
  processes?: Pm2ProcessSummary[];
  error?: string;
}

export interface Pm2ProcessSummary {
  name: string;
  pm_id: number;
  status: string;
  cpu: number;
  memoryMB: number;
  restarts: number;
  uptime: number | null;
}

export async function pm2Action(action: Pm2Action, name?: string): Promise<Pm2Outcome> {
  if (MUTATING.includes(action) || action === "logs") {
    if (action !== "restart" || name) {
      // restart can target "all"; everything else needs a name except list
    }
  }

  if (action !== "list" && action !== "restart" && !name) {
    return fail(action, `pm2 ${action} requires a process name`);
  }
  if (name && name !== "all" && !NAME_RE.test(name)) {
    return fail(action, `invalid process name: ${name}`);
  }

  switch (action) {
    case "list": {
      const r = await exec([...PM2, "jlist"], { timeoutMs: 10_000 });
      if (!r.ok) {
        // Fall back to a plain text listing if jlist fails (e.g. pm2 not init'd)
        const plain = await exec([...PM2, "list"], { timeoutMs: 10_000 });
        return {
          ok: plain.ok,
          action,
          output: plain.stdout || plain.stderr,
          error: plain.ok ? undefined : "pm2 list failed",
        };
      }
      return {
        ok: true,
        action,
        output: r.stdout,
        processes: parseJlist(r.stdout),
      };
    }

    case "logs": {
      // Non-streaming snapshot of recent logs (--nostream prints then exits).
      const r = await exec([...PM2, "logs", name!, "--lines", "60", "--nostream"], {
        timeoutMs: 12_000,
      });
      return {
        ok: r.ok,
        action,
        name,
        output: r.stdout || r.stderr,
        error: r.ok ? undefined : "pm2 logs failed",
      };
    }

    case "restart":
    case "stop":
    case "start": {
      const target = name ?? "all";
      const r = await exec([...PM2, action, target], { timeoutMs: 20_000 });
      return {
        ok: r.ok,
        action,
        name: target,
        output: r.stdout || r.stderr,
        error: r.ok ? undefined : `pm2 ${action} ${target} failed`,
      };
    }
  }
}

function parseJlist(raw: string): Pm2ProcessSummary[] {
  try {
    const arr = JSON.parse(raw) as any[];
    return arr.map((p) => ({
      name: p.name,
      pm_id: p.pm_id,
      status: p.pm2_env?.status ?? "unknown",
      cpu: p.monit?.cpu ?? 0,
      memoryMB: Math.round((p.monit?.memory ?? 0) / 1024 / 1024),
      restarts: p.pm2_env?.restart_time ?? 0,
      uptime: p.pm2_env?.pm_uptime ?? null,
    }));
  } catch {
    return [];
  }
}

function fail(action: Pm2Action, error: string): Pm2Outcome {
  return { ok: false, action, output: "", error };
}
