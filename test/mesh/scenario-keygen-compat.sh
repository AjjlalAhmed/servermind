#!/usr/bin/env bash
# Scenario: our Bun X25519 keygen is byte-identical to the real `wg` tool.
# A keypair only works in WireGuard if `wg pubkey` derives the SAME public key
# from our private key — this proves generateKeypair() is WireGuard-correct.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

echo "▸ scenario: keygen-compat (Bun keys vs real wg pubkey)"

KEYS="$(bun "$REPO/test/mesh/keygen-print.ts")"
PRIV="$(printf '%s\n' "$KEYS" | sed -n 1p)"
PUB="$(printf '%s\n' "$KEYS" | sed -n 2p)"

# Derive the pubkey from our priv using the genuine WireGuard tool.
WGPUB="$(docker run --rm alpine:3 sh -c "apk add -q wireguard-tools >/dev/null 2>&1 && printf '%s' '$PRIV' | wg pubkey")"

if [ "$PUB" = "$WGPUB" ]; then
  echo "  ✓ PASS — Bun pubkey == wg pubkey ($PUB)"
else
  echo "  ✗ FAIL — ours=$PUB  wg=$WGPUB"; exit 1
fi
