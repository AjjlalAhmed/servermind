// OpenAI-compatible AI backend.
//
// Drives the agentic tool-use loop against ANY OpenAI-compatible chat-completions
// API — Google Gemini (free tier), Groq, OpenRouter, Together, DeepSeek, a local
// Ollama, etc. Selected when AI_BACKEND=openai. Emits the same StreamEvent shape
// as the Claude Code backend, so the UI and routes don't care which is active.

import { getAI } from "../settings.ts";
import { isMutatingCall } from "../tools/index.ts";
import { customToolSpecs } from "../tools/custom.ts";
import { localAgent } from "../agent.ts";
import { FLEET_TOOLS, FLEET_SYSTEM_PROMPT, isFleetTool, dispatchFleetTool } from "../fleet/tools.ts";
import { SYSTEM_PROMPT, type ChatMessage, type StreamEvent, type ChatOptions } from "../claude.ts";

const MAX_TURNS = 10;

// Tool definitions in OpenAI function-calling format (JSON Schema params).
const TOOLS = [
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "Run a single read-only diagnostic shell command from a strict allowlist (df, free, top -bn1, ss, ps, cat/head/tail of /var/log/* and /proc/*, uptime, uname, date, hostname, whoami, read-only systemctl/journalctl). No pipes/redirects/&&; no mutating commands.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Full command line, e.g. 'df -h'" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pm2_action",
      description:
        "Inspect or control PM2 processes. list/logs are free; restart/stop/start are MUTATING and require the user to arm mutations first. Omit name for list; name optional on restart (targets all).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "restart", "stop", "start", "logs"] },
          name: { type: "string", description: "PM2 process name (or 'all')" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "service_action",
      description:
        "Manage a systemd service. status is read-only; start/stop/restart/enable are MUTATING/privileged and require the user to arm mutations. Only managed units (nginx, caddy, mysql/mariadb, redis-server, docker, fail2ban).",
      parameters: {
        type: "object",
        properties: {
          service: { type: "string", description: "Unit name, e.g. 'nginx'" },
          action: { type: "string", enum: ["status", "start", "stop", "restart", "enable"] },
        },
        required: ["service", "action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_port",
      description: "Check whether a TCP port is being listened on, and by which process.",
      parameters: {
        type: "object",
        properties: { port: { type: "integer", minimum: 1, maximum: 65535 } },
        required: ["port"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_log",
      description:
        "Tail the last N lines (default 100, max 1000) of a log file under /var/log/, /root/.pm2/logs/, or ~/.pm2/logs/.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, lines: { type: "integer", minimum: 1, maximum: 1000 } },
        required: ["path"],
      },
    },
  },
];

function preview(s: string, n = 600): string {
  const t = (s ?? "").trim();
  return t.length > n ? t.slice(0, n) + " …" : t;
}

interface ToolCallAcc {
  id: string;
  name: string;
  args: string;
}

export async function runChat(
  message: string,
  history: ChatMessage[],
  emit: (e: StreamEvent) => void,
  opts: ChatOptions = {},
): Promise<void> {
  const ai = getAI();
  if (!ai.baseUrl || !ai.model) {
    emit({ type: "error", message: "AI backend not configured — set the base URL and model in Settings or .env" });
    return;
  }

  // User-defined custom tools run on THIS box, so only offer them when the chat
  // targets the local controller — not when managing a remote agent (v1 is
  // single-box; the remote wouldn't have them). They take no model input
  // (frozen), so empty params.
  const local = !opts.agent || opts.agent === localAgent;
  const customTools = local
    ? customToolSpecs().map((s) => ({
        type: "function",
        function: { name: s.name, description: s.description, parameters: { type: "object", properties: {}, required: [] } },
      }))
    : [];
  const tools = [...TOOLS, ...customTools, ...(opts.fleet ? FLEET_TOOLS : [])];
  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT + (opts.fleet ? FLEET_SYSTEM_PROMPT : "") },
    ...history
      .filter((h) => (h.role === "user" || h.role === "assistant") && typeof h.content === "string" && h.content.trim())
      .map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: message },
  ];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (opts.signal?.aborted) return;

      const res = await fetch(`${ai.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(ai.apiKey ? { authorization: `Bearer ${ai.apiKey}` } : {}),
        },
        signal: opts.signal,
        body: JSON.stringify({
          model: ai.model,
          messages,
          tools,
          tool_choice: "auto",
          stream: true,
          max_tokens: 4096,
        }),
      });

      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        emit({ type: "error", message: `AI API error (${res.status}): ${preview(body, 300) || "no body"}` });
        return;
      }

      let assistantText = "";
      const toolCalls: Record<number, ToolCallAcc> = {};

      // ── parse the SSE stream ──
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      streaming: while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") break streaming;
          let json: any;
          try { json = JSON.parse(data); } catch { continue; }
          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) {
            assistantText += delta.content;
            emit({ type: "text", delta: delta.content });
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const acc = (toolCalls[idx] ??= { id: "", name: "", args: "" });
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
            }
          }
        }
      }

      const calls = Object.values(toolCalls).filter((c) => c.name);
      if (calls.length === 0) {
        emit({ type: "done" });
        return;
      }

      // record the assistant turn (with its tool calls) for the next request
      messages.push({
        role: "assistant",
        content: assistantText || null,
        tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })),
      });

      // execute each tool, stream events, append results
      for (const c of calls) {
        if (opts.signal?.aborted) return;
        let input: any = {};
        try { input = JSON.parse(c.args || "{}"); } catch { input = {}; }
        emit({ type: "tool_use", id: c.id, name: c.name, input, mutating: isMutatingCall(c.name, input) });

        // Fleet tools (list/run across servers) vs a per-box tool on the target.
        // Re-read the target's arm state at THIS call (not a boolean captured at
        // chat start) so the 10-min TTL and an explicit mid-chat disarm take
        // effect on an already-running chat. The agent re-checks again itself.
        const target = opts.agent ?? localAgent;
        const result = isFleetTool(c.name)
          ? await dispatchFleetTool(c.name, input)
          : await target.invoke(c.name, input, target.isArmed());
        emit({ type: "tool_result", id: c.id, isError: result.isError, preview: preview(result.content) });

        messages.push({ role: "tool", tool_call_id: c.id, content: result.content });
      }
      // loop: model gets the tool results and continues
    }

    emit({ type: "error", message: `stopped after ${MAX_TURNS} tool turns without a final answer` });
  } catch (e) {
    if ((e as Error).name === "AbortError" || opts.signal?.aborted) return;
    emit({ type: "error", message: `AI backend error: ${(e as Error).message}` });
  }
}
