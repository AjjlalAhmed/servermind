// Runtime settings service — the single source of truth for the editable subset
// of configuration (email, alerts, monitoring, AI).
//
// Design (industry-standard for a self-hosted app):
//   - .env  → bootstrap + the security boundary (auth, network bind, the service
//             allowlist, PM2 sudo) and the encryption key. The running app does
//             NOT write operational config here.
//   - data/settings.json → the editable subset, this file's responsibility.
//             Secrets are AES-256-GCM encrypted at rest (key in .env). Writes are
//             atomic (temp + rename, chmod 600) and validated with a Zod schema.
//             Every change is appended to data/settings-audit.log.
//   - On first run the store is seeded from the .env defaults so existing
//             installs carry over; thereafter settings.json is authoritative.

import { mkdirSync, writeFileSync, readFileSync, renameSync, chmodSync, appendFileSync } from "node:fs";
import { z } from "zod";
import { config } from "./config.ts";
import { upsertEnv } from "./wizard/io.ts";
import { encryptSecret, decryptSecret, hasKey, generateKey } from "./secret.ts";
import { CustomToolsSchema, setCustomTools, validateCustomTools, type CustomTool } from "./tools/custom.ts";

const MASK = "••••••••";
export const SECRET_MASK = MASK;
const DATA_DIR = new URL("../data/", import.meta.url).pathname;
const STORE_FILE = DATA_DIR + "settings.json";
const AUDIT_FILE = DATA_DIR + "settings-audit.log";

// ── schema: defines exactly what is editable; the validation boundary ─────────
const Editable = z.object({
  email: z.object({
    enabled: z.boolean(),
    method: z.enum(["smtp", "resend"]),
    to: z.string().max(320),
    from: z.string().max(320),
    smtpHost: z.string().max(255),
    smtpPort: z.number().int().min(1).max(65535),
    smtpUser: z.string().max(320),
    smtpPass: z.string().max(512),
    resendKey: z.string().max(512),
  }),
  alerts: z.object({
    diskPct: z.number().min(1).max(100),
    memPct: z.number().min(1).max(100),
    cooldownMin: z.number().min(1).max(10080),
    digestHour: z.number().int().min(-1).max(23),
    certDays: z.number().int().min(1).max(365),
    certDomains: z.array(z.string().max(255)).max(50),
  }),
  monitoredUnits: z.array(z.string().max(128)).max(100),
  ai: z.object({
    backend: z.enum(["openai", "claude-code"]),
    baseUrl: z.string().max(512),
    model: z.string().max(128),
    apiKey: z.string().max(512),
    claudeModel: z.string().max(128),
  }),
  // User-defined custom tools (Kind A + A+). Full schema + safety lives in
  // tools/custom.ts; here it's just persisted (db_query passwords encrypted).
  customTools: CustomToolsSchema,
});
type Store = z.infer<typeof Editable>;

// ── in-memory store, seeded from .env defaults ────────────────────────────────
const store: Store = {
  email: {
    enabled: config.email.enabled, method: config.email.method === "resend" ? "resend" : "smtp", to: config.email.to, from: config.email.from,
    smtpHost: config.email.smtp.host, smtpPort: config.email.smtp.port, smtpUser: config.email.smtp.user, smtpPass: config.email.smtp.pass,
    resendKey: config.email.resendKey,
  },
  alerts: {
    diskPct: config.alerts.diskPct, memPct: config.alerts.memPct, cooldownMin: config.alerts.cooldownMin,
    digestHour: config.alerts.digestHour, certDays: config.alerts.certDays, certDomains: [...config.alerts.certDomains],
  },
  monitoredUnits: [...config.monitoredUnits],
  ai: { backend: config.aiBackend === "openai" ? "openai" : "claude-code", baseUrl: config.aiBaseUrl, model: config.aiModel, apiKey: config.aiApiKey, claudeModel: config.model },
  customTools: [],
};

// DB connection passwords (db_query + db_console) are the only secret inside a
// custom tool.
const hasDbConn = (t: CustomTool): t is Extract<CustomTool, { kind: "db_query" | "db_console" }> =>
  t.kind === "db_query" || t.kind === "db_console";
const encTool = (t: CustomTool): CustomTool =>
  hasDbConn(t) ? { ...t, conn: { ...t.conn, password: encryptSecret(t.conn.password) } } : t;
const decTool = (t: CustomTool): CustomTool =>
  hasDbConn(t) ? { ...t, conn: { ...t.conn, password: safeDecrypt(t.conn.password) } } : t;

// ── persistence (atomic, encrypted secrets, chmod 600) ────────────────────────
function ensureDir() { try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ } }
const safeDecrypt = (v: unknown) => { try { return typeof v === "string" ? decryptSecret(v) : ""; } catch { return ""; } };

function load(): void {
  let saved: any;
  try { saved = JSON.parse(readFileSync(STORE_FILE, "utf8")); } catch { return; } // first run → keep .env seeds
  if (saved.email && typeof saved.email === "object") {
    Object.assign(store.email, saved.email);
    store.email.smtpPass = safeDecrypt(saved.email.smtpPass);
    store.email.resendKey = safeDecrypt(saved.email.resendKey);
  }
  if (saved.alerts && typeof saved.alerts === "object") Object.assign(store.alerts, saved.alerts);
  if (Array.isArray(saved.monitoredUnits)) store.monitoredUnits = saved.monitoredUnits;
  if (saved.ai && typeof saved.ai === "object") {
    Object.assign(store.ai, saved.ai);
    store.ai.apiKey = safeDecrypt(saved.ai.apiKey);
  }
  if (Array.isArray(saved.customTools)) {
    const v = validateCustomTools((saved.customTools as CustomTool[]).map(decTool));
    store.customTools = v.ok ? v.tools : [];
  }
  setCustomTools(store.customTools);
}

function persist(): void {
  ensureDir();
  const out = {
    email: { ...store.email, smtpPass: encryptSecret(store.email.smtpPass), resendKey: encryptSecret(store.email.resendKey) },
    alerts: store.alerts,
    monitoredUnits: store.monitoredUnits,
    ai: { ...store.ai, apiKey: encryptSecret(store.ai.apiKey) },
    customTools: store.customTools.map(encTool),
  };
  const tmp = STORE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
  renameSync(tmp, STORE_FILE);
  try { chmodSync(STORE_FILE, 0o600); } catch { /* ignore */ }
}

function audit(sections: string[], ip: string): void {
  ensureDir();
  try { appendFileSync(AUDIT_FILE, `${new Date().toISOString()} ip=${ip} changed=${sections.join(",") || "none"}\n`, { mode: 0o600 }); } catch { /* ignore */ }
}

// One-time bootstrap of the encryption key (the wizard normally does this).
async function ensureKey(): Promise<void> {
  if (hasKey()) return;
  const k = generateKey();
  process.env.SETTINGS_KEY = k;
  await upsertEnv({ SETTINGS_KEY: k });
}

load();

// ── live getters (modules read these; values reflect saved settings) ──────────
export const getEmail = () => store.email;
export const getAlerts = () => store.alerts;
export const getMonitoredUnits = () => store.monitoredUnits;
export const getAI = () => store.ai;
export const getCustomTools = () => store.customTools;
export const emailEnabled = () => store.email.enabled && store.email.to !== "";

// db_query passwords are masked for the API; new values come back in via the
// unmask step in updateSettings (mask/empty = keep the stored secret).
const maskTool = (t: CustomTool): CustomTool =>
  hasDbConn(t) ? { ...t, conn: { ...t.conn, password: t.conn.password ? MASK : "" } } : t;
function unmaskTool(t: any, current: CustomTool[]): any {
  if (!t || (t.kind !== "db_query" && t.kind !== "db_console") || !t.conn) return t;
  const pw = t.conn.password;
  if (pw !== MASK && pw !== "" && pw != null) return t; // a new password was provided
  const prev = current.find((c) => c.name === t.name && (c.kind === "db_query" || c.kind === "db_console")) as Extract<CustomTool, { kind: "db_query" | "db_console" }> | undefined;
  return { ...t, conn: { ...t.conn, password: prev?.conn.password ?? "" } };
}

// ── API view: secrets are masked, never returned in clear ─────────────────────
export function settingsForApi() {
  return {
    email: {
      enabled: store.email.enabled, method: store.email.method, to: store.email.to, from: store.email.from,
      smtpHost: store.email.smtpHost, smtpPort: store.email.smtpPort, smtpUser: store.email.smtpUser,
      smtpPass: store.email.smtpPass ? MASK : "", resendKey: store.email.resendKey ? MASK : "",
    },
    alerts: { ...store.alerts },
    monitoredUnits: store.monitoredUnits,
    ai: { backend: store.ai.backend, baseUrl: store.ai.baseUrl, model: store.ai.model, apiKey: store.ai.apiKey ? MASK : "", claudeModel: store.ai.claudeModel },
    customTools: store.customTools.map(maskTool),
  };
}

const num = (v: unknown, fallback: number): number => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
const toList = (v: unknown): string[] => (Array.isArray(v) ? v : String(v ?? "").split(",")).map((s) => String(s).trim()).filter(Boolean);
const keepSecret = (v: unknown) => typeof v !== "string" || v === MASK || v === ""; // mask/empty = unchanged

// Validate a patch against the schema (end-state), then commit + persist + audit.
export async function updateSettings(patch: any, ip = "?"): Promise<{ ok: boolean; error?: string }> {
  if (!patch || typeof patch !== "object") return { ok: false, error: "invalid body" };
  const cand: Store = structuredClone(store);

  const e = patch.email;
  if (e && typeof e === "object") {
    if (typeof e.enabled === "boolean") cand.email.enabled = e.enabled;
    if (e.method === "smtp" || e.method === "resend") cand.email.method = e.method;
    if (typeof e.to === "string") cand.email.to = e.to.trim();
    if (typeof e.from === "string") cand.email.from = e.from.trim();
    if (typeof e.smtpHost === "string") cand.email.smtpHost = e.smtpHost.trim();
    if (e.smtpPort != null && e.smtpPort !== "") cand.email.smtpPort = num(e.smtpPort, cand.email.smtpPort);
    if (typeof e.smtpUser === "string") cand.email.smtpUser = e.smtpUser.trim();
    if (!keepSecret(e.smtpPass)) cand.email.smtpPass = String(e.smtpPass);
    if (!keepSecret(e.resendKey)) cand.email.resendKey = String(e.resendKey).trim();
  }
  const a = patch.alerts;
  if (a && typeof a === "object") {
    if (a.diskPct != null) cand.alerts.diskPct = num(a.diskPct, cand.alerts.diskPct);
    if (a.memPct != null) cand.alerts.memPct = num(a.memPct, cand.alerts.memPct);
    if (a.cooldownMin != null) cand.alerts.cooldownMin = num(a.cooldownMin, cand.alerts.cooldownMin);
    if (a.digestHour !== undefined) cand.alerts.digestHour = a.digestHour === "" || a.digestHour == null ? -1 : num(a.digestHour, cand.alerts.digestHour);
    if (a.certDays != null) cand.alerts.certDays = num(a.certDays, cand.alerts.certDays);
    if (a.certDomains !== undefined) cand.alerts.certDomains = toList(a.certDomains);
  }
  if (patch.monitoredUnits !== undefined) cand.monitoredUnits = toList(patch.monitoredUnits);
  const ai = patch.ai;
  if (ai && typeof ai === "object") {
    if (ai.backend === "openai" || ai.backend === "claude-code") cand.ai.backend = ai.backend;
    if (typeof ai.baseUrl === "string") cand.ai.baseUrl = ai.baseUrl.trim().replace(/\/+$/, "");
    if (typeof ai.model === "string") cand.ai.model = ai.model.trim();
    if (!keepSecret(ai.apiKey)) cand.ai.apiKey = String(ai.apiKey).trim();
    if (typeof ai.claudeModel === "string") cand.ai.claudeModel = ai.claudeModel.trim();
  }
  if (patch.customTools !== undefined) {
    const incoming = Array.isArray(patch.customTools) ? patch.customTools : [];
    const v = validateCustomTools(incoming.map((t: any) => unmaskTool(t, store.customTools)));
    if (!v.ok) return { ok: false, error: v.error };
    cand.customTools = v.tools;
  }

  const parsed = Editable.safeParse(cand);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }

  try {
    await ensureKey(); // need a key before encrypting on persist
    Object.assign(store, parsed.data);
    setCustomTools(store.customTools); // keep the live tool registry in sync
    persist();
    audit(Object.keys(patch).filter((k) => ["email", "alerts", "monitoredUnits", "ai", "customTools"].includes(k)), ip);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
