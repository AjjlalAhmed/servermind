import type { Context, Next } from "hono";

// Lightweight in-memory protection. ServerMind is a single-operator tool, so we
// don't need a distributed limiter — just a backstop against runaway loops,
// accidental hammering, and a compromised token spawning unbounded `claude`
// processes (which cost CPU and subscription quota).

// Derive a client identity for rate-limiting / lockout that an attacker can't
// trivially spoof. By DEFAULT we use the real TCP peer address — forwarding
// headers (X-Forwarded-For, X-Real-IP, …) are attacker-controlled on a directly
// reachable instance, so trusting them lets a client rotate them per request and
// defeat the lockout entirely. Header trust is opt-in: set TRUST_PROXY=1 (and,
// for a custom header like Cloudflare's, TRUSTED_CLIENT_HEADER=cf-connecting-ip)
// only when EVERY request is forced through your reverse proxy.
function proxyTrusted(): boolean {
  if (/^(1|true|yes)$/i.test((process.env.TRUST_PROXY || "").trim())) return true;
  // Configuring a trusted header is itself an explicit statement of proxy trust.
  return (process.env.TRUSTED_CLIENT_HEADER || "").trim() !== "";
}

export function clientKey(c: Context): string {
  if (proxyTrusted()) {
    const trusted = (process.env.TRUSTED_CLIENT_HEADER || "").trim().toLowerCase();
    if (trusted) {
      const v = c.req.header(trusted);
      if (v) return v.split(",")[0]!.trim();
    }
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1]!; // rightmost = proxy-set peer IP
    }
    const xri = c.req.header("x-real-ip")?.trim();
    if (xri) return xri;
  }
  // Real TCP peer — the Bun server is passed as Hono's `env` from index.ts.
  const srv = c.env as { requestIP?: (r: Request) => { address?: string } | null } | undefined;
  return srv?.requestIP?.(c.req.raw)?.address || "local";
}

interface Window {
  count: number;
  reset: number;
}
const windows = new Map<string, Window>();

// Fixed-window rate limiter middleware.
export function rateLimit(opts: { limit: number; windowMs: number }) {
  return async (c: Context, next: Next) => {
    const now = Date.now();
    const key = clientKey(c);

    // Opportunistic prune so the map can't grow without bound.
    if (windows.size > 5000) {
      for (const [k, w] of windows) if (now > w.reset) windows.delete(k);
    }

    let w = windows.get(key);
    if (!w || now > w.reset) {
      w = { count: 0, reset: now + opts.windowMs };
      windows.set(key, w);
    }
    w.count++;

    if (w.count > opts.limit) {
      const retry = Math.max(1, Math.ceil((w.reset - now) / 1000));
      c.header("retry-after", String(retry));
      return c.json({ error: "rate limited", retryAfter: retry }, 429);
    }
    await next();
  };
}

// Global concurrency guard for the expensive /chat path (each request spawns a
// `claude` + MCP subprocess). Returns a release fn, or null if at capacity.
let activeChats = 0;
const MAX_CONCURRENT_CHATS = Number(process.env.MAX_CONCURRENT_CHATS || "3");

export function acquireChatSlot(): (() => void) | null {
  if (activeChats >= MAX_CONCURRENT_CHATS) return null;
  activeChats++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeChats--;
  };
}
