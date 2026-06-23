// service_action: manage systemd units. `status` is read-only; the rest are
// privileged mutations gated behind sudo (configure NOPASSWD for the
// servermind user — see README) and require chat confirmation first.

import { exec } from "./exec.ts";
import { config } from "../config.ts";

export type ServiceAction = "status" | "start" | "stop" | "restart" | "enable";

const SERVICE_RE = /^[A-Za-z0-9_.@-]{1,64}$/;

// Units this assistant is allowed to touch at all (config-driven via
// MANAGED_SERVICES). Keeps a stray "stop ssh" from locking everyone out.
const KNOWN_SERVICES = new Set(config.managedServices);

const MUTATING: ServiceAction[] = ["start", "stop", "restart", "enable"];

export interface ServiceOutcome {
  ok: boolean;
  service: string;
  action: ServiceAction;
  output: string;
  privileged: boolean;
  error?: string;
}

export async function serviceAction(
  service: string,
  action: ServiceAction,
): Promise<ServiceOutcome> {
  const svc = service.replace(/\.service$/, "");

  if (!SERVICE_RE.test(svc)) {
    return fail(svc, action, `invalid service name: ${service}`);
  }

  const privileged = MUTATING.includes(action);

  // status is read-only and safe for ANY unit — diagnosing a problem (e.g. a
  // custom worker that died) shouldn't require pre-registering it in
  // MANAGED_SERVICES. Only MUTATIONS stay locked to the managed allowlist, so a
  // stray "stop ssh" still can't lock everyone out.
  if (action === "status") {
    const r = await exec(["systemctl", "status", svc, "--no-pager", "-l"], {
      timeoutMs: 10_000,
    });
    // systemctl status exits non-zero for inactive units — that's still a
    // valid, useful answer, so don't treat it as a hard failure.
    return {
      ok: true,
      service: svc,
      action,
      privileged: false,
      output: r.stdout || r.stderr,
    };
  }

  if (!KNOWN_SERVICES.has(svc)) {
    return fail(
      svc,
      action,
      `service '${svc}' is not in the managed allowlist (${[...KNOWN_SERVICES].join(", ")}) — only 'status' is available for unmanaged units`,
    );
  }

  // Privileged path. Requires that the running user can sudo systemctl
  // without a password for these units.
  const r = await exec(["sudo", "-n", "systemctl", action, svc], { timeoutMs: 25_000 });
  if (!r.ok && /a password is required|sudo:/.test(r.stderr)) {
    return fail(
      svc,
      action,
      "sudo requires a password — configure NOPASSWD for systemctl (see README) to allow privileged service actions",
      true,
    );
  }

  // Follow up with a fresh status line so the model can confirm the result.
  const after = await exec(["systemctl", "is-active", svc], { timeoutMs: 8_000 });
  return {
    ok: r.ok,
    service: svc,
    action,
    privileged,
    output: `${r.stdout}${r.stderr}\n[is-active] ${after.stdout.trim()}`.trim(),
    error: r.ok ? undefined : `systemctl ${action} ${svc} failed`,
  };
}

function fail(
  service: string,
  action: ServiceAction,
  error: string,
  privileged = false,
): ServiceOutcome {
  return { ok: false, service, action, output: "", privileged, error };
}
