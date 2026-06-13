import { test, expect } from "bun:test";
import { base32Encode, base32Decode, totp, verifyTotp, _internal } from "./totp.ts";

// The canonical RFC 4226 / 6238 shared secret "12345678901234567890" (ASCII).
const ASCII_SECRET = "12345678901234567890";
const B32_SECRET = base32Encode(Buffer.from(ASCII_SECRET, "ascii"));

test("base32 round-trips", () => {
  const b = Buffer.from("hello world", "utf8");
  expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  // Known vector: "12345678901234567890" -> GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
  expect(B32_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
});

test("HOTP matches RFC 4226 Appendix D vectors", () => {
  const secret = base32Decode(B32_SECRET);
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  for (let c = 0; c < expected.length; c++) {
    expect(_internal.hotp(secret, c)).toBe(expected[c]);
  }
});

test("TOTP matches RFC 6238 time vectors (SHA1, 6 digits)", () => {
  // RFC 6238 lists 8-digit codes; the trailing 6 digits are the 6-digit TOTP.
  const cases: Array<[number, string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ];
  for (const [t, code] of cases) {
    expect(totp(B32_SECRET, t * 1000)).toBe(code);
  }
});

test("verifyTotp accepts the current code and rejects a wrong one", () => {
  const now = 1234567890 * 1000;
  expect(verifyTotp(B32_SECRET, "005924", 1, now)).toBe(true);
  expect(verifyTotp(B32_SECRET, "000000", 1, now)).toBe(false);
  expect(verifyTotp(B32_SECRET, "12345", 1, now)).toBe(false); // wrong length
});

test("verifyTotp tolerates ±1 step drift but not ±2", () => {
  const now = 1234567890 * 1000;
  const prev = totp(B32_SECRET, now - 30_000);
  const next = totp(B32_SECRET, now + 30_000);
  const far = totp(B32_SECRET, now + 90_000);
  expect(verifyTotp(B32_SECRET, prev, 1, now)).toBe(true);
  expect(verifyTotp(B32_SECRET, next, 1, now)).toBe(true);
  expect(verifyTotp(B32_SECRET, far, 1, now)).toBe(false);
});
