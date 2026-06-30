// ServerMind — HTTP entry point (Bun + Hono).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import { config, authConfigured } from "./config.ts";
import { requireAuth } from "./auth.ts";
import { runChat, backendLabel, type ChatMessage } from "./backend.ts";
import { getStatusSnapshot } from "./status.ts";
import { rateLimit, acquireChatSlot, clientKey } from "./ratelimit.ts";
import { verifyLogin } from "./auth/login.ts";
import { createSession, destroySession, isValidSession } from "./auth/session.ts";
import { localAgent, type Agent } from "./agent.ts";
import { startWatcher } from "./notify/watcher.ts";
import { startProfileRefresh, refreshProfile, getServerProfile } from "./notify/profile.ts";
import { startFleetHub, fleetEnabled, fleetRegistry, fleetWebSocket, isAgentConnected, removeAgent, fleetTokenOk } from "./fleet/hub.ts";
import { RemoteAgent, isAgentArmed } from "./fleet/remote.ts";
import { MeshController } from "./fleet/mesh-controller.ts";
import { controllerIp } from "./fleet/wireguard.ts";

// The controller's WireGuard mesh manager — set on boot when config.mesh.enabled.
// Routes reference it lazily, so it's fine that it's assigned after the routes
// are defined (a request can't arrive before the server is listening).
let meshController: MeshController | null = null;
import { settingsForApi, updateSettings, getAI, getCustomTools, SECRET_MASK } from "./settings.ts";
import { validateCustomTools, runCustomTool } from "./tools/custom.ts";

// Resolve which box a request targets: the local controller box by default, or a
// connected remote agent by id. Returns an error marker if the agent is offline.
function targetAgent(serverId: unknown): { agent: Agent } | { error: string; status: 409 } {
  const id = typeof serverId === "string" ? serverId : "";
  if (!id || id === "local") return { agent: localAgent };
  if (!isAgentConnected(id)) return { error: "that server is offline", status: 409 };
  return { agent: new RemoteAgent(id) };
}
import { sendEmail } from "./notify/email.ts";
import { buildDigest } from "./notify/report.ts";

const MAX_MESSAGE_CHARS = 16_000;
const MAX_BODY_BYTES = 256 * 1024;

const app = new Hono();
app.use("*", logger());

// ─── Security headers (applied to every response) ────────────────────────────
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  // All assets are first-party now (no third-party scripts/styles). Inline
  // styles are still used for a few dynamic values, hence 'unsafe-inline' there.
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      // Geist (sans+mono) is served via @fontsource on jsDelivr (CSS + woff2).
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
      "font-src 'self' https://cdn.jsdelivr.net",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join("; "),
  );
});

// Reject oversized request bodies before parsing (defense against memory abuse).
app.use("/chat", bodyLimit);
app.use("/auth/login", bodyLimit);
async function bodyLimit(c: Parameters<typeof requireAuth>[0], next: Parameters<typeof requireAuth>[1]) {
  const len = Number(c.req.header("content-length") || "0");
  if (len > MAX_BODY_BYTES) return c.json({ error: "request too large" }, 413);
  await next();
}

const PUBLIC_DIR = new URL("./public/", import.meta.url).pathname;
const ASSET_TYPES: Record<string, string> = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

// Version assets by a hash of their content. The index page references
// /app.css?v=<hash> and /app.js?v=<hash>, so any release that changes those
// files yields new URLs — which auto-busts Cloudflare / browser caches with no
// manual purge. HTML itself isn't cached by Cloudflare, so it's always fresh.
const ASSET_VERSION = (() => {
  try {
    const h = createHash("sha1");
    h.update(readFileSync(PUBLIC_DIR + "app.css"));
    h.update(readFileSync(PUBLIC_DIR + "app.js"));
    return h.digest("hex").slice(0, 10);
  } catch {
    return Date.now().toString(36);
  }
})();
const INDEX_HTML = (() => {
  try {
    return readFileSync(PUBLIC_DIR + "index.html", "utf8")
      .replace("/app.css", `/app.css?v=${ASSET_VERSION}`)
      .replace("/app.js", `/app.js?v=${ASSET_VERSION}`);
  } catch {
    return "<!doctype html><meta charset=utf-8><p>index.html not found</p>";
  }
})();

// ─── Public ──────────────────────────────────────────────────────────────────
app.get("/", () =>
  new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } }),
);

// Static assets — explicit routes. Because the URL is content-versioned, these
// can be cached hard; a content change changes the URL.
async function serveAsset(c: Parameters<typeof requireAuth>[0], name: string, type: string) {
  const file = Bun.file(PUBLIC_DIR + name);
  if (!(await file.exists())) return c.notFound();
  return new Response(file, { headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable" } });
}
app.get("/app.css", (c) => serveAsset(c, "app.css", ASSET_TYPES[".css"]!));
app.get("/app.js", (c) => serveAsset(c, "app.js", ASSET_TYPES[".js"]!));

app.get("/health", (c) => c.json({ ok: true, service: "servermind", time: new Date().toISOString() }));

// ─── Auth (login with password + TOTP, session cookie) ─────────────────────────
// Whether the browser currently holds a valid session, and whether the server
// has credentials configured at all.
app.get("/auth/me", (c) =>
  c.json({ authenticated: isValidSession(c), configured: authConfigured(), armed: localAgent.isArmed(), fleet: fleetEnabled() }),
);

// Arm/disarm mutations — server-side state, authenticated. /chat reads this, not
// a client body flag, so one request can't both arm and trigger a mutation.
app.use("/auth/arm", requireAuth);
app.post("/auth/arm", async (c) => {
  let body: { on?: boolean; server?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  const t = targetAgent(body.server); // arm the local box, or a selected remote agent
  if ("error" in t) return c.json({ error: t.error }, t.status);
  return c.json(t.agent.setArmed(body.on === true));
});

// Stricter limiter on login to slow credential stuffing (lockout is in login.ts).
app.post("/auth/login", rateLimit({ limit: 10, windowMs: 60_000 }), async (c) => {
  let body: { password?: string; totp?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const result = await verifyLogin(clientKey(c), String(body.password ?? ""), String(body.totp ?? ""));
  if (!result.ok) {
    if (result.retryAfterSec) c.header("retry-after", String(result.retryAfterSec));
    return c.json({ error: result.error, retryAfterSec: result.retryAfterSec }, result.status as 401);
  }
  createSession(c);
  return c.json({ ok: true });
});

app.post("/auth/logout", (c) => {
  destroySession(c);
  return c.json({ ok: true });
});

// ─── Authenticated API ─────────────────────────────────────────────────────────
// Rate-limit runs before auth so unauthenticated probes are throttled too.
app.use("/status", rateLimit({ limit: 60, windowMs: 60_000 }), requireAuth);
app.use("/profile", rateLimit({ limit: 60, windowMs: 60_000 }), requireAuth);
app.use("/chat", rateLimit({ limit: 20, windowMs: 60_000 }), requireAuth);

app.get("/status", async (c) => {
  try {
    const snapshot = await localAgent.status();
    return c.json(snapshot);
  } catch (e) {
    console.error("[status] error:", (e as Error).message); // detail to logs, not the client
    return c.json({ error: "failed to collect status" }, 500);
  }
});

// The Server Memory profile (cached; what the assistant sees). ?refresh=1 forces
// a fresh scan instead of returning the cached one.
app.get("/profile", async (c) => {
  try {
    if (c.req.query("refresh")) await refreshProfile();
    return c.json({ profile: getServerProfile() });
  } catch (e) {
    console.error("[profile] error:", (e as Error).message);
    return c.json({ error: "failed to read profile" }, 500);
  }
});

// Fleet overview — every connected agent + its latest status. Empty list when
// this instance isn't acting as a controller (no FLEET_JOIN_TOKEN).
app.use("/fleet", requireAuth);
app.get("/fleet", (c) => {
  const reg = fleetRegistry();
  const servers = (reg ? reg.list() : []).map((s) => ({ ...s, armed: isAgentArmed(s.id) }));
  // canChat = the controller's AI backend can drive a remote box (OpenAI-compatible).
  // joinToken + mesh let the Fleet UI render the "Add server" enroll command.
  // `self` is the controller's own box memory, so the fleet view can show it too.
  const own = getServerProfile();
  return c.json({
    enabled: fleetEnabled(),
    canChat: getAI().backend === "openai",
    mesh: config.mesh.enabled,
    joinToken: fleetEnabled() ? config.fleet.joinToken : "",
    self: own ? { hostname: own.host?.hostname || "controller", profile: own } : null,
    servers,
  });
});

app.use("/fleet/remove", requireAuth);
app.post("/fleet/remove", async (c) => {
  let body: { server?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  if (!body.server) return c.json({ error: "server is required" }, 400);
  removeAgent(body.server);
  // Drop the revoked agent's WireGuard peer from the live interface too, so a
  // removed box can't keep talking over the mesh.
  if (meshController) await meshController.reapply();
  return c.json({ ok: true });
});

// Agent enrollment into the WireGuard mesh. Token-gated (agents have no session),
// rate-limited, body-capped. The agent sends only its PUBLIC key; we return the
// address + controller pubkey/endpoint it needs to build its own config. This is
// the one bootstrap hop over the public port before traffic moves onto the mesh.
app.use("/fleet/enroll", bodyLimit);
app.post("/fleet/enroll", rateLimit({ limit: 20, windowMs: 60_000 }), async (c) => {
  if (!meshController) return c.json({ error: "mesh is not enabled on this controller" }, 400);
  let body: { token?: string; agentId?: string; hostname?: string; pubkey?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  if (!fleetTokenOk(String(body.token ?? ""))) return c.json({ error: "unauthorized" }, 401);
  const id = String(body.agentId ?? "");
  const hostname = String(body.hostname ?? "");
  // Same charset constraints as the websocket hello (defence-in-depth vs markup).
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(id)) return c.json({ error: "invalid agentId" }, 400);
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(hostname)) return c.json({ error: "invalid hostname" }, 400);
  fleetRegistry()?.register(id, hostname);
  const res = await meshController.enroll({ id, hostname, pubkey: String(body.pubkey ?? "") });
  if ("error" in res) return c.json({ error: res.error }, 400);
  // Tell the agent how to reach us OVER the mesh from here on: the controller's
  // mesh IP + app port. Plain ws:// is fine — WireGuard already encrypts the hop.
  const controllerMeshUrl = `ws://${controllerIp({ cidr: res.cidr })}:${config.port}/fleet/agent`;
  return c.json({ ...res, controllerMeshUrl });
});

// ─── Dashboard settings (authenticated; secrets masked in responses) ───────────
// Only the safe subset is editable here — auth, the service allowlist, PM2 sudo
// and the network bind stay in .env. Updates apply live AND persist to .env.
app.use("/settings", bodyLimit, requireAuth);
app.use("/settings/*", requireAuth);

app.get("/settings", (c) => c.json(settingsForApi()));

app.post("/settings", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  const r = await updateSettings(body, clientKey(c)); // ip recorded in the audit log
  return r.ok ? c.json(settingsForApi()) : c.json({ error: r.error }, 400);
});

app.post("/settings/test-email", async (c) => {
  const r = await sendEmail("ServerMind test email ✓", "This is a test from ServerMind Settings.\nIf you got this, email reports & alerts are working.\n\n— ServerMind");
  return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, 400);
});

app.post("/settings/report-now", async (c) => {
  try {
    const digest = buildDigest(await getStatusSnapshot());
    const r = await sendEmail(digest.subject, digest.body);
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, 400);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

// ─── Custom tools (Kind A + A+) — operator-defined, persisted as settings ──────
// /settings/* is already auth-guarded above; add the body cap for the writers.
app.use("/settings/tools", bodyLimit);
app.use("/settings/tools/*", bodyLimit);

// db_query connection passwords are masked in responses; the client sends the
// mask back unchanged and updateSettings() preserves the stored secret.
app.get("/settings/tools", (c) => c.json({ tools: settingsForApi().customTools }));

// Replace the whole list (the panel maintains it client-side, like Settings).
app.post("/settings/tools", async (c) => {
  let body: { tools?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  const r = await updateSettings({ customTools: body.tools ?? [] }, clientKey(c));
  return r.ok ? c.json({ tools: settingsForApi().customTools }) : c.json({ error: r.error }, 400);
});

app.delete("/settings/tools/:name", async (c) => {
  const name = c.req.param("name");
  const next = getCustomTools().filter((t) => t.name !== name);
  const r = await updateSettings({ customTools: next }, clientKey(c));
  return r.ok ? c.json({ tools: settingsForApi().customTools }) : c.json({ error: r.error }, 400);
});

// Dry-run a single manifest before saving. A mutating tool is gated on the arm
// switch here too, so "Test" can't sneak a mutation past the disarmed state.
app.post("/settings/tools/test", async (c) => {
  let body: { tool?: any };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  let manifest = body.tool;
  if (manifest?.kind === "db_query" && manifest.conn && (manifest.conn.password === SECRET_MASK || !manifest.conn.password)) {
    const prev = getCustomTools().find((t) => t.name === manifest.name && t.kind === "db_query");
    if (prev?.kind === "db_query") manifest = { ...manifest, conn: { ...manifest.conn, password: prev.conn.password } };
  }
  const v = validateCustomTools([manifest]);
  if (!v.ok) return c.json({ error: v.error }, 400);
  const tool = v.tools[0]!;
  if (tool.mutating && !localAgent.isArmed()) return c.json({ error: "arm mutations first to test a mutating tool" }, 400);
  const r = await runCustomTool(tool);
  return c.json({ ok: !r.isError, output: r.content });
});

app.post("/chat", async (c) => {
  let body: { message?: string; history?: ChatMessage[]; server?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const message = (body.message ?? "").toString().trim();
  if (!message) return c.json({ error: "message is required" }, 400);
  if (message.length > MAX_MESSAGE_CHARS) return c.json({ error: "message too long" }, 413);

  // Which box does this chat act on — local, or a selected remote agent?
  const t = targetAgent(body.server);
  if ("error" in t) return c.json({ error: t.error }, t.status);
  const agent = t.agent;
  // The Claude Code backend runs tools in a local MCP subprocess, so it can only
  // act on this box. Remote-server chat needs an OpenAI-compatible backend.
  if (agent !== localAgent && getAI().backend === "claude-code") {
    return c.json({ error: "Remote-server chat needs an OpenAI-compatible AI backend on the controller (Claude Code runs locally only)." }, 400);
  }

  const history = (Array.isArray(body.history) ? body.history : [])
    .slice(-40)
    .map((h) => ({ role: h?.role, content: String(h?.content ?? "").slice(0, MAX_MESSAGE_CHARS) }))
    .filter((h) => h.role === "user" || h.role === "assistant") as ChatMessage[];

  // Mutations are gated by the TARGET box's arm state, NOT a client-supplied flag.
  const allowMutations = agent.isArmed();
  // Fleet mode: chatting on the controller box with a fleet → expose fleet-wide tools.
  const fleet = agent === localAgent && fleetEnabled();

  // Cap concurrent chats — each spawns a claude + MCP subprocess.
  const release = acquireChatSlot();
  if (!release) {
    return c.json({ error: "server busy — too many concurrent chats, try again shortly" }, 429);
  }

  return streamSSE(c, async (stream) => {
    // When the client disconnects (e.g. the user hits Stop), abort the run so
    // runChat kills the underlying `claude` process instead of letting it finish
    // in the background.
    const ac = new AbortController();
    stream.onAbort(() => ac.abort());

    // Serialise all writes into one chain so events keep their order AND so we
    // can flush everything before the handler returns (an un-awaited writeSSE
    // is dropped when the stream closes).
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (event: string, data: unknown) => {
      chain = chain.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => {});
    };

    // Heartbeat so proxies don't drop the idle connection during long tool runs.
    let alive = true;
    const beat = setInterval(() => {
      if (alive) enqueue("ping", {});
    }, 15_000);

    try {
      await runChat(message, history, (e) => enqueue(e.type, e), { allowMutations, signal: ac.signal, agent, fleet });
    } catch (err) {
      if (!ac.signal.aborted) enqueue("error", { type: "error", message: (err as Error).message });
    } finally {
      alive = false;
      clearInterval(beat);
      await chain; // ensure all queued events are flushed before closing
      release(); // free the concurrency slot
    }
  });
});

// Start the server explicitly. We do NOT rely on Bun's `export default { fetch }`
// auto-serve — it doesn't reliably fire when launched under PM2, so the process
// would stay alive without ever binding the port. Bun.serve() guarantees it.
// Fleet controller hub — only initialized when FLEET_JOIN_TOKEN is set. Agents
// connect over a WebSocket at /fleet/agent. Standalone leaves this null.
const fleetHub = fleetEnabled() ? startFleetHub() : null;

// WireGuard mesh: bring up wg0 from current registry state on boot. Only when
// --mesh provisioned the host (config.mesh.enabled); standalone is untouched.
if (fleetHub && config.mesh.enabled) {
  const reg = fleetRegistry();
  if (reg) {
    meshController = new MeshController(reg);
    meshController.start().then((r) => {
      if (r.ok) console.log(`  Mesh: ${config.mesh.iface} up (${config.mesh.cidr}); agents enroll at /fleet/enroll`);
      else console.error(`  Mesh: failed to bring up ${config.mesh.iface} — ${r.error}`);
    });
  }
}

const server = Bun.serve({
  hostname: config.bindHost,
  port: config.port,
  // generous idle timeout for long-running tool output streamed over SSE
  idleTimeout: 255,
  fetch(req, srv) {
    if (fleetHub) {
      const { pathname } = new URL(req.url);
      if (pathname === "/fleet/agent") {
        // Agents dial in here; upgrade to a WebSocket handled by fleetWebSocket.
        if (srv.upgrade(req, { data: { agentId: null } })) return undefined;
        return new Response("expected a websocket upgrade", { status: 426 });
      }
    }
    return app.fetch(req, srv);
  },
  websocket: fleetWebSocket,
});

console.log(`\n  ServerMind listening on http://${server.hostname}:${server.port}`);
console.log(`  AI: ${backendLabel()}  |  2FA: ${authConfigured() ? "configured" : "NOT configured — run `bun run setup-auth`"}`);
console.log(`  routes: /health /auth/login /status /chat${fleetHub ? " /fleet  (hub: /fleet/agent)" : ""}`);
if (fleetHub) console.log("  Fleet: controller hub ON — agents may connect with the join token");

// Start the background email watcher (no-op unless email is configured).
startWatcher();
// Start the self-refreshing Server Memory (scans the box on a slow schedule and
// feeds a short profile into the assistant's system prompt).
startProfileRefresh();
console.log("");
