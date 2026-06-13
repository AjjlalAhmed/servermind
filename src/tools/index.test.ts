// Tests for the mutation gate: isMutatingCall classification and the
// server-side refusal in dispatchTool. The refusal path returns BEFORE any
// command executes, so this suite never restarts anything.

import { test, expect, describe } from "bun:test";
import { isMutatingCall, dispatchTool } from "./index.ts";

describe("isMutatingCall classifies actions", () => {
  test("pm2 restart/stop/start are mutating; list/logs are not", () => {
    expect(isMutatingCall("pm2_action", { action: "restart" })).toBe(true);
    expect(isMutatingCall("pm2_action", { action: "stop" })).toBe(true);
    expect(isMutatingCall("pm2_action", { action: "start" })).toBe(true);
    expect(isMutatingCall("pm2_action", { action: "list" })).toBe(false);
    expect(isMutatingCall("pm2_action", { action: "logs" })).toBe(false);
  });

  test("service start/stop/restart/enable are mutating; status is not", () => {
    expect(isMutatingCall("service_action", { action: "restart" })).toBe(true);
    expect(isMutatingCall("service_action", { action: "enable" })).toBe(true);
    expect(isMutatingCall("service_action", { action: "status" })).toBe(false);
  });

  test("read-only tools are never mutating", () => {
    expect(isMutatingCall("run_shell", { command: "df -h" })).toBe(false);
    expect(isMutatingCall("check_port", { port: 80 })).toBe(false);
    expect(isMutatingCall("read_log", { path: "/var/log/syslog" })).toBe(false);
  });

  test("the mcp__servermind__ prefix is stripped before classifying", () => {
    expect(isMutatingCall("mcp__servermind__pm2_action", { action: "restart" })).toBe(true);
    expect(isMutatingCall("mcp__servermind__service_action", { action: "status" })).toBe(false);
  });
});

describe("dispatchTool refuses mutations unless armed", () => {
  test("pm2 restart is DISARMED when allowMutations is false", async () => {
    const r = await dispatchTool("pm2_action", { action: "restart", name: "api" }, { allowMutations: false });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("DISARMED");
  });

  test("pm2 restart is DISARMED when allowMutations is omitted (default deny)", async () => {
    const r = await dispatchTool("pm2_action", { action: "restart" }, {});
    expect(r.isError).toBe(true);
    expect(r.content).toContain("DISARMED");
  });

  test("service restart is DISARMED when not armed", async () => {
    const r = await dispatchTool("service_action", { service: "nginx", action: "restart" }, { allowMutations: false });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("DISARMED");
  });
});
