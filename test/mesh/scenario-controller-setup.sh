#!/usr/bin/env bash
# Scenario: run setup-mesh-controller.sh on a given distro, then prove:
#   • prerequisites installed (wg, wg-quick, sudo), service user created
#   • the sudoers rule is valid and lets the app do EXACTLY its job:
#       - write configs as the unprivileged user, bring up + syncconf wg0
#   • the sudoers rule BLOCKS everything else (no shell, no other file, no other
#     interface) — the least-privilege containment actually holds
#
# Usage: scenario-controller-setup.sh <docker-image>   e.g. ubuntu:24.04
set -euo pipefail
IMG="${1:?usage: scenario-controller-setup.sh <docker-image>}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

echo "▸ scenario: controller-setup on ${IMG}"

docker run --rm --cap-add=NET_ADMIN --cap-add=SYS_MODULE -v "$REPO":/work:ro "$IMG" sh -c '
  set -e
  # The installer requires bash; minimal images (Alpine) need it added first.
  command -v bash >/dev/null 2>&1 || (command -v apk >/dev/null 2>&1 && apk add --quiet bash) || true

  bash /work/scripts/setup-mesh-controller.sh

  # ── prerequisites ──────────────────────────────────────────────────────────
  command -v wg       >/dev/null || { echo "  ✗ wg missing";       exit 1; }
  command -v wg-quick >/dev/null || { echo "  ✗ wg-quick missing"; exit 1; }
  command -v sudo     >/dev/null || { echo "  ✗ sudo missing";     exit 1; }
  id servermind       >/dev/null || { echo "  ✗ servermind user missing"; exit 1; }
  [ -f /etc/sudoers.d/servermind-wg ] || { echo "  ✗ sudoers rule missing"; exit 1; }
  echo "  ✓ packages + user + sudoers present"

  # ── POSITIVE: the app (as servermind) can do exactly its job ───────────────
  sudo -u servermind sh -c '"'"'
    set -e
    PRIV=$(wg genkey)
    printf "[Interface]\nAddress = 10.99.0.1/24\nListenPort = 51820\nPrivateKey = %s\n" "$PRIV" > /etc/wireguard/wg0.conf
    printf "[Interface]\nListenPort = 51820\nPrivateKey = %s\n" "$PRIV" > /etc/wireguard/wg0.sync
    sudo -n wg-quick up wg0 >/dev/null 2>&1
    sudo -n wg syncconf wg0 /etc/wireguard/wg0.sync
    sudo -n wg show wg0 >/dev/null
  '"'"' || { echo "  ✗ servermind could not perform its allowed mesh actions"; exit 1; }
  echo "  ✓ servermind can write configs + bring up/syncconf wg0 (its job)"

  # ── NEGATIVE: the rule must block everything else ──────────────────────────
  fail=0
  sudo -u servermind sh -c "sudo -n cat /etc/shadow"      >/dev/null 2>&1 && { echo "  ✗ LEAK: read /etc/shadow"; fail=1; }
  sudo -u servermind sh -c "sudo -n /bin/sh -c id"        >/dev/null 2>&1 && { echo "  ✗ LEAK: got a root shell"; fail=1; }
  sudo -u servermind sh -c "sudo -n wg-quick up wg1"      >/dev/null 2>&1 && { echo "  ✗ LEAK: brought up another interface"; fail=1; }
  sudo -u servermind sh -c "sudo -n wg set wg0 listen-port 1" >/dev/null 2>&1 && { echo "  ✗ LEAK: ran an unlisted wg subcommand"; fail=1; }
  [ "$fail" = 0 ] || exit 1
  echo "  ✓ sudoers blocks shell / arbitrary files / other interfaces (no escalation)"

  sudo -u servermind sh -c "sudo -n wg-quick down wg0" >/dev/null 2>&1 || true
  echo "  ✓ PASS — ${0}"
' 2>&1 | sed "s/\${0}/${IMG}/"
