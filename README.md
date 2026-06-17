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
- **Health alerts & daily digest** — optional email reports: get alerted when
  disk/memory cross a threshold, a monitored service drops, or a TLS cert nears
  expiry, plus a daily health digest. Sends via SMTP or Resend; toggle it from
  the dashboard.
- **Custom tools** — extend the assistant from the dashboard: a frozen shell
  command, a read-only database query, a "DB console" the AI writes SELECTs
  against, an HTTP health check, or a log file to read. You define them; the AI
  can only trigger them. See [Custom tools](#custom-tools).
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
| `EMAIL_*` / `SMTP_*` / `RESEND_API_KEY` | email reports & alerts (SMTP or Resend) |
| `ALERT_DISK_PCT` / `ALERT_MEM_PCT` / `ALERT_CERT_DAYS` | alert thresholds (disk %, mem %, cert-expiry days) |
| `DIGEST_HOUR` | hour (0–23) to send the daily digest; unset = off |

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

## Multi-server (fleet + self-hosted mesh)

Manage many servers from one controller, one login — using the standard
agent/controller model (how Datadog, Netdata, Portainer work), with an optional
**self-hosted WireGuard mesh** (no third party) securing the controller↔agent link.

```
   YOU ─browser─► Controller (UI · chat · auth · registry · enroll · hub)
                       ▲            ▲            ▲   (agents dial OUT over WireGuard)
                  ┌────┴───┐   ┌────┴───┐   ┌────┴───┐
                  │ agent  │   │ agent  │   │ agent  │   one native agent per host
                  │ vps 1  │   │ vps 2  │   │ vps 3  │   (read-only allowlist + arm gate)
                  └────────┘   └────────┘   └────────┘
```

**Set it up (one installer, role chosen by flags):**
```bash
# Controller (your main box) — fleet on, WireGuard mesh on:
curl -fsSL https://servermind.dev/install.sh | bash -s -- --mesh

# Each VPS — the exact command the Fleet tab's "Add server" button generates:
curl -fsSL https://servermind.dev/install.sh | bash -s -- \
  --controller wss://<controller>/fleet/agent --token <token> --mesh
```
The agent generates its own WireGuard keypair locally (its **private key never
leaves the box**), enrolls with the controller (public key only), brings up its
tunnel, and connects over the mesh. Drop `--mesh` on both sides to run the plain
`wss`-over-the-internet topology instead.

- **Agents dial *out*** — no inbound ports on managed servers. The **controller**
  needs a reachable address and, for the mesh, **UDP 51820 open** (the installer
  opens it via ufw/firewalld; a cloud security-group rule is still on you).
- **One login, every server equal.** Password + TOTP once, on the controller.
- **Safety stays distributed** — the read-only allowlist + arm switch run **on
  each agent**, and the mesh reload is gated to one tightly-scoped `sudo wg` rule,
  so even a compromised controller can't get a shell. **Single-server stays the
  zero-config default**, unchanged.
- **Remote-server chat** needs an OpenAI-compatible backend (Claude Code runs
  tools locally only).

> Full design: **[ARCHITECTURE.md](ARCHITECTURE.md)**. The mesh is validated end
> to end (unit tests + container scenarios incl. a fresh-VPS, real-installer run):
> `test/mesh/run.sh`, or `test/mesh/fresh-vps.sh` for the full two-box flow.
> (Run the *controller* in Docker if you like; **agents are always native** —
> a containerized agent can't see the host's systemd/PM2/disk.)

## Custom tools

The built-in tools cover the common cases. **Custom tools** let you teach the
assistant about *your* stack — your database, your health endpoint, your one
diagnostic command — without writing code or weakening the safety model. You
add, edit, test and remove them from the dashboard's **Tools** tab (operator
only, behind your login).

The core idea: **you define and freeze the tool; the AI can only trigger it.**
The model never supplies a command, path, or URL — it just decides *when* to
call what you already approved. (The one exception is the DB console, below,
where the AI writes a *read-only* query that's validated before it runs.)

### The five kinds

| Kind | What it does | The AI supplies |
|------|--------------|-----------------|
| **Pinned command** | Runs one **exact, frozen** `argv` (e.g. `redis-cli INFO memory`) with **no shell** — metacharacters are inert. Read-only by default; tick *"changes things"* to make it a mutation gated by the **arm** switch. | nothing |
| **Read-only DB query** | A **frozen** SQL query you write (MySQL/MariaDB or PostgreSQL). | nothing |
| **DB console** | The AI writes a **read-only** `SELECT`/`SHOW`/`EXPLAIN` at call time against a database you configured. | the query |
| **HTTP health check** | `GET` a **frozen** URL; optionally assert a status code or a JSON field. | nothing |
| **Read a file** | Tails a **frozen** path, confined to the same safe roots as `read_log` (`/var/log`, PM2 logs…). | nothing |

### How the safety holds

- **Frozen by the operator.** The argv / query / URL / path live in the tool's
  definition; the AI can't change them. A poisoned prompt can at most call a
  tool you already vetted.
- **Read-only databases — two layers.** Every DB query (frozen *and* console)
  passes a read-only gate (only `SELECT`/`SHOW`/`EXPLAIN`-class statements, a
  single statement, no `INTO OUTFILE`/`LOAD_FILE`/`COPY … PROGRAM`/`pg_read_file`
  vectors). For **PostgreSQL** the session also runs `default_transaction_read_only=on`,
  so the engine itself rejects any write — including a data-modifying CTE the
  text gate can't catch. The real boundary, though, is the **database user's
  grants**: point DB tools at a **least-privilege, `SELECT`-only role** scoped to
  just the data you want exposed.
- **Mutations stay gated.** A pinned command marked mutating goes through the
  same server-side **arm** switch (and single-use consumption) as a service
  restart — disarmed by default.
- **Secrets encrypted.** A DB tool's connection password is AES-256-GCM encrypted
  at rest and masked in the API, like every other secret.
- **Privacy.** A DB console's results are sent to your configured AI provider so
  it can answer — use a local Ollama backend for zero egress.

> **Note:** a DB console lets the AI read anything its DB user can read. That's
> powerful and convenient — keep it safe by giving the tool a read-only user
> scoped to only the database/tables it should see.

### On a fleet

Custom tools are **agent-owned**: each server defines its own tools in its local
settings and advertises only their *names* to the controller. When you **Manage**
a server in the Fleet tab, the AI is offered that box's tools and the call runs
**on that box**, re-validated locally. The controller can trigger a server's
tools but can never define or push one — so it still can't make a box do
anything its own config forbids.

## License

[MIT](LICENSE) © Ajjlal Ahmed
