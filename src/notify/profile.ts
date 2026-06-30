// Server Memory (Phase 1): a compact, self-refreshing profile of THIS box.
//
// Every refresh it scans the server — services (incl. FAILED units), listening
// ports, PM2 processes, resource pressure, datastores — derives a few plain-text
// "notes", and persists a small JSON file. A short summary is cached in memory
// and injected into the assistant's system prompt, so every chat (on any AI
// backend) starts already knowing the box instead of re-discovering it.
//
// No LLM is involved: this is a scripted scan on a slow schedule. It reuses the
// same probes the status snapshot and watcher already use.

import { writeFileSync, renameSync, readFileSync, mkdirSync } from "node:fs";
import { getStatusSnapshot, type StatusSnapshot } from "../status.ts";
import { exec } from "../tools/exec.ts";
import { listCustomTools } from "../tools/custom.ts";

const DATA_DIR = new URL("../../data/", import.meta.url).pathname;
const PROFILE_FILE = DATA_DIR + "server-profile.json";

const REFRESH_INTERVAL_MS = 15 * 60_000; // services/topology change slowly
const FIRST_REFRESH_DELAY_MS = 20_000; // let the server settle after boot

export interface ServerProfile {
  updatedAt: string;
  host: { hostname: string; uname: string; uptime: string; cores: number };
  resources: { memUsedPct: number; memTotal: string; diskUsedPct: number; swap: string };
  services: { monitored: Record<string, string>; failed: string[] };
  pm2: string[];
  ports: { port: number; proc: string }[];
  datastores: { redis: string; mysql: string };
  customTools: string[];
  notes: string[];
}

// In-memory cache of the rendered prompt block, kept warm across chats. Empty
// until the first refresh (or a persisted file) lands.
let cachedBlock = "";
let cachedProfile: ServerProfile | null = null;

export function getServerProfile(): ServerProfile | null { return cachedProfile; }

// The short text injected into the system prompt. Returns "" before the first
// scan so the prompt is simply unchanged until a profile exists.
export function getServerProfileBlock(): string { return cachedBlock; }

// Probes can fail (a binary missing, a unit absent) and return multi-line error
// text. Keep the profile tidy: collapse whitespace + clamp length, and reduce a
// service state to a single clean token (else "unknown").
const clamp = (s: string, n = 60) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
const shortState = (s: string) => { const v = clamp(s, 24); return /^[a-z-]+$/i.test(v) ? v : "unknown"; };

function human(bytes: number): string {
  if (!bytes) return "0";
  const u = ["B", "K", "M", "G", "T"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || Number.isInteger(n) ? Math.round(n) : n.toFixed(1)}${u[i]}`;
}

// systemctl list-units --state=failed → the unit names. The single highest-value
// signal: a worker that died silently shows up here.
async function failedUnits(): Promise<string[]> {
  const r = await exec(
    ["systemctl", "list-units", "--state=failed", "--no-legend", "--plain", "--no-pager"],
    { timeoutMs: 6_000 },
  );
  if (!r.ok) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0] ?? "")
    .filter((u) => u && u.endsWith(".service"))
    .slice(0, 20);
}

// ss -tlnp → a compact, deduped list of listening TCP ports + the process behind
// each (process name is only present when ss can see it; absent otherwise).
async function listeningPorts(): Promise<{ port: number; proc: string }[]> {
  const r = await exec(["ss", "-tlnp"], { timeoutMs: 6_000 });
  if (!r.ok) return [];
  const byPort = new Map<number, string>();
  for (const line of r.stdout.split("\n")) {
    if (!/LISTEN/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols.find((c) => /:\d+$/.test(c)); // e.g. 0.0.0.0:80 or [::]:443
    const port = local ? Number(local.slice(local.lastIndexOf(":") + 1)) : NaN;
    if (!Number.isFinite(port) || port <= 0) continue;
    const m = line.match(/users:\(\("([^"]+)"/);
    if (!byPort.has(port)) byPort.set(port, m?.[1] ?? "");
  }
  return [...byPort.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, 14)
    .map(([port, proc]) => ({ port, proc }));
}

function pm2Names(snap: StatusSnapshot): string[] {
  const procs = snap.pm2.ok ? (snap.pm2 as any).processes : null;
  if (Array.isArray(procs)) {
    return procs.map((p: any) => (typeof p === "string" ? p : p?.name)).filter(Boolean).slice(0, 30);
  }
  return [];
}

export function deriveNotes(p: Omit<ServerProfile, "notes">): string[] {
  const notes: string[] = [];
  if (p.services.failed.length) notes.push(`${p.services.failed.length} failed systemd unit(s): ${p.services.failed.join(", ")}`);
  for (const [unit, state] of Object.entries(p.services.monitored)) {
    if (state !== "active") notes.push(`monitored unit ${unit} is "${state}"`);
  }
  if (p.resources.swap === "none") notes.push("no swap configured");
  if (p.resources.memUsedPct >= 85) notes.push(`memory pressure high (${p.resources.memUsedPct}% used)`);
  if (p.resources.diskUsedPct >= 85) notes.push(`disk pressure high (${p.resources.diskUsedPct}% used)`);
  if (p.datastores.redis && !/ok|pong|up/i.test(p.datastores.redis)) notes.push(`redis probe: ${p.datastores.redis}`);
  if (p.datastores.mysql && !/ok|up/i.test(p.datastores.mysql)) notes.push(`mysql probe: ${p.datastores.mysql}`);
  return notes.slice(0, 8);
}

export function renderProfileBlock(p: ServerProfile): string {
  const svc = Object.entries(p.services.monitored).map(([u, s]) => `${u} ${s}`).join(", ") || "none configured";
  const failed = p.services.failed.length ? `  | FAILED: ${p.services.failed.join(", ")}` : "";
  const ports = p.ports.map((x) => (x.proc ? `${x.port}(${x.proc})` : String(x.port))).join(", ") || "none seen";
  const pm2 = p.pm2.length ? p.pm2.join(", ") : "none";
  const tools = p.customTools.length ? `\n- Custom tools available: ${p.customTools.join(", ")}` : "";
  const notes = p.notes.length ? `\n- Notes: ${p.notes.join("; ")}` : "";
  return [
    `Server profile (auto-scanned ${p.updatedAt}; background context — confirm with live tools before acting):`,
    `- Host: ${p.host.hostname} · ${p.host.uname} · ${p.host.uptime} · ${p.host.cores} cores`,
    `- Resources: mem ${p.resources.memUsedPct}% of ${p.resources.memTotal} · disk ${p.resources.diskUsedPct}% · swap ${p.resources.swap}`,
    `- Services: ${svc}${failed}`,
    `- PM2: ${pm2}`,
    `- Listening: ${ports}`,
    `- Datastores: redis ${p.datastores.redis || "n/a"} · mysql ${p.datastores.mysql || "n/a"}${tools}${notes}`,
  ].join("\n");
}

// Build a fresh profile from live probes (does not persist).
export async function buildServerProfile(): Promise<ServerProfile> {
  const snap = await getStatusSnapshot();
  const [failed, ports] = await Promise.all([failedUnits(), listeningPorts()]);

  const swap = snap.metrics.memory.swapTotal === 0
    ? "none"
    : `${human(snap.metrics.memory.swapUsed)}/${human(snap.metrics.memory.swapTotal)}`;

  const uptime = /illegal|usage|not found|no such/i.test(snap.host.uptime) ? "unknown" : clamp(snap.host.uptime, 40);
  const monitored: Record<string, string> = {};
  for (const [unit, state] of Object.entries(snap.services)) monitored[unit] = shortState(state);

  const base: Omit<ServerProfile, "notes"> = {
    updatedAt: snap.timestamp,
    host: { hostname: clamp(snap.host.hostname, 60), uname: clamp(snap.host.uname, 90), uptime, cores: snap.cpu.cores },
    resources: {
      memUsedPct: snap.metrics.memory.usedPct,
      memTotal: human(snap.metrics.memory.totalBytes),
      diskUsedPct: snap.metrics.disk.usedPct,
      swap,
    },
    services: { monitored, failed },
    pm2: pm2Names(snap),
    ports,
    datastores: {
      redis: typeof snap.redis === "object" ? ((snap.redis as any)?.ok ? "ok" : "down") : clamp(String(snap.redis), 40),
      // A client deprecation WARNING masks the real result — don't surface it as
      // the state; report unreachable instead.
      mysql: snap.mysql.ok ? "ok" : /warning|deprecat/i.test(snap.mysql.detail) ? "unreachable" : clamp(snap.mysql.detail, 40) || "down",
    },
    customTools: listCustomTools().map((t) => t.name),
  };
  return { ...base, notes: deriveNotes(base) };
}

function persist(p: ServerProfile): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = PROFILE_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(p, null, 2), { mode: 0o600 });
    renameSync(tmp, PROFILE_FILE);
  } catch (e) {
    console.error("[profile] persist failed:", (e as Error).message);
  }
}

// Build → cache → persist. Safe to call ad hoc (e.g. after a config change).
export async function refreshProfile(): Promise<ServerProfile | null> {
  try {
    const p = await buildServerProfile();
    cachedProfile = p;
    cachedBlock = renderProfileBlock(p);
    persist(p);
    return p;
  } catch (e) {
    console.error("[profile] refresh failed:", (e as Error).message);
    return null;
  }
}

// Warm the cache from the last persisted profile so a freshly-restarted process
// already has context before the first live scan completes.
function loadPersisted(): void {
  try {
    const p = JSON.parse(readFileSync(PROFILE_FILE, "utf8")) as ServerProfile;
    cachedProfile = p;
    cachedBlock = renderProfileBlock(p);
  } catch { /* no prior profile — fine */ }
}

export function startProfileRefresh(): void {
  loadPersisted();
  setTimeout(() => { void refreshProfile(); }, FIRST_REFRESH_DELAY_MS);
  setInterval(() => { void refreshProfile(); }, REFRESH_INTERVAL_MS);
}
