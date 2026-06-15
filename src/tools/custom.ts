// User-defined custom tools ("Kind A + A+").
//
// These let an operator extend ServerMind WITHOUT weakening the cage. A custom
// tool is a *declarative manifest* (data), never user-written code:
//   • db_query   — a frozen, read-only SQL query against a chosen DB
//   • http_check — a GET against a frozen URL, with optional assertions
//   • read_file  — a frozen file path, read via the existing safe-path gate
//   • command    — ONE exact, frozen argv (e.g. ["redis-cli","INFO","memory"])
//
// The core principle: the operator defines and FREEZES the tool; the AI can only
// trigger it — it supplies no commands, paths, URLs, or SQL. So custom tools take
// no model input (empty schema). Each kind is validated at registration AND
// re-validated here at execution, reusing the same primitives the built-in tools
// use (exec, readLog, the read-only SQL gates). A `command` may be marked
// mutating; that routes through the existing arm switch (see isMutatingCall in
// ./index.ts), exactly like pm2/service mutations.
//
// Persistence + secret encryption live in settings.ts. To avoid an import cycle
// (settings → custom → settings), settings PUSHES the validated list in via
// setCustomTools(); this module never imports settings.

import { z } from "zod";
import type { ToolSpec, DispatchResult } from "./index.ts";
import { exec } from "./exec.ts";
import { readLog } from "./log.ts";
import { validateReadonlySql, mysqlQueryOn } from "./mysql.ts";
import { validateReadonlyPg, postgresQueryOn } from "./postgres.ts";

// Names already taken by built-in tools — a custom tool may not shadow them.
const RESERVED = new Set([
  "run_shell", "pm2_action", "service_action", "check_port", "read_log",
  "fleet_list", "fleet_run",
]);

const MAX_TOOLS = 50;

const name = z.string().regex(/^[a-z0-9_]{3,40}$/, "name must be 3–40 chars of a–z, 0–9, _");
const description = z.string().min(1).max(200);

const conn = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  user: z.string().max(128).default(""),
  password: z.string().max(512).default(""),
  database: z.string().max(128).optional(),
});

const dbQuery = z.object({
  kind: z.literal("db_query"),
  name, description,
  engine: z.enum(["mysql", "postgres"]),
  conn,
  query: z.string().min(1).max(2000),
  mutating: z.literal(false).default(false),
});

const httpCheck = z.object({
  kind: z.literal("http_check"),
  name, description,
  url: z.string().url().max(2000),
  expectStatus: z.number().int().min(100).max(599).optional(),
  jsonPath: z.string().max(200).optional(), // dot path, e.g. "data.status"
  expected: z.string().max(500).optional(),
  mutating: z.literal(false).default(false),
});

const readFile = z.object({
  kind: z.literal("read_file"),
  name, description,
  path: z.string().min(1).max(1024),
  lines: z.number().int().min(1).max(1000).optional(),
  mutating: z.literal(false).default(false),
});

const command = z.object({
  kind: z.literal("command"),
  name, description,
  argv: z.array(z.string().min(1).max(256)).min(1).max(20),
  mutating: z.boolean().default(false),
  timeoutMs: z.number().int().min(1000).max(60_000).optional(),
});

export const CustomToolSchema = z.discriminatedUnion("kind", [dbQuery, httpCheck, readFile, command]);
export const CustomToolsSchema = z.array(CustomToolSchema).max(MAX_TOOLS);
export type CustomTool = z.infer<typeof CustomToolSchema>;

// ── live registry: settings.ts populates this on load and after every update ──
let TOOLS: CustomTool[] = [];
export function setCustomTools(list: CustomTool[]): void { TOOLS = list; }
export function listCustomTools(): CustomTool[] { return TOOLS; }
const find = (n: string) => TOOLS.find((t) => t.name === n);

// ── validation (registration-time; clear single-string error) ─────────────────
export function validateCustomTools(
  list: unknown,
): { ok: true; tools: CustomTool[] } | { ok: false; error: string } {
  const parsed = CustomToolsSchema.safeParse(list);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const seen = new Set<string>();
  for (const t of parsed.data) {
    if (RESERVED.has(t.name)) return { ok: false, error: `'${t.name}' is a reserved built-in tool name` };
    if (seen.has(t.name)) return { ok: false, error: `duplicate tool name: ${t.name}` };
    seen.add(t.name);
    const bad = validateOne(t);
    if (bad) return { ok: false, error: `${t.name}: ${bad}` };
  }
  return { ok: true, tools: parsed.data };
}

// Per-kind safety check, beyond the schema shape. Reused at execution time.
function validateOne(t: CustomTool): string | null {
  switch (t.kind) {
    case "db_query":
      if (t.engine === "postgres" && !t.conn.database) return "postgres requires conn.database";
      return t.engine === "mysql" ? validateReadonlySql(t.query) : validateReadonlyPg(t.query);
    case "http_check":
      try {
        if (!/^https?:$/.test(new URL(t.url).protocol)) return "only http/https URLs are allowed";
      } catch { return "invalid URL"; }
      return null;
    case "read_file":
    case "command":
      return null;
  }
}

// ── exposure to the AI backends ───────────────────────────────────────────────
// Frozen tools take no model input, so the schema is empty. The description is
// what the model sees; we tag read-only vs mutating so it knows the arm rule.
export function customToolSpecs(): ToolSpec[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: `${t.description} (custom ${t.kind}${t.kind === "command" && t.mutating ? ", MUTATING — requires arm" : ", read-only"})`,
    schema: {},
  }));
}

export function isCustomTool(n: string): boolean { return find(n) !== undefined; }
export function customToolMutating(n: string): boolean { return !!find(n)?.mutating; }

// ── execution ─────────────────────────────────────────────────────────────────
// Arm gating for mutating tools is enforced upstream in dispatchTool() (via
// isMutatingCall), so we don't re-check it here.
export async function dispatchCustomTool(n: string): Promise<DispatchResult> {
  const t = find(n);
  if (!t) return { content: `unknown tool: ${n}`, isError: true };
  return runCustomTool(t);
}

// Run a specific manifest (used by dispatch AND by the dashboard "Test" button,
// which runs an unsaved manifest). Re-validates first as defence-in-depth.
export async function runCustomTool(t: CustomTool): Promise<DispatchResult> {
  const bad = validateOne(t);
  if (bad) return { content: `REJECTED: ${bad}`, isError: true };
  switch (t.kind) {
    case "db_query": return runDbQuery(t);
    case "http_check": return runHttpCheck(t);
    case "read_file": return runReadFile(t);
    case "command": return runCommand(t);
  }
}

async function runDbQuery(t: Extract<CustomTool, { kind: "db_query" }>): Promise<DispatchResult> {
  const r = t.engine === "mysql"
    ? await mysqlQueryOn(t.conn, t.query)
    : await postgresQueryOn({ ...t.conn, database: t.conn.database ?? "" }, t.query);
  if (r.ok) return { content: r.output || "(no rows)", isError: false };
  return { content: `${r.error ?? "query failed"}${r.output ? `: ${r.output}` : ""}`, isError: true };
}

async function runHttpCheck(t: Extract<CustomTool, { kind: "http_check" }>): Promise<DispatchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(t.url, { method: "GET", redirect: "follow", signal: ctrl.signal });
    const raw = (await res.text()).slice(0, 8_000);
    const lines: string[] = [`HTTP ${res.status} ${res.statusText}`.trim()];
    let failed = false;
    if (t.expectStatus !== undefined) {
      const ok = res.status === t.expectStatus;
      failed ||= !ok;
      lines.push(`status ${ok ? "✓" : "✗"} expected ${t.expectStatus}, got ${res.status}`);
    }
    if (t.jsonPath) {
      let got: unknown;
      try { got = t.jsonPath.split(".").reduce<any>((o, k) => (o == null ? o : o[k]), JSON.parse(raw)); }
      catch { got = undefined; }
      const gotStr = got === undefined ? "(missing)" : String(got);
      if (t.expected !== undefined) {
        const ok = gotStr === t.expected;
        failed ||= !ok;
        lines.push(`${t.jsonPath} ${ok ? "✓" : "✗"} expected "${t.expected}", got "${gotStr}"`);
      } else {
        lines.push(`${t.jsonPath} = ${gotStr}`);
      }
    }
    if (!t.expectStatus && !t.jsonPath) lines.push(raw.slice(0, 600).trim() || "(empty body)");
    return { content: lines.join("\n"), isError: failed };
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? "request timed out (10s)" : (e as Error).message;
    return { content: `request failed: ${msg}`, isError: true };
  } finally {
    clearTimeout(timer);
  }
}

async function runReadFile(t: Extract<CustomTool, { kind: "read_file" }>): Promise<DispatchResult> {
  const r = await readLog(t.path, t.lines ?? 100);
  return { content: r.ok ? r.content || "(empty)" : `ERROR: ${r.error}`, isError: !r.ok };
}

async function runCommand(t: Extract<CustomTool, { kind: "command" }>): Promise<DispatchResult> {
  const r = await exec(t.argv, { timeoutMs: t.timeoutMs ?? 15_000 });
  const parts: string[] = [];
  if (r.timedOut) parts.push("[timed out]");
  parts.push(`exit=${r.code}`);
  if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
  if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
  return { content: parts.join("\n") || "(no output)", isError: !r.ok };
}
