// Wire-protocol parsing/validation. The hub must never throw on bad input.

import { test, expect, describe } from "bun:test";
import { parseAgentMessage, helloFrame, statusFrame, profileFrame } from "./protocol.ts";
import type { StatusSnapshot } from "../status.ts";
import type { ServerProfile } from "../notify/profile.ts";

describe("parseAgentMessage", () => {
  test("parses a valid hello", () => {
    const m = parseAgentMessage(helloFrame({ token: "t", agentId: "abcd1234efgh", hostname: "web-1", version: "1.0.0" }));
    expect(m?.type).toBe("hello");
    if (m?.type === "hello") { expect(m.data.agentId).toBe("abcd1234efgh"); expect(m.data.hostname).toBe("web-1"); }
  });

  test("parses a hello carrying advertised custom tools", () => {
    const tools = [
      { name: "active_orders", description: "count active orders", takesQuery: false },
      { name: "orders_db", description: "query the orders db", takesQuery: true },
    ];
    const m = parseAgentMessage(helloFrame({ token: "t", agentId: "abcd1234efgh", hostname: "web-1", tools }));
    expect(m?.type).toBe("hello");
    if (m?.type === "hello") {
      expect(m.data.tools).toHaveLength(2);
      expect(m.data.tools?.find((t) => t.name === "orders_db")?.takesQuery).toBe(true);
    }
  });

  test("rejects a hello whose advertised tool has a bad name", () => {
    const bad = helloFrame({ token: "t", agentId: "abcd1234efgh", hostname: "web-1", tools: [{ name: "Bad Name", description: "x" } as any] });
    expect(parseAgentMessage(bad)).toBeNull();
  });

  test("parses a valid status", () => {
    const m = parseAgentMessage(statusFrame({ host: { hostname: "x" } } as unknown as StatusSnapshot));
    expect(m?.type).toBe("status");
  });

  test("parses a profile frame and carries the payload through", () => {
    const prof = { host: { hostname: "web-1" }, services: { failed: ["worker.service"] }, notes: ["x"] } as unknown as ServerProfile;
    const m = parseAgentMessage(profileFrame(prof));
    expect(m?.type).toBe("profile");
    if (m?.type === "profile") expect((m.profile as any).services.failed).toEqual(["worker.service"]);
  });

  test("rejects junk, bad JSON, and unknown types", () => {
    expect(parseAgentMessage("not json")).toBeNull();
    expect(parseAgentMessage(JSON.stringify({ type: "nope" }))).toBeNull();
    expect(parseAgentMessage(JSON.stringify({ type: "hello" }))).toBeNull(); // missing fields
    expect(parseAgentMessage(JSON.stringify({ type: "hello", token: "t", agentId: "short", hostname: "h" }))).toBeNull(); // agentId too short
  });
});
