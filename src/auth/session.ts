// Server-side session store. Sessions live only in memory, so a restart logs
// everyone out (a feature for an admin tool). The session id is a 256-bit
// random token delivered in an HttpOnly, SameSite=Strict cookie — not readable
// by JavaScript, which neutralises the XSS token-theft risk of the old design.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import { config } from "../config.ts";

export const COOKIE_NAME = "servermind_session";

interface Session {
  expires: number;
  createdAt: number;
}
const sessions = new Map<string, Session>();

function sweep(now: number) {
  if (sessions.size < 1000) return;
  for (const [id, s] of sessions) if (now >= s.expires) sessions.delete(id);
}

// The cookie gets the Secure flag whenever the request arrived over HTTPS —
// derived from the connection itself (x-forwarded-proto, set by Caddy) rather
// than a hand-set env flag that's easy to forget. SECURE_COOKIES=1 can still
// force it on. This is correct in prod (HTTPS) and still works on local http.
function isSecure(c: Context): boolean {
  if (config.secureCookies) return true;
  return (c.req.header("x-forwarded-proto") || "").split(",")[0]!.trim().toLowerCase() === "https";
}

export function createSession(c: Context): void {
  const now = Date.now();
  sweep(now);
  const id = randomBytes(32).toString("base64url");
  sessions.set(id, { createdAt: now, expires: now + config.sessionTtlHours * 3_600_000 });

  setCookie(c, COOKIE_NAME, id, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Strict",
    path: "/",
    maxAge: config.sessionTtlHours * 3600,
  });
}

export function isValidSession(c: Context): boolean {
  const id = getCookie(c, COOKIE_NAME);
  if (!id) return false;
  const s = sessions.get(id);
  if (!s) return false;
  if (Date.now() >= s.expires) {
    sessions.delete(id);
    return false;
  }
  return true;
}

export function destroySession(c: Context): void {
  const id = getCookie(c, COOKIE_NAME);
  if (id) sessions.delete(id);
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}

// Constant-time string equality (used by the login verifier).
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
