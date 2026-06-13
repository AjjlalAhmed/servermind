// RFC 6238 TOTP (and RFC 4226 HOTP) over HMAC-SHA1 — the algorithm every
// authenticator app (Google Authenticator, Authy, 1Password, etc.) implements.
// Self-contained on Node crypto; verified against the RFC test vectors in
// totp.test.ts so we don't depend on a churny third-party lib.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const STEP_SECONDS = 30;
const DIGITS = 6;

// ── base32 (RFC 4648, no padding) — the encoding authenticator apps expect ──
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ── HOTP / TOTP core ────────────────────────────────────────────────────────
function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter (high 32 bits supported for far-future times)
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

export function totp(secretBase32: string, atMs = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  return hotp(base32Decode(secretBase32), counter);
}

// Verify a user-supplied code, tolerating ±`window` steps of clock drift.
// Constant-time compare so we don't leak which step matched.
export function verifyTotp(secretBase32: string, token: string, window = 1, atMs = Date.now()): boolean {
  const cleaned = (token || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  let ok = false;
  for (let i = -window; i <= window; i++) {
    const candidate = hotp(secret, counter + i);
    // compare every candidate (no early return) to keep timing uniform
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(cleaned))) ok = true;
  }
  return ok;
}

// ── enrollment helpers ──────────────────────────────────────────────────────
export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function otpauthURL(secretBase32: string, label: string, issuer = "ServerMind"): string {
  const l = encodeURIComponent(`${issuer}:${label}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${l}?${params.toString()}`;
}

// expose for the test
export const _internal = { hotp };
