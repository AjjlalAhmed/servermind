#!/usr/bin/env bash
#
# ServerMind installer.  Usage:
#   curl -fsSL https://servermind.dev/install.sh | bash
#
# Installs Bun + PM2, clones ServerMind, runs the setup wizard, and starts it
# under PM2. Re-running updates an existing install.
#
# Override defaults with env vars:
#   SERVERMIND_REPO=...   git URL to clone (default below)
#   SERVERMIND_DIR=...    install directory (default: ~/servermind)

set -euo pipefail

REPO="${SERVERMIND_REPO:-https://github.com/AjjlalAhmed/servermind.git}"
DIR="${SERVERMIND_DIR:-$HOME/servermind}"

# ── pretty output ──────────────────────────────────────────────────────────────
if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; A=$'\033[38;5;105m'; N=$'\033[0m'; else B= D= G= Y= R= A= N=; fi
step() { printf "\n${A}${B}▸ %s${N}\n" "$1"; }
info() { printf "  %s\n" "$1"; }
ok()   { printf "  ${G}✓${N} %s\n" "$1"; }
warn() { printf "  ${Y}!${N} %s\n" "$1"; }
die()  { printf "\n${R}✗ %s${N}\n" "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ── role / flags ───────────────────────────────────────────────────────────────
# One installer, two roles — same code, same box-local safety core either way.
# With no flags it installs the CONTROLLER: the web UI + auth + AI, plus THIS box
# as a built-in local agent (a "fleet of one", hub on by default, ready to enroll
# more servers). Pass --controller to instead install this box as an AGENT that
# dials OUT to an existing controller (no UI, no auth, no inbound ports).
#
#   Controller:  curl -fsSL https://servermind.dev/install.sh | bash
#   Agent:       curl -fsSL https://servermind.dev/install.sh | bash -s -- \
#                  --controller wss://controller.example.com/fleet/agent --token <token>
MODE="controller"
AGENT_CONTROLLER=""; AGENT_TOKEN=""; AGENT_ID=""; AGENT_INSECURE=""; MESH=""
usage() {
  printf "Usage: install.sh [--mesh] [--controller <ws(s) URL> --token <token> [--id <id>] [--insecure]]\n"
  printf "  (no flags)      install the controller (default; manages this box, accepts agents)\n"
  printf "  --mesh          set up a self-hosted WireGuard mesh on the controller (needs sudo)\n"
  printf "  --controller U  install this box as an AGENT that dials the controller hub at U\n"
  printf "  --token T       join token (required for agent; or env FLEET_JOIN_TOKEN)\n"
  printf "  --id ID         stable agent id (optional; auto-generated + persisted otherwise)\n"
  printf "  --insecure      allow a plaintext ws:// controller (trusted/test networks only)\n"
}
while [ $# -gt 0 ]; do
  case "$1" in
    --controller|-c) AGENT_CONTROLLER="${2:-}"; shift 2 || shift;;
    --controller=*)  AGENT_CONTROLLER="${1#*=}"; shift;;
    --token|-t)      AGENT_TOKEN="${2:-}"; shift 2 || shift;;
    --token=*)       AGENT_TOKEN="${1#*=}"; shift;;
    --id)            AGENT_ID="${2:-}"; shift 2 || shift;;
    --id=*)          AGENT_ID="${1#*=}"; shift;;
    --insecure)      AGENT_INSECURE=1; shift;;
    --mesh)          MESH=1; shift;;
    -h|--help)       usage; exit 0;;
    *)               warn "ignoring unknown option: $1"; shift;;
  esac
done
# Env fallbacks — convenient for CI / GitHub Actions secrets.
AGENT_CONTROLLER="${AGENT_CONTROLLER:-${SERVERMIND_CONTROLLER:-}}"
AGENT_TOKEN="${AGENT_TOKEN:-${FLEET_JOIN_TOKEN:-}}"
[ -n "$AGENT_CONTROLLER" ] && MODE="agent"

# .env upsert helpers (used by both roles). Avoid sed so URLs/tokens with slashes
# need no escaping.
set_env() {
  local key="$1" val="$2"
  touch .env
  if grep -qE "^${key}=" .env 2>/dev/null; then
    grep -vE "^${key}=" .env > .env.tmp 2>/dev/null && mv .env.tmp .env
  fi
  printf '%s=%s\n' "$key" "$val" >> .env
}
get_env() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }

printf "\n${A}${B}  ServerMind${N} ${D}— self-hosted AI for your Linux server${N}\n"
[ "$MODE" = "agent" ] && printf "${D}  installing as a fleet AGENT → ${AGENT_CONTROLLER}${N}\n"

# ── 0. sanity ──────────────────────────────────────────────────────────────────
[ "$(uname -s)" = "Linux" ] || warn "ServerMind targets Linux; other systems are untested."
if [ "$MODE" = "controller" ] && [ "$(id -u)" = "0" ]; then
  warn "Running as root. The Claude Code backend refuses to run as root —"
  warn "if you'll use Claude Code, install as a normal user instead. (Gemini/API backends are fine as root.)"
fi

# ── 1. Bun ─────────────────────────────────────────────────────────────────────
step "Checking Bun"
if have bun; then ok "Bun $(bun --version)"; else
  info "Installing Bun…"; curl -fsSL https://bun.sh/install | bash >/dev/null
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"; export PATH="$BUN_INSTALL/bin:$PATH"
  have bun || die "Bun install failed — install it manually from https://bun.sh and re-run."
  ok "Bun $(bun --version)"
fi
export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"

# ── 2. PM2 ─────────────────────────────────────────────────────────────────────
step "Checking PM2"
if have pm2; then ok "PM2 present"; else info "Installing PM2…"; bun install -g pm2 >/dev/null 2>&1 || die "PM2 install failed."; ok "PM2 installed"; fi
export PATH="$HOME/.bun/bin:$PATH"

# ── 3. git ─────────────────────────────────────────────────────────────────────
step "Checking git"
if have git; then ok "git present"; else
  info "Installing git…"
  if   have apt-get; then sudo apt-get update -qq && sudo apt-get install -y -qq git
  elif have dnf;     then sudo dnf install -y -q git
  elif have yum;     then sudo yum install -y -q git
  elif have apk;     then sudo apk add --quiet git
  else die "git not found and no known package manager — install git and re-run."; fi
  ok "git installed"
fi

# ── 4. get the code ────────────────────────────────────────────────────────────
step "Fetching ServerMind"
if [ -n "${SERVERMIND_SRC:-}" ]; then
  # Offline / local-source install: copy a working tree instead of cloning. Used
  # for air-gapped installs and the fresh-VPS test harness (so it exercises the
  # local code, including uncommitted changes).
  info "Using local source from $SERVERMIND_SRC (no git)"
  mkdir -p "$DIR"; cp -a "$SERVERMIND_SRC/." "$DIR/" || die "copy from SERVERMIND_SRC failed."
  ok "Copied"
elif [ -d "$DIR/.git" ]; then
  info "Updating existing install at $DIR"
  git -C "$DIR" fetch --prune origin && git -C "$DIR" reset --hard origin/main
  ok "Updated"
else
  info "Cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR" || die "Clone failed. If the repo is private, clone it manually (with a token) then re-run."
  ok "Cloned"
fi
cd "$DIR"

# Trim files that only matter to the project, not to running ServerMind on this
# box: the marketing landing site, the CI config, and the local fleet SIMULATION
# (the docker-compose sim, its seed SQL / sim-tools manifests, the sim-agent
# image + entry script, and the sim tool-seeder). A native install runs from
# .env under PM2 and never touches any of these, so they're just dead weight —
# and the sim files carry dummy creds we don't want sitting on a prod box. The
# running app serves src/public only. (guides/ is gitignored and never cloned.)
# NOTE: keep scripts/ otherwise — --mesh calls scripts/setup-mesh-controller.sh.
# Runs every time — a later `git reset --hard` during update restores these and
# this removes them again. Idempotent.
rm -rf landing .github test docker docker-compose.fleet.yml Dockerfile.agent-sim \
  scripts/sim-seed-tools.ts 2>/dev/null || true

# ── 5. dependencies ────────────────────────────────────────────────────────────
step "Installing dependencies"
bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null 2>&1 || die "bun install failed."
mkdir -p logs
ok "Dependencies ready"

# ── 6. AGENT path — configure + start, then we're done ──────────────────────────
# An agent has no UI, auth, or AI. It writes the fleet vars to .env (Bun loads it
# at runtime) and runs the agent core under PM2. The read-only allowlist + arm
# switch are still enforced locally here whenever the controller invokes a tool.
if [ "$MODE" = "agent" ]; then
  step "Configuring agent"
  [ -n "$AGENT_TOKEN" ] || die "Agent mode needs a join token. Pass --token <token> (or set FLEET_JOIN_TOKEN)."
  set_env SERVERMIND_CONTROLLER "$AGENT_CONTROLLER"
  set_env FLEET_JOIN_TOKEN "$AGENT_TOKEN"
  [ -n "${AGENT_ID:-}" ] && set_env SERVERMIND_AGENT_ID "$AGENT_ID"
  [ -n "${AGENT_INSECURE:-}" ] && set_env FLEET_ALLOW_INSECURE 1
  chmod 600 .env 2>/dev/null || true
  ok "Configured — dials: $AGENT_CONTROLLER"

  # --mesh: enroll into the WireGuard mesh now (keypair generated locally, only the
  # public key sent), bring up the tunnel, then point the running agent at the
  # controller's MESH address. ws over WireGuard is already encrypted, so the
  # agent talks plain ws on the tunnel (FLEET_ALLOW_INSECURE).
  if [ -n "$MESH" ]; then
    step "Joining the WireGuard mesh"
    if [ "$(id -u)" = "0" ]; then SUDO=""; elif have sudo; then SUDO="sudo"; else die "--mesh needs root or sudo to set up WireGuard."; fi
    MESH_URL="$($SUDO env BUN_BIN="$(command -v bun)" \
      SERVERMIND_CONTROLLER="$AGENT_CONTROLLER" FLEET_JOIN_TOKEN="$AGENT_TOKEN" \
      SERVERMIND_AGENT_ID="$(get_env SERVERMIND_AGENT_ID)" \
      bash "$DIR/scripts/setup-mesh-agent.sh")" || die "mesh enrollment failed."
    [ -n "$MESH_URL" ] || die "mesh enrollment returned no controller URL."
    set_env SERVERMIND_CONTROLLER "$MESH_URL"   # connect over the tunnel from now on
    set_env FLEET_ALLOW_INSECURE 1              # ws over WG is already encrypted
    ok "On the mesh — agent will reach the controller at $MESH_URL"
  fi

  step "Starting agent"
  pm2 reload ecosystem.agent.cjs --update-env >/dev/null 2>&1 \
    || pm2 start ecosystem.agent.cjs >/dev/null 2>&1 \
    || die "PM2 failed to start servermind-agent. Check: pm2 logs servermind-agent"
  pm2 save >/dev/null 2>&1 || true
  ok "Running under PM2 (servermind-agent)"

  printf "\n${G}${B}  ✓ ServerMind agent is running${N}\n\n"
  info "This box dials OUT to the controller — no inbound ports were opened."
  info "It appears in the controller's Fleet tab; manage & chat it from there."
  info ""
  info "  • Logs:           pm2 logs servermind-agent"
  info "  • Start on boot:  pm2 startup   (then run the command it prints)"
  info "  • Reconfigure:    re-run this installer with new --controller/--token"
  printf "\n"
  exit 0
fi

# ── 6. setup wizard (CONTROLLER) ────────────────────────────────────────────────
# Fresh install → run the wizard. Update (an .env already exists) → keep the
# existing config and skip it, so re-running the installer to update doesn't
# nag you through every question. Force it anytime with SERVERMIND_SETUP=1.
# curl | bash leaves stdin pointing at the script, so the interactive wizard
# must read from the controlling terminal.
step "Configuration"
if [ -f .env ] && [ "${SERVERMIND_SETUP:-}" != "1" ]; then
  ok "Existing .env found — keeping your settings (wizard skipped)."
  info "Change settings later:  cd $DIR && bun run setup"
  info "Or re-run the installer with:  SERVERMIND_SETUP=1 to force the wizard"
elif [ -e /dev/tty ]; then
  bun run setup < /dev/tty || die "Setup wizard did not complete. Re-run it with:  cd $DIR && bun run setup"
else
  warn "No terminal available — skipping the wizard."
  warn "Finish setup manually:  cd $DIR && bun run setup"
fi

# Fleet is ON by default: every install is the controller for its OWN box (a
# "fleet of one") and is ready to enroll more servers with no extra setup. If no
# join token exists yet, generate one now so the agent hub is live.
if ! grep -qE '^FLEET_JOIN_TOKEN=.+' .env 2>/dev/null; then
  set_env FLEET_JOIN_TOKEN "$(bun -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  chmod 600 .env 2>/dev/null || true
  ok "Fleet enabled (generated a join token)"
fi

# ── 6b. optional WireGuard mesh (controller) ────────────────────────────────────
# --mesh sets up a self-hosted WireGuard control plane: installs wireguard-tools
# and writes a tightly-scoped sudoers rule so the app can reload wg0 (and ONLY
# that). Needs root for those steps, so we escalate with sudo just for provisioning.
#
# The app runs under PM2 as the user running THIS installer, so the wg sudoers
# rule is scoped to that user. Install as a normal user for least privilege (the
# app gets only the wg reload right); a root install runs the app as root (wg
# works directly). For a dedicated service account, create it and run the
# installer as that user (so Bun/PM2 live in its home).
if [ -n "$MESH" ]; then
  step "Setting up WireGuard mesh"
  if [ "$(id -u)" = "0" ]; then SUDO=""; elif have sudo; then SUDO="sudo"; else die "--mesh needs root or sudo to install WireGuard + write the sudoers rule."; fi
  SM_USER="${SERVERMIND_USER:-$(id -un)}"
  $SUDO env SERVERMIND_USER="$SM_USER" bash "$DIR/scripts/setup-mesh-controller.sh" || die "mesh provisioning failed."
  set_env MESH_ENABLED 1
  # Agents reach the controller over the mesh (and the bootstrap enroll hop), so
  # it must NOT stay bound to loopback. Bind all interfaces unless the operator
  # already chose a specific reachable address (e.g. a Tailscale IP).
  CUR_BIND="$(get_env BIND_HOST)"
  if [ -z "$CUR_BIND" ] || [ "$CUR_BIND" = "127.0.0.1" ] || [ "$CUR_BIND" = "localhost" ]; then
    set_env BIND_HOST 0.0.0.0
    warn "Mesh: bound to 0.0.0.0 so agents can connect — keep the UI protected (login + a firewall, Tailscale, or HTTPS proxy)."
  fi
  [ -n "${MESH_CIDR:-}" ] && set_env MESH_CIDR "$MESH_CIDR"
  # Endpoint agents dial for the WireGuard handshake. Precedence: explicit
  # MESH_ENDPOINT → <domain>:51820 → auto-detected public IP → give up + warn.
  MESH_EP="${MESH_ENDPOINT:-}"
  [ -z "$MESH_EP" ] && [ -n "$(get_env SERVERMIND_DOMAIN)" ] && MESH_EP="$(get_env SERVERMIND_DOMAIN):51820"
  if [ -z "$MESH_EP" ]; then
    PUBIP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true)"
    PUBIP="$(printf '%s' "$PUBIP" | tr -d '[:space:]')"
    [ -n "$PUBIP" ] && { MESH_EP="$PUBIP:51820"; info "Auto-detected controller public IP: $PUBIP"; }
  fi
  [ -n "$MESH_EP" ] && set_env MESH_ENDPOINT "$MESH_EP"
  ok "Mesh ready — controller will bring up wg0 on start"
  [ -z "$MESH_EP" ] && warn "Could not determine a reachable address — set MESH_ENDPOINT=<public-host>:51820 in .env so agents can dial in."
fi

# ── 7. start under PM2 (CONTROLLER) ─────────────────────────────────────────────
step "Starting ServerMind"
pm2 reload ecosystem.config.cjs --update-env >/dev/null 2>&1 || pm2 start ecosystem.config.cjs >/dev/null 2>&1 || die "PM2 failed to start servermind. Check: pm2 logs servermind"
pm2 save >/dev/null 2>&1 || true
ok "Running under PM2"

# ── done ───────────────────────────────────────────────────────────────────────
PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)"; PORT="${PORT:-5500}"
HOST="$(grep -E '^BIND_HOST=' .env 2>/dev/null | cut -d= -f2 || true)"; HOST="${HOST:-127.0.0.1}"
DOMAIN="$(grep -E '^SERVERMIND_DOMAIN=' .env 2>/dev/null | cut -d= -f2 || true)"
TOKEN="$(get_env FLEET_JOIN_TOKEN)"
printf "\n${G}${B}  ✓ ServerMind is running${N}  on  ${B}http://%s:%s${N}\n\n" "$HOST" "$PORT"
info "Reaching the UI:"
if [ -n "$DOMAIN" ]; then
  info "  • Once your reverse proxy is live:  https://${DOMAIN}"
  info "  • Caddy snippet (auto-HTTPS):       reverse_proxy 127.0.0.1:${PORT}  (flush_interval -1 for SSE)"
else
  info "  • No domain? Tunnel from your laptop (nothing is exposed publicly):"
  info "      ssh -L ${PORT}:127.0.0.1:${PORT} ${USER:-<user>}@<this-server>   →   http://localhost:${PORT}"
  info "  • Or Tailscale (set BIND_HOST to the tailnet IP), or:  cloudflared tunnel --url http://127.0.0.1:${PORT}"
  info "  • Want a public domain later? Re-run setup and pick the HTTPS option."
fi
info ""
info "Add another server to this fleet (run this on that box):"
if [ -n "$DOMAIN" ]; then
  info "  curl -fsSL https://servermind.dev/install.sh | bash -s -- \\"
  info "    --controller wss://${DOMAIN}/fleet/agent --token ${TOKEN}"
else
  info "  curl -fsSL https://servermind.dev/install.sh | bash -s -- \\"
  info "    --controller wss://<this-controller-host>/fleet/agent --token ${TOKEN}"
  info "  (the controller must be reachable from that box — a domain, or a Tailscale/WireGuard address)"
fi
info ""
info "Also:"
info "  • Start on boot:        pm2 startup   (then run the command it prints)"
info "  • Logs:                 pm2 logs servermind"
info "  • Reconfigure anytime:  cd $DIR && bun run setup"
printf "\n"
