// Shared interactive-CLI helpers for the setup wizard.

import { createInterface, type Interface } from "node:readline";

export const ENV_PATH = new URL("../../.env", import.meta.url).pathname;

// One shared readline for the whole wizard. Creating one per prompt loses
// buffered input on a piped (non-TTY) stdin and is just wasteful.
let rl: Interface | null = null;
function getRL(): Interface {
  if (!rl) rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  return rl;
}
export function closeIO() { rl?.close(); rl = null; }

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", accent: "\x1b[38;5;105m",
};
export const color = C;

const RULE = "─".repeat(52);
export function heading(t: string) {
  console.log(`\n${C.accent}${C.bold}  ${t}${C.reset}`);
  console.log(`  ${C.dim}${RULE}${C.reset}`);
}
// A small top banner for the start of the wizard.
export function banner(title: string, subtitle: string) {
  console.log(`\n  ${C.accent}${C.bold}${title}${C.reset}`);
  console.log(`  ${C.dim}${subtitle}${C.reset}`);
  console.log(`  ${C.dim}${RULE}${C.reset}`);
}
export function note(t: string) { console.log(`    ${C.dim}${t}${C.reset}`); }
export function ok(t: string) { console.log(`    ${C.green}✓${C.reset} ${t}`); }
export function warn(t: string) { console.log(`    ${C.yellow}▲${C.reset} ${t}`); }
// A labelled summary line, e.g.  AI       grok-3  — used in the final recap.
export function field(label: string, value: string) {
  console.log(`    ${C.dim}${label.padEnd(9)}${C.reset}${value}`);
}

// Prompt for a line. `def` is shown and returned if the user just hits enter.
// `hidden` mutes the echo (for passwords / keys).
// Non-TTY (piped) input is read once up front into a deterministic line queue —
// readline races on a fast pipe. This also makes the wizard scriptable.
let pipedLines: string[] | null = null;
let pipedIdx = 0;

export async function ask(label: string, opts: { hidden?: boolean; def?: string } = {}): Promise<string> {
  const isTTY = !!process.stdin.isTTY;
  const suffix = opts.def && !opts.hidden ? ` ${C.dim}(${opts.def})${C.reset}` : "";
  const lock = opts.hidden ? ` ${C.dim}(hidden)${C.reset}` : "";
  const query = `  ${label}${suffix}${lock} ${C.accent}❯${C.reset} `;

  if (!isTTY) {
    if (pipedLines === null) pipedLines = (await Bun.stdin.text()).split("\n");
    const raw = (pipedLines[pipedIdx++] ?? "").replace(/\r$/, "");
    process.stdout.write(query + (opts.hidden ? "•••" : raw) + "\n");
    return raw.trim() || opts.def || "";
  }

  const r = getRL();
  return new Promise((resolve) => {
    if (opts.hidden) {
      process.stdout.write(query); // print prompt, then swallow echo so the secret stays hidden
      const orig = (r as any)._writeToOutput;
      (r as any)._writeToOutput = () => {};
      r.question("", (a) => { (r as any)._writeToOutput = orig; process.stdout.write("\n"); resolve(a.trim() || opts.def || ""); });
    } else {
      r.question(query, (a) => resolve(a.trim() || opts.def || ""));
    }
  });
}

export async function confirm(label: string, def = false): Promise<boolean> {
  const a = (await ask(`${label} ${C.dim}${def ? "[Y/n]" : "[y/N]"}${C.reset}`)).toLowerCase();
  if (!a) return def;
  return a === "y" || a === "yes";
}

// Single-choice menu. Returns the chosen index (0-based).
export async function choose(label: string, options: string[], def = 0): Promise<number> {
  console.log(`  ${C.bold}${label}${C.reset}`);
  options.forEach((o, i) => {
    const sel = i === def;
    const tag = sel ? ` ${C.dim}· default${C.reset}` : "";
    console.log(`    ${C.accent}${i + 1})${C.reset} ${sel ? C.bold : ""}${o}${C.reset}${tag}`);
  });
  for (;;) {
    const a = await ask(`Choose 1-${options.length}`, { def: String(def + 1) });
    const n = parseInt(a, 10);
    if (n >= 1 && n <= options.length) return n - 1;
    warn("Please enter a number from the list.");
  }
}

export async function readEnv(path = ENV_PATH): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  try {
    const txt = await Bun.file(path).text();
    for (const line of txt.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 0) continue;
      m.set(t.slice(0, i).trim(), t.slice(i + 1));
    }
  } catch {
    /* no .env yet */
  }
  return m;
}

// Merge updates into .env (preserving existing lines + comments), chmod 600.
export async function upsertEnv(updates: Record<string, string>, path = ENV_PATH) {
  let content = "";
  try { content = await Bun.file(path).text(); } catch {}
  const lines = content.length ? content.split("\n") : [];
  for (const [k, v] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => l.startsWith(`${k}=`));
    const line = `${k}=${v}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  await Bun.write(path, lines.join("\n").replace(/\n*$/, "\n"));
  await Bun.spawn(["chmod", "600", path]).exited;
}
