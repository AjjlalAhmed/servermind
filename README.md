<div align="center">

# ServerMind

**Manage your Linux server by talking to it.**

A self-hosted AI assistant that monitors and runs your VPS — PM2, Redis, MySQL,
Nginx, Caddy, disk, memory, ports, logs — all from one chat, with a live
dashboard. Bring your own AI: **free Gemini** or your **Claude** subscription.

</div>

```bash
curl -fsSL https://servermind.dev/install.sh | bash
```

---

## What it does

- **Chat your infrastructure** — “Is Redis healthy?”, “Why is nginx down?”,
  “Restart api-prod”, “How much disk is left?” ServerMind picks the right tool,
  runs it, and explains what it finds.
- **Live dashboard** — CPU, memory, disk, uptime, PM2 processes and service
  health at a glance, with sparklines and a status pulse, auto-refreshing.
- **Bring your own AI** — the free **Gemini** tier, a **Claude Code**
  subscription, or any **OpenAI-compatible** API (Groq, OpenRouter, local
  Ollama). No lock-in.
- **Safe by design** — a strict read-only command allowlist (no raw shell), and a
  server-enforced *arm* switch required before any change touches your box.
- **Locked down** — password + TOTP 2FA, HttpOnly sessions, brute-force lockout,
  strict CSP. Runs entirely on your server; nothing leaves the box.

## Install

```bash
curl -fsSL https://servermind.dev/install.sh | bash
```
The installer sets up Bun + PM2, clones the repo, runs the setup wizard, and
starts ServerMind under PM2. The wizard asks how you'll reach it and tailors the
rest — see [Accessing ServerMind](#accessing-servermind).

**Manual install**
```bash
git clone https://github.com/AjjlalAhmed/servermind.git && cd servermind
bun install
bun run setup        # guided config → writes .env (auth, AI backend, services)
bun run start        # or: pm2 start ecosystem.config.cjs
```

## Choosing your AI

Run `bun run setup` and pick a backend, or set it in `.env`:

**Free — Google Gemini** (~1,500 requests/day, no card):
```ini
AI_BACKEND=openai
AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
AI_MODEL=gemini-2.0-flash
AI_API_KEY=<key from https://aistudio.google.com>
```
Other OpenAI-compatible options: **Groq** (`api.groq.com/openai/v1`), **OpenRouter**, or local **Ollama** (`127.0.0.1:11434/v1`).

**Claude subscription** (uses the local `claude` CLI, no API key):
```ini
AI_BACKEND=claude-code
```
Requires Claude Code installed and logged in on the box.

## Accessing ServerMind

ServerMind binds to `127.0.0.1:5500` by default and serves its own UI — **a
domain and a reverse proxy are optional.** The setup wizard asks how you'll
reach it and configures the rest. You don't need Caddy or Nginx unless you want
a public HTTPS domain.

**No domain (recommended to start)** — keep it private, reach it from your
laptop:

```bash
# SSH tunnel — nothing is ever exposed to the internet
ssh -L 5500:127.0.0.1:5500 user@your-server   # then open http://localhost:5500
```
Or join it to a [Tailscale](https://tailscale.com) tailnet (set `BIND_HOST` to
the server's tailnet IP), or spin up a throwaway HTTPS URL with no domain:
`cloudflared tunnel --url http://127.0.0.1:5500`.

Over an SSH tunnel or tailnet, plain HTTP is fine — your password and TOTP never
cross the open internet.

**Public domain over HTTPS** — front it with a reverse proxy (the wizard prints
a ready-to-paste config and detects which one you have):

```caddy
servermind.example.com {
    reverse_proxy 127.0.0.1:5500 {
        flush_interval -1      # stream the chat (SSE) without buffering
    }
}
```
Nginx works too (`proxy_pass` + `proxy_buffering off`; get a cert with
`certbot`). Set `SECURE_COOKIES=1` (the wizard does this automatically) so the
session cookie is marked `Secure`, and `TRUST_PROXY=1` so brute-force lockout and
rate limiting use the real client IP from `X-Forwarded-For` rather than the
proxy's own address.

> **Don't** bind to `0.0.0.0` and browse to `http://server-ip:5500` directly —
> that sends your credentials in cleartext. Use a tunnel, a tailnet, or HTTPS.

## Configuration

`bun run setup` writes everything; re-run it anytime to change settings. Key vars:

| Var | Purpose |
|-----|---------|
| `AI_BACKEND` | `openai` or `claude-code` |
| `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` | OpenAI-compatible backend |
| `BIND_HOST` / `PORT` | network bind (default `127.0.0.1:5500`) |
| `SECURE_COOKIES` | `1` when behind HTTPS |
| `TRUST_PROXY` | `1` behind a reverse proxy, so rate limiting/lockout use the forwarded client IP |
| `MONITORED_UNITS` | systemd units shown on the dashboard |
| `PM2_COMMAND` | e.g. `sudo -n /root/.bun/bin/pm2` to monitor another user's PM2 |
| `MYSQL_*` / `REDIS_*` | optional health probes |

Auth (`SERVERMIND_PASSWORD_HASH`, `SERVERMIND_TOTP_SECRET`) is written by the
wizard — never edit by hand. `.env` is gitignored and never leaves your server.

## Uninstall

```bash
curl -fsSL https://servermind.dev/uninstall.sh | bash
```
Or, from a cloned repo: `bun run uninstall`. It stops and removes the
`servermind` PM2 process (`pm2 save` so it stays gone after reboot) and — after
you confirm — deletes the install directory, including its `.env` and logs. Bun,
PM2, and git are left in place (you likely use them elsewhere); the script prints
the commands to remove those too if you want.

Manual equivalent:
```bash
pm2 delete servermind && pm2 save
rm -rf ~/servermind          # contains .env + logs
pm2 unstartup                # only if ServerMind was your boot-start app
```

## Security

Security is enforced **server-side**, not by trusting the model:

- **No shell** — every command runs as argv against a read-only allowlist;
  injection is structurally impossible. No `rm`, writes, or network. File reads
  are confined to safe roots (`/var/log`, PM2 logs); secrets like
  `/proc/*/environ` are blocked.
- **Mutations gated** — restart/stop/start are refused unless you flip the *arm*
  switch (a per-request flag the model can't set), so prompt injection in tool
  output can't trigger changes.
- **Auth** — password + RFC-6238 TOTP, argon2id hashing, HttpOnly/SameSite=Strict
  cookies, brute-force lockout, rate limiting, strict CSP.

Found an issue? See [SECURITY.md](SECURITY.md).

## Stack

Bun + Hono (TypeScript) · single-file vanilla-JS dashboard · MCP tool server ·
PM2. No build step.

```bash
bun run dev         # local dev (http://127.0.0.1:5500)
bun run typecheck
bun test
```

## Roadmap

**Next goal — manage a fleet of servers from one place** (agent + controller).

Today ServerMind runs one instance per box. The next step is multi-server, using
the standard agent/controller model (how Datadog, Netdata, Portainer work):

```
            Controller (Docker container — manages no host)
            dashboard · chat · auth · server registry/router
                 ▲            ▲            ▲   (agents dial OUT)
            ┌────┴───┐   ┌────┴───┐   ┌────┴───┐
            │ agent  │   │ agent  │   │ agent  │   one lightweight agent per host
            │ vps 1  │   │ vps 2  │   │ vps 3  │   (today's execution core)
            └────────┘   └────────┘   └────────┘
```

- **Agent on each server** — the current execution core: read-only allowlist,
  the tools, and the arm switch, all enforced **locally on each box**.
- **One controller** (a good fit for Docker, since it manages no host) — the UI,
  chat, auth, and a server picker that routes the AI's tool calls to the chosen
  agent.
- **Agents dial *out*** to the controller (outbound websocket / reverse tunnel),
  so no inbound ports need opening on the VPSes.

**One login, every server equal.** You set up password + TOTP **once on the
controller** — agents have no human login (they authenticate with revocable
per-agent tokens, so a fleet deploy via CI needs no per-server auth). No roles or
labels; every server runs the same agent and shows up in one fleet dashboard with
unified reports and a single daily digest.

Security stays intact because the **allowlist + arm switch live on each agent**,
not the controller — so even a compromised controller can't get a shell or bypass
the arm gate; it can only ask an agent to run its own vetted tools. **Single-server
mode stays the zero-config default** and is never broken by fleet features.

> Full design + phased build plan: **[ARCHITECTURE.md](ARCHITECTURE.md)**.
> (Note: the *single-box* app isn't meant to run in Docker — managing a host from
> inside a container fights container isolation; it's the *controller* that belongs
> in Docker, with native agents on each host.)

## License

[MIT](LICENSE) © Ajjlal Ahmed
