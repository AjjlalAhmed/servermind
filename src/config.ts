// Centralised, validated configuration loaded from the environment.
// Bun automatically loads `.env` into `process.env` at startup.
//
// ServerMind drives the locally-installed `claude` CLI (authenticated via a
// Claude subscription) — it does NOT call the paid Anthropic API. There is
// therefore no ANTHROPIC_API_KEY here; in fact we deliberately strip it from
// the CLI's environment (see claude.ts) so it can never fall back to billing.

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

function list(name: string, fallback: string[]): string[] {
  const raw = optional(name, "");
  if (!raw) return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// The argon2 hash is stored base64-encoded because it contains `$`, which Bun's
// .env loader would otherwise expand as variables and corrupt. Decode it back;
// tolerate a raw `$argon2…` value too (in case it was set by hand and survived).
function passwordHashFromEnv(): string {
  const v = optional("SERVERMIND_PASSWORD_HASH", "");
  if (!v) return "";
  if (v.startsWith("$argon2")) return v;
  try {
    const decoded = Buffer.from(v, "base64").toString("utf8");
    if (decoded.startsWith("$argon2")) return decoded;
  } catch {
    /* fall through */
  }
  return v;
}

export const config = {
  // ── Authentication (password + TOTP 2FA, session cookies) ──────────────────
  // Set via `bun run setup-auth`. Until both are present, login is impossible
  // and /auth/login reports that setup is required.
  passwordHash: passwordHashFromEnv(), // argon2id, stored base64 in .env
  totpSecret: optional("SERVERMIND_TOTP_SECRET", ""), // base32 (no `$`, safe as-is)
  sessionTtlHours: Number(optional("SESSION_TTL_HOURS", "12")),

  // ── Networking ─────────────────────────────────────────────────────────────
  // Default to localhost-only; front with Caddy/Nginx for TLS. Use a Tailscale
  // IP here to expose only on your tailnet.
  bindHost: optional("BIND_HOST", "127.0.0.1"),
  port: Number(optional("PORT", "5500")),
  // Set to "1"/"true" when served over HTTPS so the session cookie gets Secure.
  secureCookies: /^(1|true|yes)$/i.test(optional("SECURE_COOKIES", "")),

  // ── AI backend ──────────────────────────────────────────────────────────────
  // "claude-code" → drives the local `claude` CLI (subscription, no key).
  // "openai"      → any OpenAI-compatible API (Gemini, Groq, OpenRouter, Ollama…).
  aiBackend: optional("AI_BACKEND", "claude-code"),
  aiBaseUrl: optional("AI_BASE_URL", "").replace(/\/+$/, ""), // e.g. https://api.groq.com/openai/v1
  aiApiKey: optional("AI_API_KEY", ""),
  aiModel: optional("AI_MODEL", ""), // e.g. gemini-2.0-flash, llama-3.3-70b-versatile

  // Claude Code CLI integration (subscription auth — no API key)
  claudeBin: optional("CLAUDE_BIN", "claude"),
  claudeOauthToken: optional("CLAUDE_CODE_OAUTH_TOKEN", ""),
  model: optional("MODEL", "claude-sonnet-4-6"),

  // How to invoke PM2. PM2 is PER-USER: running `pm2` as the ServerMind user
  // only sees that user's processes. To monitor apps running under another
  // user's PM2 daemon (e.g. root), set PM2_COMMAND="sudo -n pm2" (and grant a
  // NOPASSWD sudo rule for pm2). Tokens are split on whitespace.
  pm2Command: optional("PM2_COMMAND", "pm2").split(/\s+/).filter(Boolean),

  // ── Monitored services (status snapshot + probes) ──────────────────────────
  mysql: {
    user: optional("MYSQL_USER", ""),
    password: optional("MYSQL_PASSWORD", ""),
    host: optional("MYSQL_HOST", "127.0.0.1"),
    port: Number(optional("MYSQL_PORT", "3306")),
  },
  redis: {
    host: optional("REDIS_HOST", "127.0.0.1"),
    port: Number(optional("REDIS_PORT", "6379")),
  },

  // ── Server-specific allowlists (config-driven so this is portable) ─────────
  // systemd units service_action may manage.
  managedServices: list("MANAGED_SERVICES", [
    "nginx", "caddy", "mysql", "mysqld", "mariadb", "redis", "redis-server",
    "pm2-root", "docker", "fail2ban",
  ]),
  // units whose is-active state the /status snapshot reports.
  monitoredUnits: list("MONITORED_UNITS", ["nginx", "caddy", "mysql", "mariadb", "redis-server"]),
  // extra log roots read_log / cat may read, beyond the built-in safe roots.
  extraLogPaths: list("EXTRA_LOG_PATHS", []),
} as const;

export function authConfigured(): boolean {
  return config.passwordHash !== "" && config.totpSecret !== "";
}

export type Config = typeof config;
