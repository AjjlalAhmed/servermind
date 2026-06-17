// RemoteAgent — an Agent (same interface as LocalAgent) whose box is a different
// machine. `invoke`/`setArmed` travel over the WebSocket to that agent, which
// runs them through ITS OWN allowlist + arm switch. The controller can only ask;
// it cannot bypass the agent's gate.

import type { Agent, ArmState } from "../agent.ts";
import type { StatusSnapshot } from "../status.ts";
import type { DispatchResult } from "../tools/index.ts";
import { sendInvoke, sendArm, fleetRegistry } from "./hub.ts";

const ARM_TTL_MS = 10 * 60 * 1000;
// Controller-side view of which agents the operator has armed (for display).
// The agent itself remains authoritative — it re-checks its own arm on every invoke.
const armedUntil = new Map<string, number>();

// Controller-side view of whether an agent is currently armed (for the UI).
export function isAgentArmed(agentId: string): boolean {
  return Date.now() < (armedUntil.get(agentId) ?? 0);
}

export class RemoteAgent implements Agent {
  constructor(private readonly agentId: string) {}

  // The agent id, so the controller can look up this box's advertised tools.
  get id(): string { return this.agentId; }

  async status(): Promise<StatusSnapshot> {
    const s = fleetRegistry()?.list().find((x) => x.id === this.agentId)?.status;
    if (!s) throw new Error(`no status yet for agent ${this.agentId}`);
    return s;
  }

  // The local `allowMutations` is irrelevant for a remote box — the agent decides
  // using its own arm state. We deliberately don't forward it.
  invoke(name: string, input: unknown, _allowMutations: boolean): Promise<DispatchResult> {
    return sendInvoke(this.agentId, name, input);
  }

  isArmed(): boolean {
    return Date.now() < (armedUntil.get(this.agentId) ?? 0);
  }

  setArmed(on: boolean): ArmState {
    const sent = sendArm(this.agentId, on);
    armedUntil.set(this.agentId, on && sent ? Date.now() + ARM_TTL_MS : 0);
    return { armed: this.isArmed(), expiresInSec: on && sent ? ARM_TTL_MS / 1000 : 0 };
  }
}
