// The Agent seam must preserve the safety contract: arm state toggles, and a
// mutation is refused (DISARMED) unless the box is armed. This guards the
// refactor that routes the controller through Agent instead of calling the
// tool/arm modules directly.

import { test, expect, describe } from "bun:test";
import { LocalAgent } from "./agent.ts";

describe("LocalAgent", () => {
  const agent = new LocalAgent();

  test("arm switch toggles and reports state", () => {
    expect(agent.setArmed(true).armed).toBe(true);
    expect(agent.isArmed()).toBe(true);
    expect(agent.setArmed(false)).toEqual({ armed: false, expiresInSec: 0 });
    expect(agent.isArmed()).toBe(false);
  });

  test("invoke refuses a mutation while disarmed (allowMutations=false)", async () => {
    const r = await agent.invoke("pm2_action", { action: "restart", name: "api" }, false);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("DISARMED");
  });

  test("invoke classifies a read-only call as non-mutating (not DISARMED-gated)", async () => {
    // run_shell with a forbidden command is rejected by the allowlist, NOT the
    // arm gate — so even disarmed it returns a rejection, not the DISARMED notice.
    const r = await agent.invoke("run_shell", { command: "rm -rf /" }, false);
    expect(r.isError).toBe(true);
    expect(r.content).not.toContain("DISARMED");
  });
});
