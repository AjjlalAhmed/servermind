// OpenAI-compatible AI backend.
//
// Drives the agentic tool-use loop against ANY OpenAI-compatible chat-completions
// API — Google Gemini (free tier), Groq, OpenRouter, Together, DeepSeek, a local
// Ollama, etc. Selected when AI_BACKEND=openai. Emits the same StreamEvent shape
// as the Claude Code backend, so the UI and routes don't care which is active.

import { getAI } from "../settings.ts";
import { isMutatingCall, TOOL_SPECS, type ToolSpec } from "../tools/index.ts";
import { zodShapeToJsonSchema } from "../tools/jsonschema.ts";
import { customToolOpenAI } from "../tools/custom.ts";
import { localAgent } from "../agent.ts";
import { RemoteAgent } from "../fleet/remote.ts";
import { FLEET_TOOLS, FLEET_SYSTEM_PROMPT, isFleetTool, dispatchFleetTool, agentCustomToolDefs } from "../fleet/tools.ts";
import { SYSTEM_PROMPT, type ChatMessage, type StreamEvent, type ChatOptions } from "../claude.ts";

const MAX_TURNS = 10;

// OpenAI function-calling defs are DERIVED from the single TOOL_SPECS source
// (Zod) the MCP/Claude backend also uses — so name, description, and params can
// never drift between the two backends. Custom tools keep their own JSON-Schema
// builder (customToolOpenAI) since they're defined as plain data, not Zod.
function specToOpenAI(s: ToolSpec) {
  return { type: "function", function: { name: s.name, description: s.description, parameters: zodShapeToJsonSchema(s.schema) } };
}
const TOOLS = TOOL_SPECS.map(specToOpenAI);

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

  // Custom tools: when chatting the local controller, offer the controller's own
  // tools; when managing a remote agent, offer THAT agent's advertised tools
  // (which run on the agent — RemoteAgent.invoke routes the call there). Each is
  // frozen except db_console, which takes a model-supplied `query`.
  const local = !opts.agent || opts.agent === localAgent;
  const customTools = local
    ? customToolOpenAI()
    : opts.agent instanceof RemoteAgent ? agentCustomToolDefs(opts.agent.id) : [];
  const tools = [...TOOLS, ...customTools, ...(opts.fleet ? FLEET_TOOLS : [])];
  const agentToolNote = !local && customTools.length
    ? `\n\nThis server exposes custom tools: ${customTools.map((t) => t.function.name).join(", ")}. They run ON this server — use them to answer questions about its data, and pass a read-only SELECT in \`query\` for any db console tool.`
    : "";
  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT + (opts.fleet ? FLEET_SYSTEM_PROMPT : "") + agentToolNote },
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
