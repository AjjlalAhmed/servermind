// check_port: is anything listening on a given TCP port, and what?

import { exec } from "./exec.ts";

export interface PortOutcome {
  ok: boolean;
  port: number;
  listening: boolean;
  detail: string;
  error?: string;
}

export async function checkPort(port: number): Promise<PortOutcome> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, port, listening: false, detail: "", error: `invalid port: ${port}` };
  }

  // ss with a filter expression. argv form — no shell, no injection.
  const r = await exec(["ss", "-tlnp", `sport = :${port}`], { timeoutMs: 8_000 });
  if (!r.ok && !r.stdout) {
    return {
      ok: false,
      port,
      listening: false,
      detail: r.stderr,
      error: "ss failed",
    };
  }

  // The header line is always present; a match adds at least one more line.
  const lines = r.stdout.trim().split("\n").filter(Boolean);
  const listening = lines.length > 1;

  return {
    ok: true,
    port,
    listening,
    detail: listening ? r.stdout.trim() : `nothing is listening on port ${port}`,
  };
}
