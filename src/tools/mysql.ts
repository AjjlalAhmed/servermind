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

// Shared read-only gate. Returns an error string, or null if the query is a
// single safe SELECT/SHOW/DESCRIBE/EXPLAIN with no file vectors. Reused by the
// built-in mysql probe AND by user-defined db_query custom tools.
export function validateReadonlySql(query: string): string | null {
  if (FORBIDDEN_CHARS.test(query)) return "query may not contain ';' or backticks (single read-only statement only)";
  if (!READONLY_RE.test(query)) return "only read-only queries are allowed (SELECT/SHOW/DESCRIBE/EXPLAIN)";
  if (FILE_VECTORS.test(query)) return "file access (INTO OUTFILE/DUMPFILE, LOAD_FILE, LOAD DATA) is not allowed";
  return null;
}

export interface MysqlConn {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
}

function baseArgs(conn: MysqlConn = config.mysql): string[] {
  const args = ["mysql", "-h", conn.host, "-P", String(conn.port), "--protocol=TCP", "-N", "-B"];
  if (conn.user) args.push("-u", conn.user);
  if (conn.database) args.push("-D", conn.database);
  return args;
}

function env(conn: MysqlConn = config.mysql) {
  return conn.password ? { MYSQL_PWD: conn.password } : {};
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
  return mysqlQueryOn(config.mysql, query);
}

// Run a single read-only query against an explicit connection. Used by
// user-defined db_query custom tools, which point at their own DB (ideally a
// SELECT-only user — see the dashboard note). The read-only gate is enforced
// here too, so it holds no matter who calls.
export async function mysqlQueryOn(conn: MysqlConn, query: string): Promise<MysqlResult> {
  const bad = validateReadonlySql(query);
  if (bad) return { ok: false, output: "", error: bad };
  const r = await exec([...baseArgs(conn), "--table", "-e", query], { env: env(conn), timeoutMs: 12_000 });
  return {
    ok: r.ok,
    output: r.ok ? r.stdout.trim() : r.stderr || r.stdout,
    error: r.ok ? undefined : "query failed",
  };
}
