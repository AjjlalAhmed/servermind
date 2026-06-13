// Low-level command runner. Everything that touches the OS goes through here.
//
// Critically, this NEVER spawns a shell — argv is passed directly to the
// kernel, so shell metacharacters (;, |, &&, $(), backticks, redirects) carry
// no special meaning and command injection is structurally impossible.

export interface ExecResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  command: string;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_CHARS = 60_000; // keep tool results well within model limits

function clamp(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return s.slice(0, MAX_OUTPUT_CHARS) + `\n…[truncated ${s.length - MAX_OUTPUT_CHARS} chars]`;
}

export async function exec(
  argv: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const command = argv.join(" ");

  let timedOut = false;

  // Bun.spawn throws synchronously if the binary isn't on PATH — keep it inside
  // the try so a missing tool degrades to a normal error result, never a throw.
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
  } catch (err) {
    return {
      ok: false,
      code: null,
      stdout: "",
      stderr: `failed to spawn: ${(err as Error).message}`,
      command,
      timedOut,
    };
  }

  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, timeoutMs);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;

    return {
      ok: !timedOut && code === 0,
      code,
      stdout: clamp(stdout),
      stderr: clamp(stderr),
      command,
      timedOut,
    };
  } catch (err) {
    return {
      ok: false,
      code: null,
      stdout: "",
      stderr: `failed to spawn: ${(err as Error).message}`,
      command,
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}
