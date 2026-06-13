// Login verification + brute-force lockout.
//
// A login needs BOTH the password (something you know) and a valid TOTP code
// (something you have). Password is checked with argon2id; TOTP per RFC 6238.
// Repeated failures from an IP trigger an escalating lockout so the 6-digit
// second factor can't be ground down.

import { config, authConfigured } from "../config.ts";
import { verifyTotp } from "./totp.ts";

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

interface Attempts {
  count: number;
  firstAt: number;
  lockedUntil: number;
}
const byIp = new Map<string, Attempts>();

export interface LoginResult {
  ok: boolean;
  status: number;
  error?: string;
  retryAfterSec?: number;
}

export function lockState(ip: string): { locked: boolean; retryAfterSec: number } {
  const a = byIp.get(ip);
  if (!a) return { locked: false, retryAfterSec: 0 };
  const now = Date.now();
  if (a.lockedUntil > now) {
    return { locked: true, retryAfterSec: Math.ceil((a.lockedUntil - now) / 1000) };
  }
  return { locked: false, retryAfterSec: 0 };
}

function recordFailure(ip: string) {
  const now = Date.now();
  let a = byIp.get(ip);
  if (!a || now - a.firstAt > LOCKOUT_MS) a = { count: 0, firstAt: now, lockedUntil: 0 };
  a.count++;
  if (a.count >= MAX_FAILURES) a.lockedUntil = now + LOCKOUT_MS;
  byIp.set(ip, a);
}

function clearFailures(ip: string) {
  byIp.delete(ip);
}

// Verify a login. Always does the same work regardless of which factor is
// wrong (and never reveals which) to avoid an oracle.
export async function verifyLogin(ip: string, password: string, totp: string): Promise<LoginResult> {
  if (!authConfigured()) {
    return { ok: false, status: 503, error: "auth not configured — run `bun run setup-auth` on the server" };
  }

  const lock = lockState(ip);
  if (lock.locked) {
    return { ok: false, status: 429, error: "too many attempts — locked out", retryAfterSec: lock.retryAfterSec };
  }

  const passOk = await Bun.password.verify(password || "", config.passwordHash).catch(() => false);
  const totpOk = verifyTotp(config.totpSecret, totp || "");

  if (passOk && totpOk) {
    clearFailures(ip);
    return { ok: true, status: 200 };
  }

  recordFailure(ip);
  const after = lockState(ip);
  return {
    ok: false,
    status: 401,
    error: "invalid credentials",
    retryAfterSec: after.locked ? after.retryAfterSec : undefined,
  };
}
