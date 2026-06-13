import type { Context, Next } from "hono";
import { isValidSession } from "./auth/session.ts";

// Hono middleware: every protected route requires a valid session cookie,
// established by POST /auth/login (password + TOTP). No static token exists.
export async function requireAuth(c: Context, next: Next) {
  if (!isValidSession(c)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
}
