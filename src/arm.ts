// Server-side "arm mutations" state.
//
// Previously the UI sent allowMutations in each /chat body, so anything able to
// craft a request (e.g. compromised page JS) could arm + act in one shot. Now
// arming is explicit server state set via the authenticated POST /auth/arm, and
// /chat reads THIS — a single request can no longer both arm and trigger a
// mutation. It also auto-expires so the window is never left open.

const ARM_TTL_MS = 10 * 60 * 1000; // auto-disarm after 10 minutes
let armedUntil = 0;

export function setArmed(on: boolean): boolean {
  armedUntil = on ? Date.now() + ARM_TTL_MS : 0;
  return isArmed();
}

export function isArmed(): boolean {
  return Date.now() < armedUntil;
}

// Absolute epoch (ms) the arm expires at, or 0 when disarmed. Passed into the
// Claude MCP subprocess so it re-checks the TTL on every tool call instead of
// freezing the arm state at spawn time.
export function armedUntilMs(): number {
  return armedUntil;
}

export function armState() {
  const armed = isArmed();
  return { armed, expiresInSec: armed ? Math.ceil((armedUntil - Date.now()) / 1000) : 0 };
}
