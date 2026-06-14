#!/usr/bin/env bash
# Scenario: the FULL controller app, end to end. Provision the mesh, boot the real
# ServerMind controller as the unprivileged `servermind` user, then enroll an
# agent through the actual HTTP /fleet/enroll endpoint and confirm the agent's
# WireGuard peer appears on the LIVE wg0 — proving the whole app-side path
# (boot bring-up → enroll endpoint → mesh apply) works together.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

echo "▸ scenario: app-enroll (real controller app, live wg0)"

docker run --rm --cap-add=NET_ADMIN --cap-add=SYS_MODULE -v "$REPO":/work:ro oven/bun:1.3.4 bash -c '
  set -e
  apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq curl >/dev/null 2>&1
  cp -r /work /app && cd /app

  # 1) provision mesh (servermind user, sudoers, wireguard-tools)
  bash scripts/setup-mesh-controller.sh >/dev/null

  # 2) minimal controller config (no auth needed — enroll is token-gated)
  cat > .env <<ENV
FLEET_JOIN_TOKEN=itest-join-token-0001
MESH_ENABLED=1
MESH_ENDPOINT=203.0.113.5:51820
BIND_HOST=127.0.0.1
PORT=5500
AI_BACKEND=openai
ENV
  bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null 2>&1
  mkdir -p data logs && chown -R servermind /app

  # 3) boot the REAL app as the unprivileged service user
  sudo -u servermind env PATH="$PATH" HOME=/app bun src/index.ts > /tmp/app.log 2>&1 &
  for i in $(seq 1 30); do curl -fsS http://127.0.0.1:5500/health >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS http://127.0.0.1:5500/health >/dev/null || { echo "  ✗ app did not start"; tail -20 /tmp/app.log; exit 1; }
  echo "  ✓ controller app booted as the servermind user"
  sudo -u servermind sudo -n wg show wg0 >/dev/null 2>&1 || { echo "  ✗ app did not bring up wg0"; tail -20 /tmp/app.log; exit 1; }
  echo "  ✓ app brought up wg0 on boot"

  # 4) enroll an agent through the real endpoint (agent keypair via the module)
  KP="$(bun test/mesh/keygen-print.ts)"; APUB="$(printf "%s\n" "$KP" | sed -n 2p)"
  RESP="$(curl -fsS -X POST http://127.0.0.1:5500/fleet/enroll -H "content-type: application/json" \
    -d "{\"token\":\"itest-join-token-0001\",\"agentId\":\"itest-agent-0001\",\"hostname\":\"vps-itest\",\"pubkey\":\"$APUB\"}")"
  echo "$RESP" | grep -q "10.99.0.2" || { echo "  ✗ enroll did not return an IP: $RESP"; exit 1; }
  echo "  ✓ /fleet/enroll returned an assigned IP (10.99.0.2)"

  # 5) the agent peer must now be LIVE on wg0. NOTE: the sudoers rule allows only
  # the exact "wg show wg0" (no extra args) — that tight scoping is the point — so
  # we grep its full output rather than "wg show wg0 peers".
  sudo -u servermind sudo -n wg show wg0 | grep -q "$APUB" \
    && echo "  ✓ agent peer is LIVE on wg0 (enroll → mesh apply works end to end)" \
    || { echo "  ✗ peer not on wg0"; sudo -u servermind sudo -n wg show wg0; exit 1; }

  # 6) negative: a wrong join token is rejected
  CODE="$(curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:5500/fleet/enroll \
    -H "content-type: application/json" -d "{\"token\":\"wrong\",\"agentId\":\"x2345678\",\"hostname\":\"h\",\"pubkey\":\"$APUB\"}")"
  [ "$CODE" = 401 ] && echo "  ✓ bad join token rejected (401)" || { echo "  ✗ bad token not rejected (got $CODE)"; exit 1; }

  echo "  ✓ PASS"
'
