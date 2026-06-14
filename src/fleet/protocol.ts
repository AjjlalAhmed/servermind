// Wire protocol between an agent and the controller hub. One persistent
// WebSocket per agent. Phase 1 is agent → controller only (enroll + status);
// controller → agent commands (invoke/arm) arrive in Phase 2.

import { z } from "zod";
import type { StatusSnapshot } from "../status.ts";

export const HelloSchema = z.object({
  type: z.literal("hello"),
  token: z.string().max(512),
  // Constrain identity to a safe charset so it can't carry markup/quotes that
  // would break out of HTML attributes when rendered in the controller's Fleet
  // view (defence-in-depth alongside escaping on the client).
  agentId: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  hostname: z.string().min(1).max(255).regex(/^[A-Za-z0-9._-]+$/),
  version: z.string().max(32).optional(),
});
export type Hello = z.infer<typeof HelloSchema>;

const StatusSchema = z.object({
  type: z.literal("status"),
  // The snapshot is validated structurally by the agent that produced it; the
  // hub treats it as opaque JSON it stores and renders.
  snapshot: z.unknown(),
});

const ResultSchema = z.object({
  type: z.literal("result"),
  reqId: z.string().max(64),
  content: z.string(),
  isError: z.boolean(),
});

export type AgentMessage =
  | { type: "hello"; data: Hello }
  | { type: "status"; snapshot: StatusSnapshot }
  | { type: "result"; reqId: string; content: string; isError: boolean };

// Parse + validate a raw frame FROM an agent (hub side). Returns null on
// anything invalid so the hub can simply ignore/close — never throws.
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
  if (t === "result") {
    const p = ResultSchema.safeParse(obj);
    return p.success ? { type: "result", reqId: p.data.reqId, content: p.data.content, isError: p.data.isError } : null;
  }
  return null;
}

// ── controller → agent commands (agent side parses these) ────────────────────
const InvokeSchema = z.object({
  type: z.literal("invoke"),
  reqId: z.string().max(64),
  name: z.string().max(128),
  input: z.unknown(),
});
const ArmSchema = z.object({ type: z.literal("arm"), on: z.boolean() });

export type ControllerMessage =
  | { type: "invoke"; reqId: string; name: string; input: unknown }
  | { type: "arm"; on: boolean };

export function parseControllerMessage(raw: string): ControllerMessage | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  const t = (obj as { type?: unknown })?.type;
  if (t === "invoke") {
    const p = InvokeSchema.safeParse(obj);
    return p.success ? { type: "invoke", reqId: p.data.reqId, name: p.data.name, input: p.data.input } : null;
  }
  if (t === "arm") {
    const p = ArmSchema.safeParse(obj);
    return p.success ? { type: "arm", on: p.data.on } : null;
  }
  return null;
}

export const helloFrame = (h: Omit<Hello, "type">): string => JSON.stringify({ type: "hello", ...h });
export const statusFrame = (snapshot: StatusSnapshot): string => JSON.stringify({ type: "status", snapshot });
export const resultFrame = (reqId: string, content: string, isError: boolean): string => JSON.stringify({ type: "result", reqId, content, isError });
export const invokeFrame = (reqId: string, name: string, input: unknown): string => JSON.stringify({ type: "invoke", reqId, name, input });
export const armFrame = (on: boolean): string => JSON.stringify({ type: "arm", on });
