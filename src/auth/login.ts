// Login verification + brute-force lockout.
//
// A login needs BOTH the password (something you know) and a valid TOTP code
// (something you have). Password is checked with argon2id; TOTP per RFC 6238.
// Repeated failures from an IP trigger an escalating lockout so the 6-digit
// second factor can't be ground down.

import { config, authConfigured } from "../config.ts";
import { matchTotpCounter } from "./totp.ts";

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// Global backstop: independent of per-client identity, so even an attacker who
// can vary their source (rotated IPs / spoofed headers behind a misconfigured
// proxy) can't get unbounded TOTP guesses. Generous enough not to trip a real
// operator's fat-fingering, low enough to cap brute force.
const GLOBAL_MAX_FAILURES = 100;
const globalWindow = { count: 0, firstAt: 0 };

interface Attempts {
  count: number;
  firstAt: number;
  lockedUntil: number;
}
const byIp = new Map<string, Attempts>();

// One-time-use TOTP: matched counters consumed by a SUCCESSFUL login, kept just
// long enough to cover the ±1 validation window (~90s) so a captured code can't
// be replayed. Keyed by `${secret}:${counter}`.
const usedTotp = new Map<string, number>(); // key → expiry epoch ms
const TOTP_REPLAY_TTL_MS = 2 * 60 * 1000;

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

  if (now - globalWindow.firstAt > LOCKOUT_MS) { globalWindow.count = 0; globalWindow.firstAt = now; }
  globalWindow.count++;
}

function globalLocked(): boolean {
  if (Date.now() - globalWindow.firstAt > LOCKOUT_MS) return false;
  return globalWindow.count >= GLOBAL_MAX_FAILURES;
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
  if (globalLocked()) {
    return { ok: false, status: 429, error: "too many attempts — locked out", retryAfterSec: Math.ceil(LOCKOUT_MS / 1000) };
  }

  const passOk = await Bun.password.verify(password || "", config.passwordHash).catch(() => false);
  const matchedCounter = matchTotpCounter(config.totpSecret, totp || "");
  const totpOk = matchedCounter !== null;

  // One-time use: a code already consumed by a prior successful login is treated
  // as invalid (no oracle — same path/message as any other bad credential).
  const now = Date.now();
  for (const [k, exp] of usedTotp) if (exp <= now) usedTotp.delete(k); // prune
  const totpKey = matchedCounter !== null ? `${config.totpSecret}:${matchedCounter}` : "";
  const replayed = totpKey !== "" && usedTotp.has(totpKey);

  if (passOk && totpOk && !replayed) {
    usedTotp.set(totpKey, now + TOTP_REPLAY_TTL_MS);
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
