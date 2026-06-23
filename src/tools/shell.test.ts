// Security tests for the run_shell allowlist. These assert the REJECTION paths,
// which return before anything is executed — so the suite is hermetic and never
// actually runs a mutating command. A `rejected` string means the allowlist
// refused the input; `undefined` means it passed validation.

import { test, expect, describe } from "bun:test";
import { validateShell } from "./shell.ts";

// Hermetic: validate-only, never shells out. `rejected` returns the reason string
// (truthy) when refused; `accepted` returns undefined when the command passes.
const reason = (cmd: string) => { const v = validateShell(cmd); return "rejected" in v ? v.rejected : undefined; };
const rejected = (cmd: string) => reason(cmd);
const accepted = (cmd: string) => reason(cmd);

describe("run_shell rejects shell metacharacters (injection)", () => {
  for (const cmd of [
    "df -h; rm -rf /",
    "cat /var/log/syslog | grep secret",
    "echo $(whoami)",
    "uptime && reboot",
    "ls `id`",
    "cat /var/log/x > /tmp/out",
    "cat < /etc/passwd",
    "df -h\nrm -rf /",
    "whoami #comment",
    "free {a,b}",
    "ps (x)",
    "uname -a!",
    "cat ..\\/etc/passwd",
  ]) {
    test(cmd, async () => expect(await rejected(cmd)).toBeTruthy());
  }
});

describe("run_shell confines file reads to safe roots", () => {
  test("blocks /proc/<pid>/environ (secret leak)", async () => {
    expect(await rejected("cat /proc/1/environ")).toBeTruthy();
  });
  test("blocks arbitrary /proc files", async () => {
    expect(await rejected("cat /proc/1/cmdline")).toBeTruthy();
  });
  test("blocks paths outside the log roots", async () => {
    expect(await rejected("cat /etc/passwd")).toBeTruthy();
    expect(await rejected("cat /root/.ssh/id_rsa")).toBeTruthy();
  });
  test("blocks path traversal", async () => {
    expect(await rejected("cat /var/log/../../etc/passwd")).toBeTruthy();
  });
  test("allows the explicit /proc diagnostic allowlist", async () => {
    expect(await accepted("cat /proc/meminfo")).toBeUndefined();
  });
  test("allows reads under /var/log", async () => {
    expect(await accepted("tail -n 5 /var/log/syslog")).toBeUndefined();
  });
});

describe("run_shell blocks non-allowlisted and privileged commands", () => {
  for (const cmd of ["ls /", "rm -rf x", "curl http://evil", "bash", "sudo systemctl restart nginx", "kill 1"]) {
    test(cmd, async () => expect(await rejected(cmd)).toBeTruthy());
  }
});

describe("run_shell enforces per-command argument policy", () => {
  test("systemctl is read-only (mutations refused)", async () => {
    expect(await rejected("systemctl restart nginx")).toBeTruthy();
    expect(await rejected("systemctl start nginx")).toBeTruthy();
    expect(await accepted("systemctl is-active nginx")).toBeUndefined();
  });
  test("top must be a non-interactive snapshot", async () => {
    expect(await rejected("top")).toBeTruthy();
    expect(await accepted("top -bn1")).toBeUndefined();
  });
  test("disallowed flags are refused", async () => {
    expect(await rejected("df --output=source")).toBeTruthy();
  });
  test("journalctl requires a -u filter and rejects whole-journal reads", async () => {
    // Without -u it would dump the entire merged system journal — refused.
    expect(await rejected("journalctl --no-pager")).toBeTruthy();
    expect(await rejected("journalctl -n 100")).toBeTruthy();
    // Positional MATCH expressions (the old bypass) are refused.
    expect(await rejected("journalctl -u nginx _UID=0")).toBeTruthy();
    expect(await rejected("journalctl _SYSTEMD_UNIT=ssh.service")).toBeTruthy();
    // Any valid unit name is now allowed (a single unit's own log is read-only
    // and is what diagnosis needs) — but the name itself is still validated.
    expect(await accepted("journalctl -u ssh -n 50 --no-pager")).toBeUndefined();
    expect(await accepted("journalctl -u nginx -n 50 --no-pager")).toBeUndefined();
  });
});

describe("run_shell accepts safe read-only diagnostics", () => {
  for (const cmd of ["df -h", "free -h", "uptime", "hostname", "whoami", "date -u"]) {
    test(cmd, async () => expect(await accepted(cmd)).toBeUndefined());
  }
  test("empty command is rejected", async () => {
    expect(await rejected("   ")).toBeTruthy();
  });
});

describe("run_shell network/mail diagnostics: validation", () => {
  test("dig accepts safe lookups", async () => {
    expect(await accepted("dig +short mx example.com")).toBeUndefined();
    expect(await accepted("dig example.com a")).toBeUndefined();
    expect(await accepted("dig -x 8.8.8.8")).toBeUndefined();
    expect(await accepted("dig @1.1.1.1 +short txt example.com")).toBeUndefined();
  });
  test("dig refuses zone transfers, batch files, and a missing name", async () => {
    expect(await rejected("dig axfr example.com")).toBeTruthy();
    expect(await rejected("dig -f /etc/passwd")).toBeTruthy();
    expect(await rejected("dig +short")).toBeTruthy();
  });
  test("postconf is read-only — edits and alt config dir refused", async () => {
    expect(await accepted("postconf -n")).toBeUndefined();
    expect(await accepted("postconf mydestination virtual_alias_domains")).toBeUndefined();
    expect(await rejected("postconf -e myhostname=evil")).toBeTruthy();
    expect(await rejected("postconf -c /tmp/evil")).toBeTruthy();
    expect(await rejected("postconf /etc/passwd")).toBeTruthy();
  });
  test("postqueue prints only — flush/delete refused", async () => {
    expect(await accepted("postqueue -p")).toBeUndefined();
    expect(await rejected("postqueue -f")).toBeTruthy();
    expect(await rejected("postqueue")).toBeTruthy();
  });
  test("getent allows network DBs but not user enumeration", async () => {
    expect(await accepted("getent hosts localhost")).toBeUndefined();
    expect(await rejected("getent passwd")).toBeTruthy();
    expect(await rejected("getent shadow root")).toBeTruthy();
  });
  test("host/nslookup accept names, refuse stray flags", async () => {
    expect(await accepted("host -t mx example.com")).toBeUndefined();
    expect(await accepted("nslookup -type=mx example.com")).toBeUndefined();
    expect(await rejected("host -f batchfile")).toBeTruthy();
    expect(await rejected("nslookup -type=axfr example.com")).toBeTruthy();
  });
});

describe("run_shell journalctl reads any unit's log (not just managed)", () => {
  test("a custom unit is now allowed with -u + bounds", async () => {
    expect(await accepted("journalctl -u worker-daemon -n 100 --no-pager")).toBeUndefined();
    expect(await accepted("journalctl -u worker-daemon.service -n 50 --no-pager")).toBeUndefined();
  });
  test("still requires -u and still blocks whole-journal + match expressions", async () => {
    expect(await rejected("journalctl --no-pager")).toBeTruthy();
    expect(await rejected("journalctl -u worker-daemon _UID=0")).toBeTruthy();
    expect(await rejected("journalctl -u 'bad unit;rm'")).toBeTruthy();
  });
});

describe("run_shell redis-cli is read-only", () => {
  test("read-only subcommands are allowed", async () => {
    expect(await accepted("redis-cli llen job_queue")).toBeUndefined();
    expect(await accepted("redis-cli -n 0 llen job_queue")).toBeUndefined();
    expect(await accepted("redis-cli info")).toBeUndefined();
    expect(await accepted("redis-cli type somekey")).toBeUndefined();
  });
  test("writes and connection flags are refused", async () => {
    for (const cmd of [
      "redis-cli set k v",
      "redis-cli del job_queue",
      "redis-cli flushall",
      "redis-cli rpush job_queue x",
      "redis-cli -h evil.example.com llen q",
      "redis-cli -a secret get k",
      "redis-cli",
    ]) {
      expect(await rejected(cmd)).toBeTruthy();
    }
  });
});
