// MySQL probe via the `mysql` CLI. The password is passed through the
// MYSQL_PWD env var (not argv) so it never shows up in `ps`.
//
// Read-only by policy: arbitrary queries are restricted to SELECT / SHOW /
// DESCRIBE / EXPLAIN so this tool can't mutate data.

import { exec } from "./exec.ts";
import { config } from "../config.ts";

const READONLY_RE = /^\s*(select|show|describe|desc|explain)\b/i;
const FORBIDDEN_CHARS = /[;`]/; // single-statement only
// Even a SELECT can write files / read arbitrary files if the MySQL user has
// FILE privilege — block those vectors explicitly.
const FILE_VECTORS = /\b(into\s+(out|dump)file|load_file|load\s+data)\b/i;

function baseArgs(): string[] {
  const { user, host, port } = config.mysql;
  const args = ["mysql", "-h", host, "-P", String(port), "--protocol=TCP", "-N", "-B"];
  if (user) args.push("-u", user);
  return args;
}

function env() {
  return config.mysql.password ? { MYSQL_PWD: config.mysql.password } : {};
}

export interface MysqlResult {
  ok: boolean;
  output: string;
  error?: string;
}

export async function mysqlPing(): Promise<MysqlResult> {
  const r = await exec([...baseArgs(), "-e", "SELECT 1"], { env: env(), timeoutMs: 8_000 });
  return {
    ok: r.ok,
    output: r.ok ? "connection OK (SELECT 1 succeeded)" : r.stderr || r.stdout,
    error: r.ok ? undefined : "mysql connection failed",
  };
}

export async function mysqlShowDatabases(): Promise<MysqlResult> {
  const r = await exec([...baseArgs(), "-e", "SHOW DATABASES"], { env: env(), timeoutMs: 8_000 });
  return {
    ok: r.ok,
    output: r.ok ? r.stdout.trim() : r.stderr || r.stdout,
    error: r.ok ? undefined : "SHOW DATABASES failed",
  };
}

export async function mysqlQuery(query: string): Promise<MysqlResult> {
  if (FORBIDDEN_CHARS.test(query)) {
    return { ok: false, output: "", error: "query may not contain ';' or backticks (single read-only statement only)" };
  }
  if (!READONLY_RE.test(query)) {
    return { ok: false, output: "", error: "only read-only queries are allowed (SELECT/SHOW/DESCRIBE/EXPLAIN)" };
  }
  if (FILE_VECTORS.test(query)) {
    return { ok: false, output: "", error: "file access (INTO OUTFILE/DUMPFILE, LOAD_FILE, LOAD DATA) is not allowed" };
  }
  const r = await exec([...baseArgs(), "--table", "-e", query], { env: env(), timeoutMs: 12_000 });
  return {
    ok: r.ok,
    output: r.ok ? r.stdout.trim() : r.stderr || r.stdout,
    error: r.ok ? undefined : "query failed",
  };
}
