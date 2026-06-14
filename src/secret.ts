// Authenticated symmetric encryption for secrets at rest (AES-256-GCM).
//
// Settings secrets (SMTP password, API keys) are stored encrypted in
// data/settings.json; the key (SETTINGS_KEY) lives in .env — a separate file —
// so neither the ciphertext file nor the key alone is enough. GCM gives us
// tamper detection (a modified blob fails to decrypt rather than yielding junk).

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const PREFIX = "enc:v1:"; // marks an encrypted value; lets us tolerate legacy plaintext

function key(): Buffer {
  const raw = process.env.SETTINGS_KEY || "";
  if (!raw) throw new Error("SETTINGS_KEY is not set");
  const b = Buffer.from(raw, "base64");
  return b.length === 32 ? b : createHash("sha256").update(raw).digest(); // accept any passphrase
}

export function hasKey(): boolean {
  return !!(process.env.SETTINGS_KEY && process.env.SETTINGS_KEY.trim());
}

export function generateKey(): string {
  return randomBytes(32).toString("base64");
}

export function encryptSecret(plain: string): string {
  if (!plain) return "";
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function decryptSecret(stored: string): string {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX)) return stored; // tolerate a value that predates encryption
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
