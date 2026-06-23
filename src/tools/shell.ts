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

// ── shared shapes for the network/mail diagnostics below ──────────────────────
// DNS record types we permit. Zone transfers (axfr/ixfr) are deliberately absent.
const DNS_RECORD_TYPES = new Set([
  "a", "aaaa", "mx", "txt", "ns", "cname", "soa", "ptr", "srv", "caa",
  "any", "spf", "naptr", "ds", "dnskey", "tlsa", "https", "svcb",
]);
const isRecordType = (s: string) => DNS_RECORD_TYPES.has(s.toLowerCase());
// A DNS name / label (also matches reverse-lookup names like 1.0.0.127.in-addr.arpa).
const HOSTISH = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,253}[a-zA-Z0-9])?$/;
// An IPv4/IPv6 literal (no shell metachars — FORBIDDEN already blocks those).
const IPISH = /^[0-9a-fA-F:.]+$/;

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
    // Now: every value is validated and a -u <unit> filter is REQUIRED. The unit
    // may be ANY valid unit name (not just a pre-registered one) — reading a
    // single unit's own log is what diagnosis needs; the mandatory -u + bounds
    // still prevent the whole-journal dump that was the real secret-leak risk.
    const boolFlags = new Set(["--no-pager", "-e", "-x", "-b", "-r"]);
    const valueFlags = new Set(["-u", "-n", "--since", "-p"]);
    let hasUnit = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (!a.startsWith("-")) return `journalctl: positional/match arguments are not allowed: ${a}`;
      if (boolFlags.has(a)) continue;
      if (!valueFlags.has(a)) return `journalctl: flag not allowed: ${a}`;
      const val = args[++i];
      if (val === undefined || val.startsWith("-")) return `journalctl: ${a} requires a value`;
      if (a === "-u") {
        if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(val)) return `journalctl: invalid unit name: ${val}`;
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
    if (!hasUnit) return "journalctl requires -u <unit> (whole-journal reads are not permitted)";
    return null;
  },

  // ── read-only network / mail diagnostics ──────────────────────────────────
  // These reach DNS or read mail config/queues but cannot mutate anything. Each
  // validates every token so no flag can turn a lookup into an edit or a dump.

  // dig: a lookup of a name (or -x <ip>), optional record type, @resolver, and a
  // safe subset of +options. No -f (batch file), no zone transfers.
  dig: (args) => {
    const plus = new Set([
      "+short", "+noall", "+answer", "+nocomments", "+nocmd", "+nostats",
      "+tcp", "+vc", "+trace", "+nssearch", "+identify",
    ]);
    let sawName = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      // axfr/ixfr look like hostnames to our regex but dig reads them as a
      // zone-transfer TYPE — reject them outright wherever they appear.
      const low = a.toLowerCase();
      if (low === "axfr" || low === "ixfr" || low.startsWith("ixfr=")) {
        return `dig: zone transfers are not allowed: ${a}`;
      }
      if (a.startsWith("+")) {
        if (plus.has(a) || /^\+(time|tries|retry|ndots)=\d{1,3}$/.test(a)) continue;
        return `dig: option not allowed: ${a}`;
      }
      if (a.startsWith("@")) {
        const r = a.slice(1);
        if (!HOSTISH.test(r) && !IPISH.test(r)) return `dig: invalid resolver: ${a}`;
        continue;
      }
      if (a === "-t") { const t = args[++i]; if (!t || !isRecordType(t)) return "dig: -t needs a record type"; continue; }
      if (a === "-x") { const ip = args[++i]; if (!ip || !IPISH.test(ip)) return "dig: -x needs an IP"; sawName = true; continue; }
      if (a.startsWith("-")) return `dig: flag not allowed: ${a}`;
      if (isRecordType(a)) continue;
      if (HOSTISH.test(a)) { sawName = true; continue; }
      return `dig: argument not allowed: ${a}`;
    }
    if (!sawName) return "dig: a hostname (or -x <ip>) is required";
    return null;
  },

  // host: name or IP, optional -t <type>, read-only flags only.
  host: (args) => {
    let sawName = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "-t") { const t = args[++i]; if (!t || !isRecordType(t)) return "host: -t needs a record type"; continue; }
      if (a === "-W" || a === "-R") { const n = args[++i]; if (!n || !/^\d{1,3}$/.test(n)) return `host: ${a} needs a number`; continue; }
      if (["-a", "-v", "-4", "-6", "-C", "-T", "-s"].includes(a)) continue;
      if (a.startsWith("-")) return `host: flag not allowed: ${a}`;
      if (HOSTISH.test(a) || IPISH.test(a)) { sawName = true; continue; }
      return `host: argument not allowed: ${a}`;
    }
    if (!sawName) return "host: a hostname or IP is required";
    return null;
  },

  // nslookup: name/IP plus an optional resolver and -type=/-debug.
  nslookup: (args) => {
    let sawName = false;
    for (const a of args) {
      if (/^-(type|querytype|q)=/.test(a)) {
        const t = a.split("=")[1] ?? "";
        if (!isRecordType(t)) return `nslookup: invalid type: ${a}`;
        continue;
      }
      if (a === "-debug" || a === "-nodebug") continue;
      if (a.startsWith("-")) return `nslookup: flag not allowed: ${a}`;
      if (HOSTISH.test(a) || IPISH.test(a)) { sawName = true; continue; }
      return `nslookup: argument not allowed: ${a}`;
    }
    if (!sawName) return "nslookup: a hostname or IP is required";
    return null;
  },

  // postconf: read-only introspection ONLY. -e (edit), -M/-P, and -c (alt config
  // dir) are blocked; bare args must be parameter names, never file paths.
  postconf: (args) => {
    for (const a of args) {
      if (["-e", "-#", "-X", "-c", "-M", "-P", "-F"].includes(a)) {
        return `postconf: ${a} is not permitted (read-only introspection only)`;
      }
      if (["-n", "-d", "-h", "-x", "-p", "-v"].includes(a)) continue;
      if (a.startsWith("-")) return `postconf: flag not allowed (use -n/-d/-h/-x or parameter names): ${a}`;
      if (!/^[a-z0-9_]{1,64}$/i.test(a)) return `postconf: invalid parameter name: ${a}`;
    }
    return null;
  },

  // postqueue / mailq: print the mail queue, never flush or delete it.
  postqueue: (args) => {
    if (args.length === 0) return "postqueue requires -p (print) or -j (json)";
    for (const a of args) if (a !== "-p" && a !== "-j") return `postqueue: only -p and -j are allowed: ${a}`;
    return null;
  },
  mailq: onlyFlags([]),

  // getent: network databases only — passwd/shadow/group are blocked so the AI
  // can't enumerate users.
  getent: (args) => {
    const dbs = new Set(["hosts", "ahosts", "ahostsv4", "ahostsv6", "networks", "services", "protocols"]);
    if (args.length === 0 || !dbs.has(args[0]!)) return `getent: allowed databases: ${[...dbs].join(", ")}`;
    for (let i = 1; i < args.length; i++) {
      const a = args[i]!;
      if (a.startsWith("-")) return `getent: flags not allowed: ${a}`;
      if (!HOSTISH.test(a) && !IPISH.test(a) && !/^[a-z0-9_./-]{1,128}$/i.test(a)) return `getent: invalid key: ${a}`;
    }
    return null;
  },

  // redis-cli: READ-ONLY inspection of the local Redis (queue depth, key peek,
  // INFO). Writes (SET/DEL/FLUSHALL/RENAME/EXPIRE…) and connection flags that
  // could point elsewhere or pass auth (-h/-p/-a/-u) are refused — only an
  // optional `-n <db>` selector is allowed before the subcommand. The default
  // connection is localhost:6379, the same box ServerMind runs on.
  "redis-cli": (args) => {
    const readonly = new Set([
      "llen", "lrange", "lindex", "get", "mget", "getrange", "strlen", "type",
      "ttl", "pttl", "exists", "scard", "smembers", "sismember", "zcard", "zrange",
      "zscore", "hlen", "hget", "hmget", "hgetall", "hkeys", "dbsize", "info",
      "ping", "scan", "keys", "memory", "object", "randomkey", "lpos",
    ]);
    let i = 0;
    if (args[i] === "-n") { const n = args[++i]; if (n === undefined || !/^\d{1,2}$/.test(n)) return "redis-cli: -n needs a db number"; i++; }
    const sub = (args[i] ?? "").toLowerCase();
    if (!sub) return "redis-cli: a read-only subcommand is required (e.g. llen, get, type, ttl, info)";
    if (sub.startsWith("-")) return `redis-cli: connection flags are not allowed (only -n <db> before the subcommand): ${sub}`;
    if (!readonly.has(sub)) return `redis-cli: only read-only subcommands are allowed (llen, lrange, get, type, ttl, exists, scard, hgetall, scan, dbsize, info, …): ${sub}`;
    for (let j = i + 1; j < args.length; j++) if (args[j]!.length > 256) return "redis-cli: argument too long";
    return null;
  },
};

// The base commands run_shell accepts. Exported so the AI's system prompt can
// advertise its own sandbox up front — otherwise the model guesses at commands
// (dig, postconf, mail…), eats a string of REJECTED errors, and looks broken.
export const ALLOWED_SHELL_COMMANDS = Object.keys(POLICY);

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

// Pure validation — no execution. Returns the argv to run, or a rejection reason.
// Split out from runShell so tests can assert the allowlist hermetically (no
// shelling out) and so callers can pre-check a command.
export function validateShell(command: string): { argv: string[] } | { rejected: string } {
  const trimmed = command.trim();

  if (!trimmed) return { rejected: "empty command" };
  if (FORBIDDEN.test(trimmed)) {
    return { rejected: "command contains forbidden shell metacharacters (; & | ` $ > < \\ etc.)" };
  }

  const tokens = trimmed.split(/\s+/);
  const base = tokens[0]!;

  // tolerate a leading `sudo` only by rejecting it explicitly with a clear message
  if (base === "sudo") {
    return { rejected: "sudo is not permitted via run_shell; use service_action for privileged actions" };
  }

  const validator = POLICY[base];
  if (!validator) {
    return { rejected: `command not in allowlist: '${base}'. Allowed: ${Object.keys(POLICY).join(", ")}` };
  }

  let args = tokens.slice(1);

  // Strip dangerous follow-mode flags that would never terminate.
  if (base === "tail") args = args.filter((a) => a !== "-f");

  const argErr = validator(args);
  if (argErr) return { rejected: `${base}: ${argErr}` };

  return { argv: [base, ...args] };
}

export async function runShell(command: string): Promise<ShellOutcome> {
  const v = validateShell(command);
  if ("rejected" in v) return reject(command, v.rejected);
  return exec(v.argv, { timeoutMs: 12_000 });
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
