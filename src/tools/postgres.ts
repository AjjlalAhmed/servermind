// Postgres probe via the `psql` CLI. The password is passed through the
// PGPASSWORD env var (not argv) so it never shows up in `ps`.
//
// Read-only by policy: queries are restricted to SELECT / SHOW / EXPLAIN / TABLE
// / WITH and the Postgres-specific file/exec vectors are blocked. As with MySQL,
// the strongest guarantee is to point the tool at a SELECT-only role — this
// gate is defence-in-depth on top of that.

import { exec } from "./exec.ts";

const READONLY_RE = /^\s*(select|show|explain|table|with|values)\b/i;
// Single statement only, and no psql backslash meta-commands (\copy, \!, etc.).
const FORBIDDEN_CHARS = /[;`\\]/;
// Postgres ways to touch the filesystem or shell even from a SELECT.
const FILE_VECTORS =
  /\b(copy\b[\s\S]*\b(from|to)\b[\s\S]*\b(program|stdin|stdout)\b|copy\s+\(|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|dblink|pg_logical_emit_message)\b/i;

export interface PostgresConn {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface PostgresResult {
  ok: boolean;
  output: string;
  error?: string;
}

// Returns an error string, or null if the query is a single safe read-only
// statement with no file/exec vectors.
export function validateReadonlyPg(query: string): string | null {
  if (FORBIDDEN_CHARS.test(query)) return "query may not contain ';', backticks, or backslash commands (single read-only statement only)";
  if (!READONLY_RE.test(query)) return "only read-only queries are allowed (SELECT/SHOW/EXPLAIN/TABLE/WITH/VALUES)";
  if (FILE_VECTORS.test(query)) return "file/exec access (COPY … PROGRAM, pg_read_file, lo_import, dblink, …) is not allowed";
  return null;
}

function baseArgs(conn: PostgresConn): string[] {
  // -t tuples-only, -A unaligned, -X ignore .psqlrc, -w never prompt for a password.
  return ["psql", "-h", conn.host, "-p", String(conn.port), "-U", conn.user, "-d", conn.database, "-X", "-w", "-t", "-A", "--csv"];
}

// Read-only enforced by the engine, not just the regex: default every
// transaction in this psql session to READ ONLY, so Postgres itself rejects any
// write — including a data-modifying CTE (`WITH x AS (DELETE …) SELECT …`) that
// the text-level gate can't reliably catch. Legitimate reads (SELECT, read-only
// CTEs, EXPLAIN) are unaffected — this looks at what a statement DOES, not its
// text, so there are no false positives. The validateReadonlyPg regex stays as a
// friendly first check AND to block file reads (e.g. pg_read_file), which a
// read-only transaction does not prevent.
export const PG_READONLY_OPT = "-c default_transaction_read_only=on";

export async function postgresQueryOn(conn: PostgresConn, query: string): Promise<PostgresResult> {
  const bad = validateReadonlyPg(query);
  if (bad) return { ok: false, output: "", error: bad };
  const r = await exec([...baseArgs(conn), "-c", query], {
    env: { PGPASSWORD: conn.password, PGCONNECT_TIMEOUT: "8", PGOPTIONS: PG_READONLY_OPT },
    timeoutMs: 12_000,
  });
  return {
    ok: r.ok,
    output: r.ok ? r.stdout.trim() : r.stderr || r.stdout,
    error: r.ok ? undefined : "query failed",
  };
}
