#!/usr/bin/env bash
# Scenario: a real TWO-BOX fleet over WireGuard. A controller container and an
# agent container on a shared Docker network, each with a live wg0:
#   1. controller provisions the mesh + boots the real app (wg0 up)
#   2. agent runs the real `setup-mesh-agent.sh`: enrolls (pubkey-only), writes its
#      wg0.conf, brings up its tunnel
#   3. the agent reaches the controller's APP over the mesh (curl the controller's
#      mesh IP) — proving the encrypted tunnel + end-to-end path actually work
#
# This is the closest thing to two real VPSes without two real VPSes.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
NET="sm-mesh-test"; CTRL="sm-ctrl"; TOKEN="twobox-join-token-001"; IMG="oven/bun:1.3.4"
CAPS="--cap-add=NET_ADMIN --cap-add=SYS_MODULE"

echo "▸ scenario: two-box (controller + agent over live WireGuard)"

cleanup() { docker rm -f "$CTRL" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker network create "$NET" >/dev/null

# ── controller: provision + boot the real app, bound to 0.0.0.0, endpoint = its
# name on the docker network so the agent can reach its UDP 51820 ───────────────
docker run -d --name "$CTRL" --network "$NET" $CAPS -v "$REPO":/work:ro "$IMG" bash -c '
  set -e
  apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq curl >/dev/null 2>&1
  cp -r /work /app && cd /app
  bash scripts/setup-mesh-controller.sh >/dev/null 2>&1
  cat > .env <<ENV
FLEET_JOIN_TOKEN='"$TOKEN"'
MESH_ENABLED=1
MESH_ENDPOINT='"$CTRL"':51820
BIND_HOST=0.0.0.0
PORT=5500
AI_BACKEND=openai
ENV
  bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null 2>&1
  mkdir -p data logs && chown -R servermind /app
  exec sudo -u servermind env PATH="$PATH" HOME=/app bun src/index.ts
' >/dev/null

echo "  · waiting for the controller app + wg0 (first boot installs packages, ~2-3 min)…"
DEADLINE=$(( $(date +%s) + 300 ))
until docker exec "$CTRL" curl -fsS http://127.0.0.1:5500/health >/dev/null 2>&1; do
  [ "$(date +%s)" -lt "$DEADLINE" ] || { echo "  ✗ controller did not come up"; docker logs "$CTRL" 2>&1 | grep -vE "debconf|TERM|ReadLine|frontend|@INC|Term::" | tail -25; exit 1; }
  sleep 3
done
docker exec "$CTRL" sudo -u servermind sudo -n wg show wg0 >/dev/null 2>&1 || { echo "  ✗ controller wg0 not up"; exit 1; }
echo "  ✓ controller app up, wg0 live, endpoint ${CTRL}:51820"

# ── agent: run the REAL agent mesh setup, then prove it reaches the controller
# over the tunnel ───────────────────────────────────────────────────────────────
docker run --rm --name sm-agent --network "$NET" $CAPS -v "$REPO":/work:ro "$IMG" bash -c '
  set -e
  cp -r /work /app && cd /app
  apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq curl iproute2 >/dev/null 2>&1
  bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null 2>&1

  # The real agent provisioning: install wg, enroll, bring up the tunnel.
  # ws:// (not wss) because the test controller serves plain HTTP — no TLS/proxy.
  # In production the public controller URL is wss:// and enroll uses https://.
  MESH_URL="$(BUN_BIN="$(command -v bun)" \
    SERVERMIND_CONTROLLER="ws://'"$CTRL"':5500/fleet/agent" \
    FLEET_JOIN_TOKEN="'"$TOKEN"'" \
    bash scripts/setup-mesh-agent.sh)"
  echo "  · agent enrolled; mesh URL = $MESH_URL"
  [ "$MESH_URL" = "ws://10.99.0.1:5500/fleet/agent" ] || { echo "  ✗ unexpected mesh URL: $MESH_URL"; exit 1; }

  echo "  · agent wg0:"; wg show wg0 | sed "s/^/      /"
  # The payoff: reach the controllers APP across the encrypted tunnel.
  for i in $(seq 1 10); do curl -fsS http://10.99.0.1:5500/health >/dev/null 2>&1 && break || sleep 1; done
  curl -fsS http://10.99.0.1:5500/health >/dev/null 2>&1 \
    && echo "  ✓ agent reached the controller APP over the mesh (10.99.0.1:5500)" \
    || { echo "  ✗ agent could NOT reach the controller over the mesh"; wg show wg0; exit 1; }
'

echo "  ✓ PASS — two boxes, one fleet, over WireGuard"
