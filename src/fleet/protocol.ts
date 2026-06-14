// Wire protocol between an agent and the controller hub. One persistent
// WebSocket per agent. Phase 1 is agent → controller only (enroll + status);
// controller → agent commands (invoke/arm) arrive in Phase 2.

import { z } from "zod";
import type { StatusSnapshot } from "../status.ts";

export const HelloSchema = z.object({
  type: z.literal("hello"),
  token: z.string().max(512),
  agentId: z.string().min(8).max(128),
  hostname: z.string().max(255),
  version: z.string().max(32).optional(),
});
export type Hello = z.infer<typeof HelloSchema>;

const StatusSchema = z.object({
  type: z.literal("status"),
  // The snapshot is validated structurally by the agent that produced it; the
  // hub treats it as opaque JSON it stores and renders.
  snapshot: z.unknown(),
});

export type AgentMessage =
  | { type: "hello"; data: Hello }
  | { type: "status"; snapshot: StatusSnapshot };

// Parse + validate a raw frame from an agent. Returns null on anything invalid
// so the hub can simply ignore/close — never throws on bad input.
export function parseAgentMessage(raw: string): AgentMessage | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  const t = (obj as { type?: unknown })?.type;
  if (t === "hello") {
    const p = HelloSchema.safeParse(obj);
    return p.success ? { type: "hello", data: p.data } : null;
  }
  if (t === "status") {
    const p = StatusSchema.safeParse(obj);
    return p.success ? { type: "status", snapshot: p.data.snapshot as StatusSnapshot } : null;
  }
  return null;
}

export const helloFrame = (h: Omit<Hello, "type">): string => JSON.stringify({ type: "hello", ...h });
export const statusFrame = (snapshot: StatusSnapshot): string => JSON.stringify({ type: "status", snapshot });
