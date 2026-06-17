// Fleet-aware AI tools — added to the controller's chat when fleet mode is on,
// so the assistant can answer questions about the whole fleet and act across it.
// (Per-server safety holds: fleet_run goes through each agent's allowlist + arm.)

import type { DispatchResult } from "../tools/index.ts";
import { fleetRegistry, sendInvoke } from "./hub.ts";

const PER_BOX_TOOLS = ["run_shell", "pm2_action", "service_action", "check_port", "read_log"] as const;

// OpenAI function-calling definitions for the fleet tools.
export const FLEET_TOOLS = [
  {
    type: "function",
    function: {
      name: "fleet_list",
      description:
        "List every server in the fleet with health: online state, CPU load, memory %, disk %, and redis/mysql/pm2 status. Use this to answer how many servers there are, which are unhealthy, low on disk, or offline, or to give a fleet overview.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "fleet_run",
      description:
        "Run one per-server tool on a specific server (by hostname) or on 'all' servers. `tool` is one of run_shell, pm2_action, service_action, check_port, read_log; `input` is that tool's arguments. Read-only tools run freely; mutating actions require the target server to be armed (the agent enforces this).",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "target server hostname, or 'all'" },
          tool: { type: "string", enum: [...PER_BOX_TOOLS] },
          input: { type: "object", description: "arguments for the chosen tool" },
        },
        required: ["server", "tool", "input"],
      },
    },
  },
];

// Appended to the system prompt when chatting on the controller with a fleet.
export const FLEET_SYSTEM_PROMPT =
  "\n\nFLEET MODE: you are on the controller managing multiple servers. Use fleet_list " +
  "to see all servers and their health — answer \"how many servers\", \"which are " +
  "unhealthy/low on disk\", and overview questions with it. Use fleet_run to run a tool " +
  "on a specific server by hostname (or \"all\"). The plain per-server tools act on the " +
  "controller's own box, so prefer fleet_run when the user asks about a managed server.";

// OpenAI function defs for the custom tools a specific agent advertised. Used
// when the operator "manages" that server: the AI gets its tools, and a call
// routes to the agent (RemoteAgent.invoke → sendInvoke), which runs it locally.
export function agentCustomToolDefs(agentId: string) {
  const reg = fleetRegistry();
  return (reg ? reg.getTools(agentId) : []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.takesQuery
        ? { type: "object", properties: { query: { type: "string", description: "A single read-only SQL statement (SELECT / SHOW / EXPLAIN), no semicolons" } }, required: ["query"] }
        : { type: "object", properties: {}, required: [] },
    },
  }));
}

export function isFleetTool(name: string): boolean {
  const bare = name.replace(/^mcp__[^_]+__/, "");
  return bare === "fleet_list" || bare === "fleet_run";
}

export async function dispatchFleetTool(name: string, input: any): Promise<DispatchResult> {
  const reg = fleetRegistry();
  if (!reg) return { content: "fleet is not enabled on this controller", isError: true };
  const bare = name.replace(/^mcp__[^_]+__/, "");

  if (bare === "fleet_list") {
    const servers = reg.list().map((s) => {
      const m = s.status?.metrics;
      return {
        server: s.hostname,
        online: s.online,
        cpuLoad: m?.cpu.load1 ?? null,
        memPct: m?.memory.usedPct ?? null,
        diskPct: m?.disk.usedPct ?? null,
        redis: s.status?.redis && typeof (s.status.redis as { connected?: boolean }).connected === "boolean" ? (s.status.redis as { connected: boolean }).connected : null,
        mysql: s.status?.mysql ? s.status.mysql.ok : null,
        pm2: Array.isArray(s.status?.pm2?.processes) ? (s.status!.pm2.processes as unknown[]).length : null,
      };
    });
    return { content: JSON.stringify({ count: servers.length, servers }, null, 2), isError: false };
  }

  if (bare === "fleet_run") {
    const tool = String(input?.tool ?? "");
    const toolInput = input?.input ?? {};
    const target = String(input?.server ?? "");
    if (!PER_BOX_TOOLS.includes(tool as (typeof PER_BOX_TOOLS)[number])) {
      return { content: `fleet_run: tool must be one of ${PER_BOX_TOOLS.join(", ")}`, isError: true };
    }
    const all = reg.list();
    const targets = target === "all" ? all.filter((s) => s.online) : all.filter((s) => s.hostname === target || s.id === target);
    if (!targets.length) {
      return { content: `fleet_run: no ${target === "all" ? "online " : ""}server matches "${target}". Use fleet_list to see servers.`, isError: true };
    }
    const results = await Promise.all(
      targets.map(async (s) => {
        const r = await sendInvoke(s.id, tool, toolInput);
        return `### ${s.hostname}\n${r.content}`;
      }),
    );
    return { content: results.join("\n\n"), isError: false };
  }

  return { content: `unknown fleet tool: ${name}`, isError: true };
}
