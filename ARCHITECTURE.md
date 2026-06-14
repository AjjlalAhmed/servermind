# ServerMind — Multi-Server Architecture

> Status: **largely built.** Fleet mode (controller + remote agents) and an
> optional self-hosted **WireGuard mesh** are implemented and validated end to end
> — see `install.sh --mesh`, `src/fleet/*`, and the container scenarios under
> `test/mesh/` (including `fresh-vps.sh`, which runs the real installer on fresh
> boxes). This document is the design of record; a few items remain on the roadmap
> in §10 (per-agent credential rotation, unified alerts/digest, mTLS option).
> Single-server stays the zero-config default, unchanged.

---

## 1. Goals & non-goals

**Goals**
- One **controller** (one login) manages and monitors **all** your servers.
- **Unified reporting** — every server's health, alerts, and a single daily
  digest in one place.
- **Zero per-server login** — you set up password + TOTP once, on the controller.
- **Every server is equal** — same agent on each box, no roles or labels.
- **Single-server still works standalone**, unchanged, with no controller.

**Non-goals**
- Not a container orchestrator (not Swarm/K8s) — we manage *hosts*, not workloads.
- No role/tag taxonomy — every server is just "a server."
- The controller never gets a shell into your boxes (see §6).

---

## 2. One architecture (not two modes)

There is **one** program — the **controller** — and it always has a **built-in
local agent** for its own box. It can *also* accept **remote agents** from other
servers. That's the whole design; "standalone" is just *a fleet of one*.

| You have… | What runs | The agent is… |
|-----------|-----------|---------------|
| **One server** | Controller + its built-in local agent, one process (`curl \| bash`) | **in-process** (a direct call — no network, no token) |
| **Many servers** | The *same* controller + a lightweight agent on each other box | **remote** (over the wire) |

Key point: the local agent runs **in-process** — the controller calls its
`dispatchTool` directly. A box never dials itself over the network (that would add
a pointless token/socket/failure surface just to run `df -h`). So a single server
needs **no separate controller deployment and no enrollment** — it stays exactly
as zero-config as today. Remote agents are the only thing that use the network
protocol in §5.

Internally there is no "standalone vs fleet" fork — just **local (in-process) vs
remote (networked) agents.** Single-server is simply "zero remote agents."

---

## 3. Components

```
   YOU ─browser─►  ┌───────────────────────────────────────────┐
                   │  CONTROLLER  (Docker container)            │
                   │  • one login: password + TOTP              │
                   │  • fleet dashboard (all servers)           │
                   │  • chat → any server                       │
                   │  • unified alerts + daily digest           │
                   │  • registry + history (SQLite)             │
                   │  • hub: accepts agent connections, routes  │
                   └───▲──────────────▲──────────────▲──────────┘
       agents dial OUT │              │              │   (TLS / wss, persistent)
              ┌────────┴─┐    ┌───────┴──┐    ┌──────┴───┐
              │ agent    │    │ agent    │    │ agent    │   native per host
              │ server-1 │    │ server-2 │    │ server-3 │   (full ServerMind core)
              └──────────┘    └──────────┘    └──────────┘
```

**Controller** — the UI, auth, AI/chat, server registry, unified alerts, and the
**hub** that agents connect to. This layer manages no host, so it's clean to
containerize. On a **single-box native install** the controller also runs a
**built-in in-process local agent** for that box (zero-config — no network, no
token). A **dedicated Docker controller** typically runs without a local agent
(if you want to monitor the controller's own host, run a native agent on it like
any other server). Best run on a **small dedicated VPS** once you have a fleet —
it's the crown jewel.

**Agent** — installed **natively** on each server (not in Docker — it must read the
host's systemd, PM2, disk, logs). It is exactly today's execution + safety core:
the read-only allowlist, the tools, the arm switch, the status snapshot — plus a
**connector** that dials out to the controller.

---

## 4. Topology & connectivity

- **Agents dial outbound** to the controller and hold a persistent connection
  open. Therefore **no inbound ports** are opened on any managed server.
- Only the **controller** needs a stable, reachable address — a domain/static IP,
  or a Tailscale/WireGuard mesh address. Managed servers need no public address.
- Controller should be **always-on** (continuous monitoring + alerts).

---

## 5. Communication protocol

A single authenticated, persistent connection per agent (WebSocket over TLS, or
gRPC stream). Message types:

| Direction | Message | Purpose |
|-----------|---------|---------|
| agent → controller | `hello` (token, hostname, version) | enroll / authenticate |
| agent → controller | `status` (snapshot every ~15s) | powers the fleet dashboard + alerts |
| controller → agent | `invoke` (tool name, input, request id) | run a vetted tool on that box |
| agent → controller | `result` (request id, output, isError) | tool result, streamed |
| controller → agent | `arm` (on/off, ttl) | flip that server's arm switch |
| both | `ping`/`pong` | keepalive |

The agent executes `invoke` by calling its **local `dispatchTool`** — i.e. exactly
the same allowlist + arm gate as standalone. The controller can only *ask*; it
never sends shell.

---

## 6. Security model

The controller is centralized, so it's treated as the crown jewel — but the
**safety boundary stays distributed on each agent.**

| Layer | Mechanism |
|-------|-----------|
| **Human → controller** | Password + TOTP, argon2id, HttpOnly/SameSite cookies, lockout, rate limit (today's auth, on the controller only) |
| **Agent identity** | Per-agent credential (token or mTLS cert), issued at enrollment, **individually revocable** |
| **What the controller can do to a box** | Only invoke the agent's **vetted tools** — the read-only allowlist + arm switch are enforced **on the agent**. The controller has no shell and cannot bypass them, even if compromised |
| **Mutations** | Per-server arm switch, auto-expiring, enforced on the agent |
| **Transport** | TLS (wss); optionally run the whole link over Tailscale/WireGuard for defense-in-depth |
| **Exposure** | Agents dial out → no inbound ports on managed servers |
| **Accountability** | Append-only audit log on the controller: who, what tool, which server, when |
| **Secrets** | Controller secrets encrypted at rest (existing AES-256-GCM settings store); agent tokens stored `chmod 600` |

**Threat note:** if the controller is compromised, the blast radius is bounded by
each agent's allowlist + arm switch — an attacker can run read-only tools and,
only on armed servers, the gated mutations. They cannot get arbitrary shell.
Isolate the controller (dedicated box) and treat its login as critical.

---

## 7. Enrollment & auth at scale (the GitHub Action question)

**You never set password/TOTP on a server.** Agents have no human login.

1. Controller has a **join token** (rotatable) and/or pre-issued per-agent tokens.
2. Deploy installs the agent with the controller URL + join token:
   ```bash
   curl -fsSL https://servermind.dev/install.sh | bash -s -- \
     --controller wss://controller.example.com/fleet/agent --token "$SM_JOIN_TOKEN"
   ```
3. On first connect the agent swaps the join token for its **own per-agent
   credential** (so the join token isn't its permanent key).
4. Optional **approve step**: new agents appear as "pending" in the controller;
   you approve once (prevents a leaked join token from silently adding a node).

**GitHub Action pattern** — two repo secrets, no per-server auth:
```yaml
env:
  SM_CONTROLLER_URL: ${{ secrets.SM_CONTROLLER_URL }}
  SM_JOIN_TOKEN:     ${{ secrets.SM_JOIN_TOKEN }}
steps:
  - run: |
      for host in $SERVERS; do
        ssh "$USER@$host" "curl -fsSL https://servermind.dev/install.sh | bash -s -- \
          --controller '$SM_CONTROLLER_URL' --token '$SM_JOIN_TOKEN'"
      done
```

---

## 8. Data model (controller)

Standalone stays file-based (`.env` + `data/settings.json`). The **controller**
adds a small **SQLite** datastore (multi-server needs queryable state/history):

- `servers` — id, hostname, per-agent credential hash, enrolled_at, last_seen, status
- `snapshots` — latest + short rolling history per server (for the dashboard/reports)
- `audit` — every cross-fleet action
- `settings` — controller-wide alert config (unified), encrypted secrets

Agents remain near-stateless (token + local config only).

---

## 9. Reporting & alerts

- **Fleet dashboard** — one screen, every server as a card (CPU/mem/disk/services/
  PM2), color-coded; click a server to chat/manage it.
- **Unified daily digest** — one email covering the whole fleet.
- **One alert stream** — any server crossing a threshold (or a cert nearing expiry)
  surfaces in one place, tagged by server. The watcher runs on the controller over
  the snapshots it already receives.

---

## 10. Build plan (phased)

Each phase ships value on its own and is independently testable.

### Phase 0 — Refactor (no behavior change)
Extract the **agent core** from the HTTP/UI layer behind a clean interface, so the
same code can run in-process (standalone) or be driven over the wire (fleet).
- Touches: `src/tools/*`, `src/arm.ts`, `src/status.ts` → grouped as the "core."
- `src/index.ts`, `src/auth/*`, `src/backend.ts`, `src/ai/*`, `src/notify/*`,
  `src/public/*` → the "controller" layer.
- Standalone behaves identically; tests stay green. **Foundation only.**

### Phase 1 — Monitoring aggregation (read-only) ⭐ highest value, lowest risk
Agent connector (dial out, enroll, push `status`) + controller hub + SQLite
registry + **fleet dashboard (read-only)**.
- Delivers "**all reports in one place**" immediately — no remote commands yet.
- One installer (`install.sh`), role chosen by flags: default = controller (with
  its built-in local agent, fleet on by default); `--controller URL --token T` =
  agent-only run mode.

### Phase 2 — Remote management
Controller routes `invoke`/`result` to a selected agent; **chat targets a server**;
per-server arm switch. The allowlist + arm gate run on the agent unchanged.

### Phase 3 — Enrollment UX & deploy
Join tokens, pending-approve, revoke in the UI; the GitHub Action deploy pattern;
**unified alerts + daily digest** across the fleet.

### Phase 4 — Hardening & polish
mTLS / mesh transport option, full audit log + retention, fleet-wide chat
("which servers are low on disk?"), snapshot history/graphs.

---

## 11. Open decisions

- **Transport:** raw `wss` + tokens (less infra) vs. require Tailscale/WireGuard
  underneath (stronger, but a dependency). Leaning: `wss` + tokens, mesh optional.
- **AI routing for the Claude backend:** the controller's MCP server must route
  tool calls to the remote agent (the OpenAI backend swaps `dispatchTool` for a
  remote dispatch more directly).
- **Controller HA:** single instance first; clustering is out of scope for v2.

---

## 12. Invariants (must never change)

1. The **allowlist + arm switch are enforced on each agent** — the controller can
   never bypass them or get a shell.
2. **Agents dial outbound** — no inbound ports on managed servers.
3. **Standalone mode stays the zero-config default** and is never broken by fleet
   features.
