// Wire-protocol parsing/validation. The hub must never throw on bad input.

import { test, expect, describe } from "bun:test";
import { parseAgentMessage, helloFrame, statusFrame } from "./protocol.ts";
import type { StatusSnapshot } from "../status.ts";

describe("parseAgentMessage", () => {
  test("parses a valid hello", () => {
    const m = parseAgentMessage(helloFrame({ token: "t", agentId: "abcd1234efgh", hostname: "web-1", version: "1.0.0" }));
    expect(m?.type).toBe("hello");
    if (m?.type === "hello") { expect(m.data.agentId).toBe("abcd1234efgh"); expect(m.data.hostname).toBe("web-1"); }
  });

  test("parses a valid status", () => {
    const m = parseAgentMessage(statusFrame({ host: { hostname: "x" } } as unknown as StatusSnapshot));
    expect(m?.type).toBe("status");
  });

  test("rejects junk, bad JSON, and unknown types", () => {
    expect(parseAgentMessage("not json")).toBeNull();
    expect(parseAgentMessage(JSON.stringify({ type: "nope" }))).toBeNull();
    expect(parseAgentMessage(JSON.stringify({ type: "hello" }))).toBeNull(); // missing fields
    expect(parseAgentMessage(JSON.stringify({ type: "hello", token: "t", agentId: "short", hostname: "h" }))).toBeNull(); // agentId too short
  });
});
