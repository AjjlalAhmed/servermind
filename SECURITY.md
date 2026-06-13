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

## How ServerMind is hardened (context for researchers)

- **Auth:** password + TOTP 2FA, argon2id hashing, HttpOnly/SameSite=Strict
  session cookies, brute-force lockout, rate limiting.
- **Tool execution:** every command runs via argv (no shell) against a strict
  read-only allowlist — command injection is structurally prevented. File reads
  are confined to safe roots; `/proc/*/environ` and similar are blocked.
- **Mutations:** restart/stop/start are refused server-side unless the operator
  explicitly *arms* them (a per-request flag the model cannot set itself), so
  prompt injection in tool output cannot trigger changes.
- **Transport:** strict Content-Security-Policy, bound to localhost by default
  behind a TLS reverse proxy, secrets confined to a local `.env` (chmod 600).

If you find a gap in any of the above, that's exactly what we want to hear about.
