#!/usr/bin/env bash
#
# ServerMind updater. Pulls the latest code into an existing install, reinstalls
# dependencies, and reloads the running process — WITHOUT re-running the setup
# wizard. Works for both roles (controller and fleet agent).
#
# Usage (from anywhere):
#   curl -fsSL https://servermind.dev/update.sh | bash
# or, from inside the install directory:
#   bash update.sh        # or:  bun run update
#
# Your config is safe: .env, data/ and logs/ are gitignored, so the update never
# overwrites them. Local edits to TRACKED source files are discarded (the box is
# reset to match the published code) — that's what "update" means here.
#
# Override defaults with env vars:
#   SERVERMIND_DIR=...     install directory (default: ~/servermind)
#   SERVERMIND_BRANCH=...  branch/ref to update to (default: the checked-out one)

set -euo pipefail

# ── pretty output (matches install.sh) ──────────────────────────────────────────
if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; A=$'\033[38;5;105m'; N=$'\033[0m'; else B= D= G= Y= R= A= N=; fi
step() { printf "\n${A}${B}▸ %s${N}\n" "$1"; }
info() { printf "  %s\n" "$1"; }
ok()   { printf "  ${G}✓${N} %s\n" "$1"; }
warn() { printf "  ${Y}!${N} %s\n" "$1"; }
die()  { printf "\n${R}✗ %s${N}\n" "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

printf "${A}${B}ServerMind updater${N}\n"

# ── locate the install ──────────────────────────────────────────────────────────
# Prefer the directory this script lives in IF it's a ServerMind checkout (so
# `bash update.sh` from a clone just works); otherwise fall back to the standard
# install dir. This makes the script identical for everyone, piped or local.
resolve_dir() {
  local self
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
    self="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
    if [ -d "$self/.git" ] && grep -q '"servermind"' "$self/package.json" 2>/dev/null; then
      printf '%s' "$self"; return
    fi
  fi
  printf '%s' "${SERVERMIND_DIR:-$HOME/servermind}"
}
DIR="$(resolve_dir)"

[ -d "$DIR" ] || die "No ServerMind install found at $DIR. Set SERVERMIND_DIR=/path, or install first: curl -fsSL https://servermind.dev/install.sh | bash"
[ -d "$DIR/.git" ] || die "$DIR is not a git checkout — can't update in place. Re-run the installer instead."
have git || die "git is required."

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"; export PATH="$BUN_INSTALL/bin:$PATH"
have bun || die "bun not found on PATH. Install it: curl -fsSL https://bun.sh/install | bash"

cd "$DIR"
info "Install dir: $DIR"

# ── pull the latest code ─────────────────────────────────────────────────────────
step "Fetching latest code"
BRANCH="${SERVERMIND_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
[ "$BRANCH" = "HEAD" ] && BRANCH="main"   # detached checkout → assume default branch
OLD="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"

git fetch --depth 1 origin "$BRANCH" >/dev/null 2>&1 || die "git fetch failed (branch '$BRANCH'). Check network / remote access."
git reset --hard "FETCH_HEAD" >/dev/null 2>&1 || die "git reset failed."
NEW="$(git rev-parse --short HEAD)"

if [ "$OLD" = "$NEW" ]; then
  ok "Already up to date ($NEW) — reloading anyway to apply any local restart."
else
  ok "Updated $OLD → $NEW (branch $BRANCH)"
  git --no-pager log --oneline "$OLD..$NEW" 2>/dev/null | sed 's/^/    /' || true
fi

# ── dependencies ──────────────────────────────────────────────────────────────────
step "Installing dependencies"
bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null 2>&1 || die "bun install failed."
ok "Dependencies in sync"

# ── reload the running process (auto-detect role) ──────────────────────────────────
step "Reloading ServerMind"
if ! have pm2; then
  warn "PM2 not found — code is updated, but restart the process yourself."
  exit 0
fi

# Agent installs run as 'servermind-agent' (ecosystem.agent.cjs); controllers as
# 'servermind' (ecosystem.config.cjs). Reload whichever is actually registered.
reloaded=""
if pm2 describe servermind-agent >/dev/null 2>&1; then
  pm2 reload ecosystem.agent.cjs --update-env >/dev/null 2>&1 && reloaded="servermind-agent (agent)"
elif pm2 describe servermind >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --update-env >/dev/null 2>&1 && reloaded="servermind (controller)"
else
  warn "No ServerMind PM2 process found. Start it with:  pm2 start ecosystem.config.cjs   (controller)"
  exit 0
fi

[ -n "$reloaded" ] || die "PM2 reload failed. Check: pm2 logs"
pm2 save >/dev/null 2>&1 || true
ok "Reloaded $reloaded — now running $NEW"

printf "\n${G}${B}✓ Update complete.${N}  Logs: ${D}pm2 logs${N}\n"
