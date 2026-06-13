// Security tests for the run_shell allowlist. These assert the REJECTION paths,
// which return before anything is executed — so the suite is hermetic and never
// actually runs a mutating command. A `rejected` string means the allowlist
// refused the input; `undefined` means it passed validation.

import { test, expect, describe } from "bun:test";
import { runShell } from "./shell.ts";

const rejected = async (cmd: string) => (await runShell(cmd)).rejected;
const accepted = async (cmd: string) => (await runShell(cmd)).rejected;

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
});

describe("run_shell accepts safe read-only diagnostics", () => {
  for (const cmd of ["df -h", "free -h", "uptime", "hostname", "whoami", "date -u"]) {
    test(cmd, async () => expect(await accepted(cmd)).toBeUndefined());
  }
  test("empty command is rejected", async () => {
    expect(await rejected("   ")).toBeTruthy();
  });
});
