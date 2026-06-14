#!/usr/bin/env bash
#
# Controller-side WireGuard mesh provisioning. Called by install.sh when --mesh
# is set. Sets up ONLY the OS prerequisites; the running ServerMind app owns key
# generation, rendering wg0.conf, and bringing the interface up on boot (via the
# scoped sudoers rule below). Keeping bring-up in the app means we need no systemd
# wg unit — so this works the same on systemd and non-systemd (Alpine) hosts.
#
# Idempotent: safe to re-run on every update.
#
# Env:
#   SERVERMIND_USER   service user to create/own the mesh   (default: servermind)
#   WG_DIR            wireguard config dir                  (default: /etc/wireguard)
#   WG_IFACE          interface name                        (default: wg0)
set -euo pipefail

SM_USER="${SERVERMIND_USER:-servermind}"
WG_DIR="${WG_DIR:-/etc/wireguard}"
WG_IFACE="${WG_IFACE:-wg0}"

log() { printf '  [mesh] %s\n' "$1"; }
die() { printf '\n  mesh setup failed: %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "must run as root (the installer escalates with sudo for this step)."

# ── 1. packages: wireguard-tools + sudo + iproute ───────────────────────────────
log "installing wireguard-tools, sudo, iproute…"
if   command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq wireguard-tools sudo iproute2 >/dev/null
elif command -v dnf     >/dev/null 2>&1; then dnf install -y -q wireguard-tools sudo iproute >/dev/null
elif command -v yum     >/dev/null 2>&1; then yum install -y -q wireguard-tools sudo iproute >/dev/null
elif command -v apk     >/dev/null 2>&1; then apk add --quiet wireguard-tools sudo iproute2
else die "no supported package manager (apt/dnf/yum/apk) found."; fi

WG_BIN="$(command -v wg || true)";       [ -n "$WG_BIN" ] || die "wg not found after install."
WGQ_BIN="$(command -v wg-quick || true)"; [ -n "$WGQ_BIN" ] || die "wg-quick not found after install."

# ── 2. service user (no login, no shell) ────────────────────────────────────────
if id "$SM_USER" >/dev/null 2>&1; then
  log "user '$SM_USER' already exists"
else
  # nologin lives in different places per distro (/usr/sbin on Debian, /sbin on
  # others, sometimes absent in minimal images) — detect it, fall back to false.
  NOLOGIN="$(command -v nologin 2>/dev/null || true)"
  for c in /usr/sbin/nologin /sbin/nologin; do [ -n "$NOLOGIN" ] && break; [ -x "$c" ] && NOLOGIN="$c"; done
  [ -n "$NOLOGIN" ] && [ -x "$NOLOGIN" ] || NOLOGIN="/bin/false"
  log "creating system user '$SM_USER' (shell: $NOLOGIN)"
  if   command -v useradd >/dev/null 2>&1; then useradd --system --no-create-home --shell "$NOLOGIN" "$SM_USER"
  elif command -v adduser >/dev/null 2>&1; then adduser -S -D -H -s "$NOLOGIN" "$SM_USER"   # busybox/Alpine
  else die "no useradd/adduser available to create the service user."; fi
fi

# ── 3. config dir + files owned by the service user ─────────────────────────────
# The app writes wg0.conf / wg0.sync as $SM_USER (no privilege needed); only the
# reload is privileged. So $SM_USER must OWN the dir + files; root still reads
# them fine when wg-quick runs via sudo.
log "preparing $WG_DIR (owned by $SM_USER)"
mkdir -p "$WG_DIR"
touch "$WG_DIR/$WG_IFACE.conf" "$WG_DIR/$WG_IFACE.sync"
chown -R "$SM_USER" "$WG_DIR"
chmod 700 "$WG_DIR"
chmod 600 "$WG_DIR/$WG_IFACE.conf" "$WG_DIR/$WG_IFACE.sync"

# ── 4. the scoped sudoers rule (the ONLY privilege the app gets) ─────────────────
# Exact argv only: the app may reload/raise/lower THIS interface and read its
# status — and nothing else. No shell, no other command, no other interface.
SUDOERS="/etc/sudoers.d/servermind-wg"
log "writing scoped sudoers rule → $SUDOERS"
cat > "$SUDOERS" <<EOF
# Managed by ServerMind. Lets '$SM_USER' reload WireGuard '$WG_IFACE' — nothing else.
$SM_USER ALL=(root) NOPASSWD: $WG_BIN syncconf $WG_IFACE $WG_DIR/$WG_IFACE.sync, $WGQ_BIN up $WG_IFACE, $WGQ_BIN down $WG_IFACE, $WG_BIN show $WG_IFACE
EOF
chmod 440 "$SUDOERS"
# Validate; a malformed sudoers file is dangerous, so remove it and fail if bad.
if command -v visudo >/dev/null 2>&1; then
  visudo -cf "$SUDOERS" >/dev/null || { rm -f "$SUDOERS"; die "generated sudoers rule failed validation."; }
fi

log "controller mesh prerequisites ready (user=$SM_USER, iface=$WG_IFACE)"
log "the app brings up $WG_IFACE on boot; enroll agents from the Fleet tab."
