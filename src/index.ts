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
import { isArmed, setArmed, armState } from "./arm.ts";
import { startWatcher } from "./notify/watcher.ts";

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
  c.json({ authenticated: isValidSession(c), configured: authConfigured(), armed: isArmed() }),
);

// Arm/disarm mutations — server-side state, authenticated. /chat reads this, not
// a client body flag, so one request can't both arm and trigger a mutation.
app.use("/auth/arm", requireAuth);
app.post("/auth/arm", async (c) => {
  let body: { on?: boolean };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  setArmed(body.on === true);
  return c.json(armState());
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
app.use("/chat", rateLimit({ limit: 20, windowMs: 60_000 }), requireAuth);

app.get("/status", async (c) => {
  try {
    const snapshot = await getStatusSnapshot();
    return c.json(snapshot);
  } catch (e) {
    console.error("[status] error:", (e as Error).message); // detail to logs, not the client
    return c.json({ error: "failed to collect status" }, 500);
  }
});

app.post("/chat", async (c) => {
  let body: { message?: string; history?: ChatMessage[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const message = (body.message ?? "").toString().trim();
  if (!message) return c.json({ error: "message is required" }, 400);
  if (message.length > MAX_MESSAGE_CHARS) return c.json({ error: "message too long" }, 413);

  const history = (Array.isArray(body.history) ? body.history : [])
    .slice(-40)
    .map((h) => ({ role: h?.role, content: String(h?.content ?? "").slice(0, MAX_MESSAGE_CHARS) }))
    .filter((h) => h.role === "user" || h.role === "assistant") as ChatMessage[];

  // Mutations are gated by server-side arm state, NOT a client-supplied flag.
  const allowMutations = isArmed();

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
      await runChat(message, history, (e) => enqueue(e.type, e), { allowMutations, signal: ac.signal });
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
const server = Bun.serve({
  hostname: config.bindHost,
  port: config.port,
  // generous idle timeout for long-running tool output streamed over SSE
  idleTimeout: 255,
  fetch: app.fetch,
});

console.log(`\n  ServerMind listening on http://${server.hostname}:${server.port}`);
console.log(`  AI: ${backendLabel()}  |  2FA: ${authConfigured() ? "configured" : "NOT configured — run `bun run setup-auth`"}`);
console.log(`  routes: /health /auth/login /status /chat`);

// Start the background email watcher (no-op unless email is configured).
startWatcher();
console.log("");
