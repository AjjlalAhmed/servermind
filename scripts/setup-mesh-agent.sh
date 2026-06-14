#!/usr/bin/env bash
#
# Agent-side WireGuard mesh setup. Called by install.sh when an agent install adds
# --mesh. Installs WireGuard, enrolls THIS box with the controller (generating its
# keypair locally — private key never leaves), brings up the tunnel, and prints
# the controller's MESH ws URL on stdout for the installer to wire in.
#
# All logs go to stderr; stdout is exactly the mesh URL.
#
# Env (passed by install.sh):
#   SERVERMIND_CONTROLLER  public wss URL of the controller (for the enroll hop)
#   FLEET_JOIN_TOKEN       join token
#   SERVERMIND_AGENT_ID    optional stable id
#   BUN_BIN                path to bun (root may not have it on PATH)
#   WG_DIR, WG_IFACE       optional overrides
set -euo pipefail

WG_DIR="${WG_DIR:-/etc/wireguard}"
WG_IFACE="${WG_IFACE:-wg0}"
BUN="${BUN_BIN:-bun}"
HERE="$(cd "$(dirname "$0")" && pwd)"

log() { printf '  [mesh] %s\n' "$1" >&2; }
die() { printf '\n  agent mesh setup failed: %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "must run as root (the installer escalates with sudo)."
command -v "$BUN" >/dev/null 2>&1 || die "bun not found (pass BUN_BIN=\$(command -v bun))."

# ── 1. packages ─────────────────────────────────────────────────────────────────
log "installing wireguard-tools + iproute…"
if   command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq wireguard-tools iproute2 >/dev/null
elif command -v dnf     >/dev/null 2>&1; then dnf install -y -q wireguard-tools iproute >/dev/null
elif command -v yum     >/dev/null 2>&1; then yum install -y -q wireguard-tools iproute >/dev/null
elif command -v apk     >/dev/null 2>&1; then apk add --quiet wireguard-tools iproute2
else die "no supported package manager (apt/dnf/yum/apk) found."; fi

# ── 2. enroll (keypair local, pubkey-only to controller) + write wg0.conf ───────
log "enrolling with the controller…"
MESH_URL="$(WG_DIR="$WG_DIR" WG_IFACE="$WG_IFACE" "$BUN" "$HERE/agent-enroll.ts")" \
  || die "enrollment failed (is the controller reachable + the token correct?)."
[ -n "$MESH_URL" ] || die "controller did not return a mesh URL."

# ── 3. bring the tunnel up + persist across reboots ─────────────────────────────
log "bringing up $WG_IFACE…"
wg-quick down "$WG_IFACE" >/dev/null 2>&1 || true   # idempotent
wg-quick up "$WG_IFACE" >/dev/null 2>&1 || die "wg-quick up $WG_IFACE failed (kernel WireGuard available?)."
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable "wg-quick@$WG_IFACE" >/dev/null 2>&1 || log "could not enable wg on boot via systemd — bring it up manually after reboot."
else
  log "no systemd: ensure '$WG_IFACE' is brought up on boot (wg-quick up $WG_IFACE)."
fi
log "tunnel up; controller reachable over the mesh at $MESH_URL"

# stdout = the mesh URL only
printf '%s' "$MESH_URL"
