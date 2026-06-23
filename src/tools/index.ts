// Tool registry: the tool specs exposed to Claude (via the MCP server), plus
// the dispatcher that maps a tool name + input to real execution.
//
// These run inside the ServerMind MCP stdio server (src/mcp-server.ts), which
// the `claude` CLI launches as a subprocess. Claude can therefore only invoke
// these whitelisted, self-validating tools — never a raw shell.

import { z, type ZodRawShape } from "zod";
import { runShell } from "./shell.ts";
import { pm2Action, type Pm2Action } from "./pm2.ts";
import { serviceAction, type ServiceAction } from "./service.ts";
import { checkPort } from "./port.ts";
import { readLog } from "./log.ts";
import { dispatchCustomTool, isCustomTool, customToolMutating } from "./custom.ts";

export interface ToolSpec {
  name: string;
  description: string;
  schema: ZodRawShape;
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "run_shell",
    description:
      "Run a single read-only diagnostic shell command from a strict allowlist: " +
      "system stats (df, free, top -bn1, uptime, uname, date, hostname, whoami), " +
      "process/network (ps, ss), log reads (cat/head/tail of /var/log/* and select " +
      "/proc files), read-only systemctl (status/is-active/is-enabled/list-units) " +
      "and journalctl (-u <managed unit>), and read-only network/mail diagnostics " +
      "(dig, host, nslookup, postconf -n, postqueue/mailq, getent). No shell features " +
      "(pipes, redirects, &&, $(), etc.) and no mutating commands are permitted. Use " +
      "the dedicated tools for ports, logs, pm2 and services where they fit.",
    schema: { command: z.string().describe("Full command line, e.g. 'df -h' or 'systemctl status nginx'") },
  },
  {
    name: "pm2_action",
    description:
      "Inspect or control PM2 processes. list returns a structured summary; " +
      "logs returns the last ~60 lines for a named process. restart/stop/start " +
      "are MUTATING and require explicit user confirmation in chat before use. " +
      "A missing name on restart targets all processes.",
    schema: {
      action: z.enum(["list", "restart", "stop", "start", "logs"]),
      name: z.string().optional().describe("PM2 process name (or 'all'). Omit for list."),
    },
  },
  {
    name: "service_action",
    description:
      "Manage a systemd service. status is read-only/safe. start/stop/restart/" +
      "enable are MUTATING/privileged and require explicit user confirmation in " +
      "chat first. Only managed units are allowed (nginx, caddy, mysql/mariadb, " +
      "redis-server, docker, fail2ban).",
    schema: {
      service: z.string().describe("Unit name, e.g. 'nginx' (.service suffix optional)"),
      action: z.enum(["status", "start", "stop", "restart", "enable"]),
    },
  },
  {
    name: "check_port",
    description: "Check whether a TCP port is being listened on, and by which process.",
    schema: { port: z.number().int().min(1).max(65535) },
  },
  {
    name: "read_log",
    description:
      "Tail the last N lines (default 100, max 1000) of a log file. Only paths " +
      "under /var/log/, /root/.pm2/logs/, or a user's ~/.pm2/logs/ are allowed.",
    schema: {
      path: z.string().describe("Absolute path to the log file"),
      lines: z.number().int().min(1).max(1000).optional(),
    },
  },
];

// pm2_action / service_action are conditionally mutating depending on action.
export function isMutatingCall(name: string, input: any): boolean {
  const bare = name.replace(/^mcp__[^_]+__/, "");
  if (bare === "pm2_action") return ["restart", "stop", "start"].includes(input?.action);
  if (bare === "service_action") return ["start", "stop", "restart", "enable"].includes(input?.action);
  // A custom "command" tool the operator flagged as mutating gates on the arm
  // switch too, identically to the built-in mutations above.
  if (isCustomTool(bare)) return customToolMutating(bare);
  return false;
}

export interface DispatchResult {
  content: string; // stringified result handed back to Claude
  isError: boolean;
}

// Execute a tool call and return a string result for the model.
// `allowMutations` is supplied by the caller (the MCP server reads it from its
// per-request env; the in-process OpenAI backend passes the armed state).
export async function dispatchTool(
  name: string,
  input: any,
  opts: { allowMutations?: boolean } = {},
): Promise<DispatchResult> {
  // Server-enforced confirmation gate. Mutating actions are refused unless the
  // operator has armed them via the UI. This check lives BELOW the model, so
  // prompt injection in tool output cannot bypass it — even if the model is
  // tricked into calling a restart, the tool itself refuses while disarmed.
  if (isMutatingCall(name, input) && !opts.allowMutations) {
    return err(
      `DISARMED: mutating actions are currently disabled. The operator must turn on the ` +
        `"Arm mutations" switch in the ServerMind UI before this can run. Tell the user to ` +
        `arm mutations, then retry once they confirm.`,
    );
  }

  try {
    switch (name) {
      case "run_shell": {
        const r = await runShell(String(input?.command ?? ""));
        if (r.rejected) return err(`REJECTED: ${r.rejected}`);
        return wrap(r.ok, formatExec(r));
      }
      case "pm2_action": {
        const r = await pm2Action(input?.action as Pm2Action, input?.name);
        return wrap(r.ok, JSON.stringify(r, null, 2));
      }
      case "service_action": {
        const r = await serviceAction(String(input?.service), input?.action as ServiceAction);
        return wrap(r.ok, JSON.stringify(r, null, 2));
      }
      case "check_port": {
        const r = await checkPort(Number(input?.port));
        return wrap(r.ok, JSON.stringify(r, null, 2));
      }
      case "read_log": {
        const r = await readLog(String(input?.path), input?.lines);
        return wrap(r.ok, r.error ? `ERROR: ${r.error}` : r.content);
      }
      default: {
        // User-defined custom tools (db_query / http_check / read_file /
        // command). The arm gate above already ran via isMutatingCall, so a
        // mutating custom tool is refused here when disarmed.
        if (isCustomTool(name)) return await dispatchCustomTool(name, input);
        return err(`unknown tool: ${name}`);
      }
    }
  } catch (e) {
    return err(`tool execution threw: ${(e as Error).message}`);
  }
}

function formatExec(r: { ok: boolean; code: number | null; stdout: string; stderr: string; timedOut: boolean }): string {
  const parts: string[] = [];
  if (r.timedOut) parts.push("[timed out]");
  parts.push(`exit=${r.code}`);
  if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
  if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
  return parts.join("\n");
}

function wrap(ok: boolean, content: string): DispatchResult {
  return { content: content || "(no output)", isError: !ok };
}
function err(content: string): DispatchResult {
  return { content, isError: true };
}
