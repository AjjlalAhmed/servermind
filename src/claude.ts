// Claude integration — drives the locally-installed `claude` CLI in headless
// mode (subscription auth, NOT the paid API) and streams its output back as
// structured events.
//
// We run: claude -p <prompt> --output-format stream-json --include-partial-messages
//   --append-system-prompt <persona> --mcp-config <servermind tools>
//   --allowedTools mcp__servermind__* --disallowedTools <built-ins>
//   --dangerously-skip-permissions --model <model>
//
// Claude does its own internal agentic tool-use loop; we just parse the JSONL
// event stream and forward text deltas, tool calls and tool results.

import { config } from "./config.ts";
import { getAI } from "./settings.ts";
import { isMutatingCall } from "./tools/index.ts";

const ROOT = new URL("..", import.meta.url).pathname; // project root
const MCP_SERVER = new URL("./mcp-server.ts", import.meta.url).pathname;

// Built-in Claude Code tools we forbid — ServerMind must only act through its
// own vetted MCP tools, never raw Bash / file writes / network. Because we run
// with --dangerously-skip-permissions, this deny-list must stay exhaustive: if
// a future CLI version adds a built-in NOT listed here, it could be auto-run.
// Mitigation: PIN the Claude Code version on the host (don't auto-upgrade), and
// re-check this list when you bump it.
const DISALLOWED_BUILTINS = [
  "Bash", "BashOutput", "KillBash", "KillShell",
  "Edit", "MultiEdit", "Write", "Read", "NotebookEdit", "NotebookRead",
  "Glob", "Grep", "LS",
  "WebFetch", "WebSearch",
  "Task", "Agent", "Skill", "SlashCommand", "ExitPlanMode", "TodoWrite",
  "ListMcpResources", "ReadMcpResource",
].join(",");

const ALLOWED_TOOLS = "mcp__servermind__run_shell,mcp__servermind__pm2_action,mcp__servermind__service_action,mcp__servermind__check_port,mcp__servermind__read_log";

export const SYSTEM_PROMPT = `You are ServerMind, an expert Linux/DevOps assistant embedded on a single Linux VPS. You help the operator monitor and manage this exact server through your tools.

This server runs: PM2 (Node processes), Redis (127.0.0.1:6379), MySQL (127.0.0.1:3306), Nginx, Caddy, and standard systemd services.

How to behave:
- Be concise and terminal-friendly. Lead with the answer, then brief supporting detail. Use short markdown: bullets, inline code, fenced code blocks for command output.
- Prefer the dedicated tools (pm2_action, service_action, check_port, read_log) over run_shell when one fits. Use run_shell for ad-hoc read-only inspection.
- When a question needs live data, CALL A TOOL — never guess at process state, memory, disk, or service health.
- Interpret results for the operator: say what they mean and what (if anything) is wrong, don't just dump output.

Safety policy (critical):
- Read-only tools (run_shell, pm2_action list/logs, service_action status, check_port, read_log) may be used freely without asking.
- MUTATING actions — pm2 restart/stop/start and service start/stop/restart/enable — REQUIRE explicit user confirmation in chat BEFORE you call the tool. State exactly what you will do and ask the user to confirm. Only call the mutating tool after the user clearly confirms in a later message. Never chain a mutation in the same turn you propose it.
- If a tool returns REJECTED or an error, explain it plainly and suggest a safe alternative. Never try to work around the allowlist.

Today is ${new Date().toISOString().slice(0, 10)}.`;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_use"; id: string; name: string; input: unknown; mutating: boolean }
  | { type: "tool_result"; id: string; isError: boolean; preview: string }
  | { type: "done" }
  | { type: "error"; message: string };

const OVERALL_TIMEOUT_MS = 10 * 60 * 1000; // hard ceiling for a single chat turn

// Flatten prior turns into the prompt so the CLI (one-shot per request) has
// conversation context, without relying on on-disk session resume.
function buildPrompt(message: string, history: ChatMessage[]): string {
  const prior = history
    .filter((h) => (h.role === "user" || h.role === "assistant") && typeof h.content === "string" && h.content.trim())
    .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.content.trim()}`);

  if (!prior.length) return message;
  return `Earlier in this conversation:\n${prior.join("\n\n")}\n\n---\nCurrent request from the operator:\n${message}`;
}

function preview(s: string, n = 600): string {
  const t = (s ?? "").trim();
  return t.length > n ? t.slice(0, n) + " …" : t;
}

// Normalise a tool name from the stream into something readable (strip the
// mcp__servermind__ prefix for display).
function displayName(name: string): string {
  return name.replace(/^mcp__servermind__/, "");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b === "string" ? b : b?.type === "text" ? b.text : b?.content ?? ""))
      .join("");
  }
  return "";
}

export interface ChatOptions {
  allowMutations?: boolean;
  // Aborts the run and kills the claude process — fired when the client
  // disconnects (e.g. the user hits Stop in the UI).
  signal?: AbortSignal;
}

export async function runChat(
  message: string,
  history: ChatMessage[],
  emit: (e: StreamEvent) => void,
  opts: ChatOptions = {},
): Promise<void> {
  const prompt = buildPrompt(message, history);

  // The MCP subprocess reads SERVERMIND_ALLOW_MUTATIONS to decide whether to
  // honour mutating tool calls. We set it explicitly in the mcp-config env so
  // it doesn't depend on how the CLI forwards its environment.
  const mcpConfig = JSON.stringify({
    mcpServers: {
      servermind: {
        command: process.execPath,
        args: ["run", MCP_SERVER],
        env: { SERVERMIND_ALLOW_MUTATIONS: opts.allowMutations ? "1" : "0" },
      },
    },
  });

  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", getAI().claudeModel,
    "--append-system-prompt", SYSTEM_PROMPT,
    "--mcp-config", mcpConfig,
    "--allowedTools", ALLOWED_TOOLS,
    "--disallowedTools", DISALLOWED_BUILTINS,
    "--dangerously-skip-permissions",
  ];

  // Build the child env: strip ANTHROPIC_API_KEY so the CLI uses the
  // subscription (never paid API billing). Optionally inject an OAuth token.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (config.claudeOauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = config.claudeOauthToken;

  // Bail before spawning if the client already disconnected.
  if (opts.signal?.aborted) return;

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([config.claudeBin, ...args], {
      cwd: ROOT,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
  } catch (e) {
    emit({ type: "error", message: `failed to launch '${config.claudeBin}': ${(e as Error).message}` });
    return;
  }

  const killTimer = setTimeout(() => proc.kill(9), OVERALL_TIMEOUT_MS);

  // Kill the claude process the moment the client disconnects (Stop button).
  const onAbort = () => { try { proc.kill(9); } catch {} };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  let sawTextThisTurn = false; // whether we've streamed text for the current assistant block
  let emittedAnyText = false;
  let sawResult = false;

  const handle = (obj: any) => {
    const type = obj?.type;

    if (type === "stream_event") {
      const ev = obj.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        const delta = ev.delta.text ?? "";
        if (delta) {
          emit({ type: "text", delta });
          sawTextThisTurn = true;
          emittedAnyText = true;
        }
      }
      return;
    }

    if (type === "assistant") {
      const blocks = obj.message?.content ?? [];
      for (const b of blocks) {
        if (b?.type === "tool_use") {
          const mutating = isMutatingCall(b.name ?? "", b.input);
          emit({ type: "tool_use", id: b.id ?? "", name: displayName(b.name ?? "tool"), input: b.input ?? {}, mutating });
        } else if (b?.type === "text" && !sawTextThisTurn) {
          // Fallback: partial streaming didn't deliver this text — emit it whole.
          if (b.text) {
            emit({ type: "text", delta: b.text });
            emittedAnyText = true;
          }
        }
      }
      sawTextThisTurn = false; // reset for the next assistant turn's deltas
      return;
    }

    if (type === "user") {
      const blocks = obj.message?.content ?? [];
      for (const b of blocks) {
        if (b?.type === "tool_result") {
          emit({
            type: "tool_result",
            id: b.tool_use_id ?? "",
            isError: !!b.is_error,
            preview: preview(textOf(b.content)),
          });
        }
      }
      return;
    }

    if (type === "result") {
      sawResult = true;
      const isError = obj.is_error || (obj.subtype && obj.subtype !== "success");
      if (isError) {
        emit({ type: "error", message: String(obj.result || obj.subtype || "claude reported an error") });
      } else if (!emittedAnyText && typeof obj.result === "string" && obj.result.trim()) {
        // Nothing streamed but there's a final answer — surface it.
        emit({ type: "text", delta: obj.result });
      }
      return;
    }
  };

  // Read stdout line-by-line (NDJSON), tolerant of partial chunks.
  let buf = "";
  const decoder = new TextDecoder();
  try {
    for await (const chunk of proc.stdout as any as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          handle(JSON.parse(line));
        } catch {
          // ignore non-JSON noise
        }
      }
    }
    if (buf.trim()) {
      try { handle(JSON.parse(buf.trim())); } catch { /* ignore */ }
    }

    const code = await proc.exited;
    if (opts.signal?.aborted) return; // client stopped — emit nothing further
    if (code !== 0 && !sawResult) {
      const stderr = await new Response(proc.stderr).text();
      emit({ type: "error", message: `claude exited ${code}: ${preview(stderr, 400) || "no output"}` });
      return;
    }
    emit({ type: "done" });
  } catch (e) {
    if (!opts.signal?.aborted) emit({ type: "error", message: `stream error: ${(e as Error).message}` });
  } finally {
    clearTimeout(killTimer);
    opts.signal?.removeEventListener("abort", onAbort);
    try { proc.kill(); } catch {}
  }
}
