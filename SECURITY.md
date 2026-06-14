# Security Policy

ServerMind runs on your own server and can (when armed) restart services, so we
take security seriously. Thanks for helping keep it safe.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Instead, report privately via GitHub's **[Security Advisories](../../security/advisories/new)**
(Security → Report a vulnerability), or email the maintainer ajjlalahemd48@gmail.com. Include:

- what the issue is and its impact,
- steps to reproduce (proof-of-concept if possible),
- affected version / commit.

We aim to acknowledge within a few days and to ship a fix or mitigation promptly.
Please give us reasonable time to address it before any public disclosure.

## Scope

In scope: authentication bypass, privilege escalation, command-injection or
sandbox escape in the tool layer, secret exposure, SSRF, CSRF, XSS, or anything
that lets a request do something the operator didn't authorize.

Out of scope: issues that require an already-compromised host or root access;
misconfiguration of the operator's own server (e.g. exposing the port without
TLS); third-party AI providers.

## How ServerMind is hardened

- **Auth:** password + TOTP 2FA, argon2id hashing, HttpOnly/SameSite=Strict
  session cookies, brute-force lockout, rate limiting.
- **Tool execution:** every command runs via argv (no shell) against a strict
  read-only allowlist — command injection is structurally prevented. File reads
  are confined to safe roots; `/proc/*/environ` and similar are blocked.
- **Mutations:** restart/stop/start are refused server-side unless the operator
  explicitly *arms* them (a switch the model cannot set itself, auto-expiring),
  so prompt injection in tool output cannot trigger changes.
- **No database:** ServerMind has no SQL/ORM — settings live in a JSON file,
  sessions in memory. There is no SQL-injection surface.
- **Settings & secrets:** the dashboard can edit a safe subset (email, alerts,
  monitoring, AI) — never auth, the service allowlist, PM2 sudo, or the network
  bind. Writes are schema-validated (Zod), atomic (`chmod 600`), and audited.
  Secret fields (SMTP password, API keys) are **encrypted at rest (AES-256-GCM)**
  in `data/settings.json`; the key lives in `.env`. Secrets are masked and
  write-only over the API — never returned to the browser.
- **Transport:** strict Content-Security-Policy, bound to localhost by default
  behind a TLS reverse proxy, secrets confined to local files (`chmod 600`).

## Threat model

What is **structurally prevented** (not merely filtered):

| Attack | Why it can't land |
|--------|-------------------|
| SQL injection | No database exists |
| Command injection | argv-only execution, no shell, read-only allowlist |
| Path traversal to secrets | Reads confined to safe roots; `.env`/settings never web-served; `/proc/*/environ` blocked |
| XSS session-token theft | HttpOnly cookies (JS can't read them) + strict CSP |
| CSRF | SameSite=Strict cookies |
| Credential brute-force | TOTP 2FA + escalating lockout + rate limiting |
| Unauthorized settings change | Auth-gated, Zod-validated, boundary fields not editable via API |
| AI-triggered changes | Read-only allowlist + server-side arm switch |

**Honest residual risks** (no internet-exposed admin panel is invulnerable):

1. **The admin password is the front door.** Use a strong one; TOTP backs it, but
   a weak password weakens the whole system.
2. **Running as root** gives any hypothetical escape full blast radius. Prefer a
   dedicated non-root user with a narrow `NOPASSWD` sudo rule for the services it
   manages.
3. **Encryption at rest is defense-in-depth, not magic.** If the host itself is
   fully compromised, the attacker has `.env` (the key) too. It protects against
   leaked backups or partial file disclosure, not a root-level box compromise.
4. **Dependencies & the Claude CLI.** Kept minimal and pinned, but any code
   carries non-zero risk; ServerMind has not had a third-party security audit.
   If you use the Claude Code backend, pin the `claude` version (the built-in
   tool deny-list is matched to known releases).

## Operator responsibilities

ServerMind defends the application; you secure the deployment:

- Use a **strong admin password** and keep your TOTP device safe.
- Run it **behind TLS** (a reverse proxy) if exposed to the internet — never bind
  `0.0.0.0` over plain HTTP. For a private setup, an SSH tunnel or Tailscale needs
  no public exposure at all.
- Prefer a **non-root user** with least-privilege sudo.
- **Keep it updated** (re-run the installer) and back up `.env` and your
  `SETTINGS_KEY`.

If you find a gap in any of the above, that's exactly what we want to hear about.
