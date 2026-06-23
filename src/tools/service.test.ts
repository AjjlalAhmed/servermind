// service_action: status is read-only and works for ANY unit; mutations stay
// locked to the managed allowlist. These assert the gating, not real systemctl
// output (exec may no-op off-Linux — we only check the allowlist decision).

import { test, expect, describe } from "bun:test";
import { serviceAction } from "./service.ts";

describe("service_action gating", () => {
  test("status works for an unmanaged unit (no allowlist rejection)", async () => {
    const r = await serviceAction("worker-daemon", "status");
    expect(r.action).toBe("status");
    // not rejected with the managed-allowlist error
    expect(r.error ?? "").not.toContain("managed allowlist");
  });

  test("an invalid unit name is rejected", async () => {
    const r = await serviceAction("bad name; rm", "status");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("invalid service name");
  });

  test("a mutation on an unmanaged unit is refused", async () => {
    const r = await serviceAction("worker-daemon", "restart");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("managed allowlist");
  });
});
