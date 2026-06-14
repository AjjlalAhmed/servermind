#!/usr/bin/env bash
# Scenario: a config rendered by the REAL module is accepted by genuine WireGuard
# on a LIVE interface — both the wg-quick bring-up form and the stripped
# `wg syncconf` reload form — and live peer add/remove works with no bounce.
#
# This is the test that caught the `Address` / syncconf incompatibility.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

echo "▸ scenario: config-apply (rendered config on a live wg0)"

docker run --rm --cap-add=NET_ADMIN --cap-add=SYS_MODULE -v "$REPO":/work oven/bun:1.3.4 bash -c '
  set -e
  apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq wireguard-tools iproute2 >/dev/null 2>&1
  bun /work/test/mesh/render-config.ts      > /etc/wireguard/wg0.conf   # disk form (with Address)
  bun /work/test/mesh/render-config.ts sync > /etc/wireguard/wg0.sync   # native form (for syncconf)

  wg-quick up wg0 >/dev/null
  [ "$(ip -br addr show wg0 | grep -c 10.99.0.1/24)" = 1 ] || { echo "  ✗ address not set"; exit 1; }
  echo "  ✓ wg-quick up accepted the disk config (Address set)"

  wg syncconf wg0 /etc/wireguard/wg0.sync
  P="$(wg show wg0 peers | grep -c .)"
  [ "$P" = 2 ] || { echo "  ✗ expected 2 peers, got $P"; exit 1; }
  echo "  ✓ wg syncconf accepted the stripped config (2 peers live)"

  # Live revoke: drop one peer block, reload, expect the live set to shrink.
  head -n -4 /etc/wireguard/wg0.sync > /etc/wireguard/wg0.one
  wg syncconf wg0 /etc/wireguard/wg0.one
  P2="$(wg show wg0 peers | grep -c .)"
  [ "$P2" = 1 ] || { echo "  ✗ expected 1 peer after revoke, got $P2"; exit 1; }
  echo "  ✓ live revoke shrank the peer set (2 → 1) with no interface bounce"

  wg-quick down wg0 >/dev/null 2>&1 || true
  echo "  ✓ PASS"
'
