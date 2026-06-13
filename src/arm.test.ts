// Tests for the server-side "arm mutations" state machine.

import { test, expect } from "bun:test";
import { setArmed, isArmed, armState } from "./arm.ts";

test("setArmed(true) arms; setArmed(false) disarms", () => {
  setArmed(true);
  expect(isArmed()).toBe(true);
  setArmed(false);
  expect(isArmed()).toBe(false);
});

test("armState reports a bounded expiry while armed, zero while disarmed", () => {
  setArmed(true);
  const on = armState();
  expect(on.armed).toBe(true);
  expect(on.expiresInSec).toBeGreaterThan(0);
  expect(on.expiresInSec).toBeLessThanOrEqual(600); // 10-minute TTL ceiling

  setArmed(false);
  expect(armState()).toEqual({ armed: false, expiresInSec: 0 });
});
