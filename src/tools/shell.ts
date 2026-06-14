// run_shell: a strict, read-only command whitelist.
//
// Design: we tokenise the requested command ourselves (no shell), reject any
// shell metacharacters outright, then validate the base command + arguments
// against a per-command policy. Only observational commands are allowed —
// nothing here can mutate the system, write files, or fetch from the network.

import { exec, type ExecResult } from "./exec.ts";
import { config } from "../config.ts";

// Characters that would imply shell features. Their presence is an instant
// rejection — we want plain `cmd arg arg`, nothing else.
const FORBIDDEN = /[;&|`$><\\!{}()\n\r#]|\.\./;

// Directory roots cat/tail-style reads are confined to.
const READABLE_ROOTS = ["/var/log/", ...config.extraLogPaths.map((p) => p.replace(/\/?$/, "/"))];

// /proc is NOT opened wholesale — that would expose /proc/<pid>/environ (which
// leaks this process's AUTH_TOKEN, DB password and Claude token), cmdline, maps,
// etc. Only these specific, secret-free diagnostic files are readable.
const PROC_ALLOWED = new Set([
  "/proc/loadavg", "/proc/meminfo", "/proc/cpuinfo", "/proc/uptime",
  "/proc/stat", "/proc/vmstat", "/proc/version", "/proc/mounts",
  "/proc/diskstats", "/proc/swaps", "/proc/net/dev", "/proc/net/snmp",
]);

type ArgValidator = (args: string[]) => string | null; // returns error message or null if ok

// Each allowed command maps to: how to invoke it and how to validate args.
const POLICY: Record<string, ArgValidator> = {
  df: onlyFlags(["-h", "-H", "-T", "-i", "--total"]),
  free: onlyFlags(["-h", "-m", "-g", "-w", "-t"]),
  uptime: onlyFlags(["-p", "-s"]),
  uname: onlyFlags(["-a", "-r", "-s", "-n", "-m", "-o", "-v", "-p"]),
  date: onlyFlags(["-u", "-R", "--utc", "-Iseconds", "-Iminutes"]),
  hostname: onlyFlags(["-f", "-i", "-I", "-s"]),
  whoami: onlyFlags([]),

  // process / network inspection
  ps: onlyFlags(["aux", "-aux", "-ef", "-e", "-f", "-A", "-o", "--sort", "comm,pcpu,pmem", "-", "pid,ppid,user,%cpu,%mem,cmd"]),
  ss: onlyFlags(["-t", "-u", "-l", "-n", "-p", "-tlnp", "-tulnp", "-tlpn", "-anp", "-s"]),
  top: (args) => {
    // Force a single non-interactive snapshot.
    if (args.length === 0) return "top must be run with -bn1 (batch snapshot)";
    const allowed = new Set(["-b", "-n", "1", "-bn1", "-w", "512", "-c", "-o", "%CPU"]);
    for (const a of args) if (!allowed.has(a)) return `top: argument not allowed: ${a}`;
    if (!args.includes("-bn1") && !(args.includes("-b") && args.includes("-n"))) {
      return "top must include -bn1 (or -b -n 1)";
    }
    return null;
  },

  // file reads, confined to log/diagnostic roots
  cat: pathReader,
  head: pathReaderWithFlags(["-n", "-c"]),
  tail: pathReaderWithFlags(["-n", "-c", "-f"]), // -f is stripped below for safety

  // systemctl: STATUS ONLY. Mutations go through service_action. `show` is
  // excluded because it can print a unit's Environment= secrets.
  systemctl: (args) => {
    const sub = args[0];
    if (sub !== "status" && sub !== "list-units" && sub !== "is-active" && sub !== "is-enabled") {
      return "run_shell only permits read-only systemctl (status/is-active/is-enabled/list-units)";
    }
    return null;
  },

  journalctl: (args) => {
    // Read-only AND tightly bounded. The old deny-list only checked flag NAMES,
    // so positional MATCH expressions (_SYSTEMD_UNIT=…, _UID=0, /usr/bin/sudo) and
    // a missing -u dumped the entire merged system journal (secrets included).
    // Now: every value is validated and a managed-unit -u filter is required.
    const boolFlags = new Set(["--no-pager", "-e", "-x", "-b", "-r"]);
    const valueFlags = new Set(["-u", "-n", "--since", "-p"]);
    const units = new Set(
      [...config.managedServices, ...config.monitoredUnits].flatMap((u) => [u, `${u}.service`]),
    );
    let hasUnit = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (!a.startsWith("-")) return `journalctl: positional/match arguments are not allowed: ${a}`;
      if (boolFlags.has(a)) continue;
      if (!valueFlags.has(a)) return `journalctl: flag not allowed: ${a}`;
      const val = args[++i];
      if (val === undefined || val.startsWith("-")) return `journalctl: ${a} requires a value`;
      if (a === "-u") {
        if (!units.has(val)) return `journalctl: unit not allowed: ${val} (managed units only)`;
        hasUnit = true;
      } else if (a === "-n") {
        if (!/^\d{1,4}$/.test(val)) return `journalctl: -n requires a number (max 9999): ${val}`;
      } else if (a === "-p") {
        if (!/^[a-z0-9]+$/i.test(val)) return `journalctl: invalid -p value: ${val}`;
      } else if (a === "--since") {
        // simple time tokens only — no paths or match expressions
        if (/[/=]/.test(val)) return `journalctl: invalid --since value: ${val}`;
      }
    }
    if (!hasUnit) return "journalctl requires -u <managed-unit> (whole-journal reads are not permitted)";
    return null;
  },
};

function onlyFlags(allowed: string[]): ArgValidator {
  const set = new Set(allowed);
  return (args) => {
    for (const a of args) {
      // allow numeric args for things like `-n 1`
      if (/^\d+$/.test(a)) continue;
      if (!set.has(a)) return `argument not allowed: ${a}`;
    }
    return null;
  };
}

function isReadablePath(p: string): boolean {
  if (!p.startsWith("/")) return false;
  if (p.includes("..")) return false;
  // /proc only via the explicit safe-file allowlist (blocks /proc/<pid>/environ etc.)
  if (p.startsWith("/proc/")) return PROC_ALLOWED.has(p);
  return READABLE_ROOTS.some((root) => p.startsWith(root));
}

function pathReader(args: string[]): string | null {
  if (args.length === 0) return "no path given";
  for (const a of args) {
    if (a.startsWith("-")) return `flags not allowed for file read: ${a}`;
    if (!isReadablePath(a)) return `path not readable (allowed roots: ${READABLE_ROOTS.join(", ")}): ${a}`;
  }
  return null;
}

function pathReaderWithFlags(flags: string[]): ArgValidator {
  const flagSet = new Set(flags);
  return (args) => {
    const paths: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a.startsWith("-")) {
        if (!flagSet.has(a)) return `flag not allowed: ${a}`;
        if (a === "-n" || a === "-c") i++; // skip the numeric value
        continue;
      }
      paths.push(a);
    }
    return pathReader(paths);
  };
}

export interface ShellOutcome extends ExecResult {
  rejected?: string;
}

export async function runShell(command: string): Promise<ShellOutcome> {
  const trimmed = command.trim();

  if (!trimmed) {
    return reject(command, "empty command");
  }
  if (FORBIDDEN.test(trimmed)) {
    return reject(command, "command contains forbidden shell metacharacters (; & | ` $ > < \\ etc.)");
  }

  const tokens = trimmed.split(/\s+/);
  let base = tokens[0]!;

  // tolerate a leading `sudo` only by rejecting it explicitly with a clear message
  if (base === "sudo") {
    return reject(command, "sudo is not permitted via run_shell; use service_action for privileged actions");
  }

  const validator = POLICY[base];
  if (!validator) {
    return reject(
      command,
      `command not in allowlist: '${base}'. Allowed: ${Object.keys(POLICY).join(", ")}`,
    );
  }

  let args = tokens.slice(1);

  // Strip dangerous follow-mode flags that would never terminate.
  if (base === "tail") args = args.filter((a) => a !== "-f");

  const argErr = validator(args);
  if (argErr) return reject(command, `${base}: ${argErr}`);

  return exec([base, ...args], { timeoutMs: 12_000 });
}

function reject(command: string, reason: string): ShellOutcome {
  return {
    ok: false,
    code: null,
    stdout: "",
    stderr: "",
    command,
    timedOut: false,
    rejected: reason,
  };
}
