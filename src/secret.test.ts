// Tests for at-rest secret encryption (AES-256-GCM).

import { test, expect, describe } from "bun:test";
import { encryptSecret, decryptSecret, generateKey } from "./secret.ts";

describe("secret encryption", () => {
  test("round-trips and ciphertext never contains the plaintext", () => {
    process.env.SETTINGS_KEY = generateKey();
    const plain = "gsk_super_secret_api_key_9f3a";
    const enc = encryptSecret(plain);
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(enc).not.toContain(plain);
    expect(decryptSecret(enc)).toBe(plain);
  });

  test("empty stays empty; pre-encryption plaintext is tolerated", () => {
    process.env.SETTINGS_KEY = generateKey();
    expect(encryptSecret("")).toBe("");
    expect(decryptSecret("")).toBe("");
    expect(decryptSecret("legacy-plaintext-value")).toBe("legacy-plaintext-value");
  });

  test("tampering with the ciphertext is detected (auth failure)", () => {
    process.env.SETTINGS_KEY = generateKey();
    const enc = encryptSecret("do-not-tamper");
    const tampered = enc.slice(0, -6) + "AAAAAA";
    expect(() => decryptSecret(tampered)).toThrow();
  });

  test("a different key cannot decrypt", () => {
    process.env.SETTINGS_KEY = generateKey();
    const enc = encryptSecret("cross-key");
    process.env.SETTINGS_KEY = generateKey(); // rotate
    expect(() => decryptSecret(enc)).toThrow();
  });
});
