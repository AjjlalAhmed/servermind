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

printf "\n${A}${B}  ServerMind${N} ${D}— self-hosted AI for your Linux server${N}\n"

# ── 0. sanity ──────────────────────────────────────────────────────────────────
[ "$(uname -s)" = "Linux" ] || warn "ServerMind targets Linux; other systems are untested."
if [ "$(id -u)" = "0" ]; then
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
if [ -d "$DIR/.git" ]; then
  info "Updating existing install at $DIR"
  git -C "$DIR" fetch --prune origin && git -C "$DIR" reset --hard origin/main
  ok "Updated"
else
  info "Cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR" || die "Clone failed. If the repo is private, clone it manually (with a token) then re-run."
  ok "Cloned"
fi
cd "$DIR"

# ── 5. dependencies ────────────────────────────────────────────────────────────
step "Installing dependencies"
bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null 2>&1 || die "bun install failed."
mkdir -p logs
ok "Dependencies ready"

# ── 6. setup wizard ────────────────────────────────────────────────────────────
# curl | bash leaves stdin pointing at the script, so the interactive wizard must
# read from the controlling terminal.
step "Running setup wizard"
if [ -e /dev/tty ]; then
  bun run setup < /dev/tty || die "Setup wizard did not complete. Re-run it with:  cd $DIR && bun run setup"
else
  warn "No terminal available — skipping the wizard."
  warn "Finish setup manually:  cd $DIR && bun run setup"
fi

# ── 7. start under PM2 ─────────────────────────────────────────────────────────
step "Starting ServerMind"
pm2 reload ecosystem.config.cjs --update-env >/dev/null 2>&1 || pm2 start ecosystem.config.cjs >/dev/null 2>&1 || die "PM2 failed to start servermind. Check: pm2 logs servermind"
pm2 save >/dev/null 2>&1 || true
ok "Running under PM2"

# ── done ───────────────────────────────────────────────────────────────────────
PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)"; PORT="${PORT:-5500}"
HOST="$(grep -E '^BIND_HOST=' .env 2>/dev/null | cut -d= -f2 || true)"; HOST="${HOST:-127.0.0.1}"
DOMAIN="$(grep -E '^SERVERMIND_DOMAIN=' .env 2>/dev/null | cut -d= -f2 || true)"
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
info "Also:"
info "  • Start on boot:        pm2 startup   (then run the command it prints)"
info "  • Logs:                 pm2 logs servermind"
info "  • Reconfigure anytime:  cd $DIR && bun run setup"
printf "\n"
