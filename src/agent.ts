// The "agent" is everything that runs ON a managed box: tool invocation (the
// read-only allowlist + the arm gate, via dispatchTool), the status snapshot,
// and the arm switch. The controller (routes, chat) talks to a box ONLY through
// this interface.
//
// Today there is exactly one implementation — LocalAgent, in-process, which is
// byte-for-byte the previous behavior. The multi-server build (see
// ARCHITECTURE.md) adds a RemoteAgent that satisfies the same interface over the
// wire, so the controller's call sites don't change. This file is the seam.
//
// Note: the Claude Code backend executes tools inside its own MCP subprocess
// (src/mcp-server.ts → dispatchTool) — that path is itself a local agent and is
// left as-is here; routing it to remote agents is a later phase.

import { getStatusSnapshot, type StatusSnapshot } from "./status.ts";
import { dispatchTool, isMutatingCall, type DispatchResult } from "./tools/index.ts";
import { isArmed, setArmed, armState } from "./arm.ts";

export interface ArmState {
  armed: boolean;
  expiresInSec: number;
}

export interface Agent {
  /** Point-in-time health snapshot of the box. */
  status(): Promise<StatusSnapshot>;
  /** Run one vetted tool. `allowMutations` reflects this box's arm state. */
  invoke(name: string, input: unknown, allowMutations: boolean): Promise<DispatchResult>;
  /** Is this box currently armed for mutations? */
  isArmed(): boolean;
  /** Flip this box's arm switch; returns the resulting state. */
  setArmed(on: boolean): ArmState;
}

// In-process agent for the box this process runs on. Standalone = this is the
// only agent. It delegates to the existing modules unchanged.
export class LocalAgent implements Agent {
  status(): Promise<StatusSnapshot> {
    return getStatusSnapshot();
  }
  async invoke(name: string, input: unknown, allowMutations: boolean): Promise<DispatchResult> {
    const r = await dispatchTool(name, input, { allowMutations });
    // Single-use arm: a successful mutating action consumes the arm, so the
    // operator must re-arm for the next one. This bounds prompt-injection in
    // tool output to at most ONE mutation per arm window, server-side — the
    // model can't chain "operator already confirmed, now also restart X".
    if (allowMutations && !r.isError && isMutatingCall(name, input)) setArmed(false);
    return r;
  }
  isArmed(): boolean {
    return isArmed();
  }
  setArmed(on: boolean): ArmState {
    setArmed(on);
    return armState();
  }
}

// The agent for the controller's own host. In standalone this is the only one;
// in fleet mode the controller also holds remote agents in a registry.
export const localAgent: Agent = new LocalAgent();
