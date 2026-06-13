// read_log: tail the last N lines from a known, safe log path.

import { exec } from "./exec.ts";
import { config } from "../config.ts";

// Roots a log may live under. Anything outside these is refused.
const ALLOWED_ROOTS = [
  "/var/log/",
  "/home/", // pm2 logs typically live in ~/.pm2/logs — narrowed to */.pm2/logs below
  "/root/.pm2/logs/",
  ...config.extraLogPaths.map((p) => p.replace(/\/?$/, "/")),
];

function isAllowed(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path.includes("..")) return false;
  // Home-dir logs are only allowed under a .pm2/logs subdir.
  if (path.startsWith("/home/") && !path.includes("/.pm2/logs/")) return false;
  return ALLOWED_ROOTS.some((root) => path.startsWith(root));
}

export interface LogOutcome {
  ok: boolean;
  path: string;
  lines: number;
  content: string;
  error?: string;
}

export async function readLog(path: string, lines = 100): Promise<LogOutcome> {
  const n = Math.min(Math.max(Math.trunc(lines) || 100, 1), 1000);

  if (!isAllowed(path)) {
    return {
      ok: false,
      path,
      lines: n,
      content: "",
      error: `path not allowed (must be under ${ALLOWED_ROOTS.join(", ")} and contain no '..')`,
    };
  }

  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { ok: false, path, lines: n, content: "", error: "file does not exist" };
  }

  const r = await exec(["tail", "-n", String(n), path], { timeoutMs: 10_000 });
  return {
    ok: r.ok,
    path,
    lines: n,
    content: r.stdout || r.stderr,
    error: r.ok ? undefined : "tail failed",
  };
}
