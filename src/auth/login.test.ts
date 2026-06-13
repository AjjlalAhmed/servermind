// Tests for login verification + brute-force lockout.
//
// The auth secrets are configured in src/test-preload.ts (loaded via bunfig.toml
// before any module), because config.ts reads them once at import time.

import { test, expect, describe } from "bun:test";
import { verifyLogin } from "./login.ts";
import { totp } from "./totp.ts";
import { TEST_PASSWORD as PASSWORD, TEST_TOTP_SECRET as B32_SECRET } from "../test-preload.ts";

describe("verifyLogin", () => {
  test("accepts correct password + current TOTP", async () => {
    const r = await verifyLogin("10.0.0.1", PASSWORD, totp(B32_SECRET));
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });

  test("rejects a wrong password even with a valid TOTP", async () => {
    const r = await verifyLogin("10.0.0.2", "wrong", totp(B32_SECRET));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  test("rejects a valid password with a wrong TOTP", async () => {
    const r = await verifyLogin("10.0.0.3", PASSWORD, "000000");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  test("locks out an IP after repeated failures", async () => {
    const ip = "10.0.0.99";
    for (let i = 0; i < 4; i++) {
      const r = await verifyLogin(ip, "wrong", "");
      expect(r.status).toBe(401);
    }
    // 5th failure trips the lockout (returns 401 but now with a retry hint)…
    const fifth = await verifyLogin(ip, "wrong", "");
    expect(fifth.status).toBe(401);
    expect(fifth.retryAfterSec).toBeGreaterThan(0);
    // …and further attempts are refused outright, even with correct credentials.
    const sixth = await verifyLogin(ip, PASSWORD, totp(B32_SECRET));
    expect(sixth.status).toBe(429);
    expect(sixth.ok).toBe(false);
  });
});
