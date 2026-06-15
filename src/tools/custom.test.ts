// Tests for user-defined custom tools: manifest validation, frozen execution,
// and the arm gate for a mutating command.

import { test, expect, describe, afterAll } from "bun:test";
import { validateCustomTools, setCustomTools, customToolMutating, isCustomTool } from "./custom.ts";
import { dispatchTool, isMutatingCall } from "./index.ts";
import { localAgent } from "../agent.ts";
import { setArmed, isArmed } from "../arm.ts";

// Load a set of manifests into the live registry (throws on invalid input).
function register(manifests: unknown[]) {
  const v = validateCustomTools(manifests);
  if (!v.ok) throw new Error(v.error);
  setCustomTools(v.tools);
  return v.tools;
}

const cmd = (over: object = {}) => ({ kind: "command", name: "say_hi", description: "say hi", argv: ["echo", "hello"], ...over });
const dbq = (over: object = {}) => ({ kind: "db_query", name: "qrows", description: "row count", engine: "mysql", conn: { host: "127.0.0.1", port: 3306, user: "ro", password: "" }, query: "SELECT 1", ...over });
const http = (over: object = {}) => ({ kind: "http_check", name: "hcheck", description: "health", url: "https://example.com/health", ...over });
const file = (over: object = {}) => ({ kind: "read_file", name: "flog", description: "errors", path: "/var/log/syslog", ...over });

afterAll(() => { setCustomTools([]); setArmed(false); }); // don't leak state into other suites

describe("validateCustomTools", () => {
  test("accepts a valid manifest of each kind", () => {
    expect(validateCustomTools([cmd(), dbq(), http(), file()]).ok).toBe(true);
  });

  test("rejects a name that collides with a built-in tool", () => {
    const r = validateCustomTools([cmd({ name: "run_shell" })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("reserved");
  });

  test("rejects duplicate names", () => {
    const r = validateCustomTools([cmd(), cmd()]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("duplicate");
  });

  test("rejects a bad name format", () => {
    expect(validateCustomTools([cmd({ name: "Bad Name" })]).ok).toBe(false);
  });

  test("rejects a non-read-only db_query", () => {
    const r = validateCustomTools([dbq({ query: "DELETE FROM orders" })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("read-only");
  });

  test("rejects a multi-statement db_query (semicolon)", () => {
    expect(validateCustomTools([dbq({ query: "SELECT 1; DROP TABLE x" })]).ok).toBe(false);
  });

  test("rejects a postgres db_query with no database", () => {
    const r = validateCustomTools([dbq({ engine: "postgres", query: "SELECT 1" })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("database");
  });

  test("rejects a non-http(s) URL", () => {
    expect(validateCustomTools([http({ url: "ftp://example.com/x" })]).ok).toBe(false);
  });

  test("rejects mutating on a kind other than command (schema)", () => {
    expect(validateCustomTools([dbq({ mutating: true })]).ok).toBe(false);
  });
});

describe("execution", () => {
  test("a frozen command runs via exec and returns its output", async () => {
    register([cmd()]);
    expect(isCustomTool("say_hi")).toBe(true);
    const r = await dispatchTool("say_hi", {}, { allowMutations: false });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("hello");
  });

  test("a read_file outside the safe roots is rejected at execution", async () => {
    register([file({ path: "/etc/shadow" })]);
    const r = await dispatchTool("flog", {}, { allowMutations: false });
    expect(r.isError).toBe(true);
    expect(r.content.toLowerCase()).toContain("not allowed");
  });
});

describe("arm gate for a mutating command", () => {
  test("isMutatingCall reflects the manifest flag", () => {
    register([cmd({ mutating: true })]);
    expect(customToolMutating("say_hi")).toBe(true);
    expect(isMutatingCall("say_hi", {})).toBe(true);
  });

  test("refused when disarmed, runs when armed", async () => {
    register([cmd({ mutating: true })]);
    const disarmed = await dispatchTool("say_hi", {}, { allowMutations: false });
    expect(disarmed.isError).toBe(true);
    expect(disarmed.content).toContain("DISARMED");

    const armedRun = await dispatchTool("say_hi", {}, { allowMutations: true });
    expect(armedRun.isError).toBe(false);
    expect(armedRun.content).toContain("hello");
  });

  test("single-use: localAgent.invoke auto-disarms after a mutating command", async () => {
    register([cmd({ mutating: true })]);
    setArmed(true);
    const r = await localAgent.invoke("say_hi", {}, true);
    expect(r.isError).toBe(false);
    expect(isArmed()).toBe(false); // arm was consumed
  });
});
