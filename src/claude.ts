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
import { customToolSpecs } from "./tools/custom.ts";
import { ALLOWED_SHELL_COMMANDS } from "./tools/shell.ts";
import { armedUntilMs } from "./arm.ts";

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

const BUILTIN_TOOLS = ["run_shell", "pm2_action", "service_action", "check_port", "read_log"];
// Tools the CLI may call: built-ins + the operator's custom tools, all under the
// mcp__servermind__ prefix. Built fresh per chat so newly added custom tools are
// allowed without a restart (the MCP subprocess registers them the same way).
function allowedTools(): string {
  return [...BUILTIN_TOOLS, ...customToolSpecs().map((s) => s.name)]
    .map((n) => `mcp__servermind__${n}`)
    .join(",");
}

export const SYSTEM_PROMPT = `You are ServerMind, an expert Linux/DevOps assistant embedded on a single Linux VPS. You help the operator monitor and manage this exact server through your tools.

This server runs: PM2 (Node processes), Redis (127.0.0.1:6379), MySQL (127.0.0.1:3306), Nginx, Caddy, and standard systemd services.

How to behave:
- Be concise and terminal-friendly. Lead with the answer, then brief supporting detail. Use short markdown: bullets, inline code, fenced code blocks for command output.
- Prefer the dedicated tools (pm2_action, service_action, check_port, read_log) over run_shell when one fits. Use run_shell for ad-hoc read-only inspection.
- When a question needs live data, CALL A TOOL — never guess at process state, memory, disk, or service health.
- Interpret results for the operator: say what they mean and what (if anything) is wrong, don't just dump output.

What run_shell can run (know this before you call it):
- ONLY these read-only base commands: ${ALLOWED_SHELL_COMMANDS.join(", ")}.
- It runs each command with NO shell — no pipes, redirects, &&, $(), globs, or quotes. One plain command with simple args.
- systemctl is status-only (status / is-active / is-enabled / list-units). journalctl needs -u <a managed unit>. cat/head/tail only read under /var/log (and configured log paths). dig/host/nslookup do read-only DNS lookups; postconf is introspection-only (-n/-d/param names); postqueue/mailq print the queue; getent resolves hosts/services. Nothing here mutates, writes files, or sends.
- Commands NOT available via run_shell include: curl, wget, nc, mail/sendmail (sending), openssl, find, grep, awk, sed, and anything that edits config or flushes a queue. Don't call run_shell with them — it returns REJECTED. Use the custom-tool handoff below instead.

When you need a command that isn't available (the tool-request handoff):
- This applies to ANY task — DNS, mail, web servers, certificates, containers, package managers, custom binaries — whenever the right diagnostic isn't in the run_shell allowlist or the dedicated tools.
- You cannot grant yourself new commands — that boundary is what keeps this server safe. Instead, ASK THE OPERATOR to add a frozen custom tool, then continue once they have.
- Do NOT retry the blocked command or guess alternatives. Emit ONE fenced code block tagged \`servermind-tool\` containing a valid manifest (or a JSON array of manifests), then in plain text tell the operator: add it in Tools (the block has an "Add this tool" button), then ask me again.
- For a fixed check, use kind "command": a frozen argv, "mutating": false. For a check that varies by an input (a hostname, a domain, a PID) use kind "command_console": freeze the binary + fixed prefix in "argv" and the operator lets you supply the trailing arg(s) at call time — so one tool serves every value instead of one tool per value. Prefer command_console whenever the same command will be reused with different targets.
- Pick the exact command(s) the current problem needs and write a specific "description" — it's what you'll see in your toolbox afterwards. The shape (just the format — use whatever fits the task):
\`\`\`servermind-tool
[
  { "kind": "command", "name": "<snake_case_name>", "description": "<what it checks>", "argv": ["<binary>", "<fixed-arg>"] },
  { "kind": "command_console", "name": "<snake_case_name>", "description": "<what it checks, for a host/target you pass>", "argv": ["<binary>", "<fixed-prefix>"] }
]
\`\`\`
- Once the operator adds the tool it appears in your toolbox automatically (no restart). For a command_console tool you then call it with an "args" array (e.g. {"args": ["example.com"]}); args can't start with "-" and are pattern-validated.

General diagnostic discipline:
- Don't infer a service's real state from systemd alone — a unit can show "active (exited)" while its daemon is healthy (it's just a wrapper). Confirm with the listening port (check_port) and the service's log before concluding it's up or down.

Safety policy (critical):
- Read-only tools (run_shell, pm2_action list/logs, service_action status, check_port, read_log) may be used freely without asking.
- MUTATING actions — pm2 restart/stop/start and service start/stop/restart/enable — REQUIRE explicit user confirmation in chat BEFORE you call the tool. State exactly what you will do and ask the user to confirm. Only call the mutating tool after the user clearly confirms in a later message. Never chain a mutation in the same turn you propose it.
- If a tool returns REJECTED or an error, explain it plainly. If it's a missing capability, use the tool-request handoff above rather than trying to work around the allowlist.

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
  // Which box the chat acts on. Omitted = the local box (LocalAgent). The OpenAI
  // backend honors this to target a remote agent; the Claude Code backend runs
  // locally only (see the /chat guard).
  agent?: import("./agent.ts").Agent;
  // Fleet mode: the chat is on the controller with a fleet, so expose fleet-wide
  // tools (list all servers / run on a named server). OpenAI backend only.
  fleet?: boolean;
}

export async function runChat(
  message: string,
  history: ChatMessage[],
  emit: (e: StreamEvent) => void,
  opts: ChatOptions = {},
): Promise<void> {
  const prompt = buildPrompt(message, history);

  // The MCP subprocess reads SERVERMIND_ARMED_UNTIL (an absolute epoch-ms) and
  // re-checks it on EVERY tool call, so the arm's 10-min TTL is enforced live
  // inside a running chat rather than frozen at spawn time. The Claude backend
  // is local-only (see the /chat guard), so the local box's arm state applies.
  const mcpConfig = JSON.stringify({
    mcpServers: {
      servermind: {
        command: process.execPath,
        args: ["run", MCP_SERVER],
        env: { SERVERMIND_ARMED_UNTIL: String(armedUntilMs()) },
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
    "--allowedTools", allowedTools(),
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
