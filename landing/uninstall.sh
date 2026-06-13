#!/usr/bin/env bash
#
# ServerMind uninstaller.  Usage:
#   curl -fsSL https://servermind.dev/uninstall.sh | bash
# or, from a cloned repo:
#   bun run uninstall          (same as: bash uninstall.sh)
#
# Removes the ServerMind PM2 process and — with your confirmation — the install
# directory (including its .env and logs). It does NOT remove Bun, PM2, or git,
# since you likely use those for other things (commands to remove them are
# printed at the end if you want to).
#
# Override defaults with env vars:
#   SERVERMIND_DIR=...     install directory (default: ~/servermind, or this repo)
#   SERVERMIND_FORCE=1     delete the directory without an interactive prompt

set -euo pipefail

# ── pretty output ──────────────────────────────────────────────────────────────
if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; A=$'\033[38;5;105m'; N=$'\033[0m'; else B= D= G= Y= R= A= N=; fi
step() { printf "\n${A}${B}▸ %s${N}\n" "$1"; }
info() { printf "  %s\n" "$1"; }
ok()   { printf "  ${G}✓${N} %s\n" "$1"; }
warn() { printf "  ${Y}!${N} %s\n" "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

# Make sure Bun/PM2 on PATH (installer puts them in ~/.bun/bin).
export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$HOME/.bun/bin:$PATH"

# Resolve the install directory: explicit override → this repo (if run locally) → ~/servermind.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "${SERVERMIND_DIR:-}" ]; then DIR="$SERVERMIND_DIR"
elif [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/ecosystem.config.cjs" ]; then DIR="$SCRIPT_DIR"
else DIR="$HOME/servermind"; fi

printf "\n${A}${B}  ServerMind uninstaller${N}\n"
info "Install directory: ${DIR}"

# ── 1. stop & remove the PM2 process ─────────────────────────────────────────────
step "Removing the ServerMind process"
if have pm2; then
  if pm2 describe servermind >/dev/null 2>&1; then
    pm2 delete servermind >/dev/null 2>&1 && ok "Stopped and deleted PM2 process 'servermind'"
    pm2 save >/dev/null 2>&1 || true   # persist removal so it doesn't come back on reboot
    ok "Updated PM2's saved process list"
  else
    warn "No PM2 process named 'servermind' — nothing to stop"
  fi
else
  warn "pm2 not found on PATH — skipping process removal"
fi

# ── 2. remove the install directory (contains .env + logs) ───────────────────────
step "Removing the install directory"
REMOVE=0
if [ ! -d "$DIR" ]; then
  warn "Directory not found: $DIR (already removed?)"
elif [ "${SERVERMIND_FORCE:-}" = "1" ]; then
  REMOVE=1
elif [ -e /dev/tty ]; then
  warn "This deletes $DIR including its .env (your password hash, 2FA secret, AI key) and logs."
  printf "  Delete it? [y/N] "
  read -r ans < /dev/tty || ans=""
  case "$ans" in [yY]|[yY][eE][sS]) REMOVE=1 ;; esac
else
  warn "Non-interactive shell — NOT deleting $DIR automatically."
  warn "Remove it yourself with:  rm -rf \"$DIR\"   (or re-run with SERVERMIND_FORCE=1)"
fi

if [ "$REMOVE" = "1" ]; then
  # refuse to delete obviously-wrong targets
  case "$DIR" in ""|"/"|"$HOME") warn "Refusing to delete '$DIR' — remove it manually." ;;
    *) rm -rf "$DIR" && ok "Deleted $DIR" ;;
  esac
fi

# ── done ─────────────────────────────────────────────────────────────────────────
printf "\n${G}${B}  ✓ ServerMind removed${N}\n\n"
info "Left in place on purpose (you may use them elsewhere):"
info "  • Bun, PM2 and git were not removed."
if have pm2; then
  info "  • If ServerMind was your only PM2 app and you set up boot-start, you can"
  info "    disable it with:  pm2 unstartup"
fi
info ""
info "To remove the shared tools too (optional):"
info "  • PM2:  bun remove -g pm2     (or: npm remove -g pm2)"
info "  • Bun:  rm -rf ~/.bun         (and remove the PATH line it added to your shell rc)"
printf "\n"
