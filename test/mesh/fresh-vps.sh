#!/usr/bin/env bash
#
# Fresh-VPS fleet, driven by the REAL installer. Tears down everything, then spins
# up clean Linux "VPS" containers and runs the actual install.sh on each — exactly
# what you'd run on real servers — to prove the whole flow end to end:
#
#   • controller:  install.sh --mesh
#   • each agent:  install.sh --controller ws://<ctrl>/fleet/agent --token <t> --mesh
#
# It uses your LOCAL working tree (SERVERMIND_SRC), so it tests uncommitted changes
# without pushing. Containers are left running so you can poke at them; re-run to
# start fresh, or `test/mesh/fresh-vps.sh down` to tear down.
#
#   test/mesh/fresh-vps.sh           # fresh fleet: 1 controller + AGENTS agents
#   AGENTS=3 test/mesh/fresh-vps.sh  # more agents
#   test/mesh/fresh-vps.sh down      # tear everything down
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
NET="sm-fleet"; CTRL="sm-ctrl"; IMG="oven/bun:1.3.4"; CAPS="--cap-add=NET_ADMIN --cap-add=SYS_MODULE"
AGENTS="${AGENTS:-2}"

names() { echo "$CTRL"; for i in $(seq 1 "$AGENTS"); do echo "sm-agent-$i"; done; }
teardown() { for n in $(docker ps -aq --filter "name=sm-ctrl" --filter "name=sm-agent-") ; do docker rm -f "$n" >/dev/null 2>&1 || true; done; docker network rm "$NET" >/dev/null 2>&1 || true; }

if [ "${1:-}" = "down" ]; then teardown; echo "torn down."; exit 0; fi

echo "═══ fresh-VPS fleet via the real installer (1 controller + $AGENTS agent(s)) ═══"
echo "· tearing down any existing fleet…"; teardown
docker network create "$NET" >/dev/null

# Stream the working tree (minus .git/.env) into the container, then run install.sh
# from it via SERVERMIND_SRC. Shared by controller + agents.
COPY_SRC='mkdir -p /src && tar -C /work --exclude=.git --exclude=.env -cf - . | tar -C /src -xf -'
PREP='apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq git curl sudo >/dev/null 2>&1'

# ── controller ──────────────────────────────────────────────────────────────────
echo "· starting controller (real install.sh --mesh)…"
docker run -d --name "$CTRL" --network "$NET" $CAPS -v "$REPO":/work:ro "$IMG" bash -c "
  set -e
  $PREP
  $COPY_SRC
  mkdir -p /opt/servermind && printf 'BIND_HOST=0.0.0.0\nPORT=5500\nAI_BACKEND=openai\n' > /opt/servermind/.env
  SERVERMIND_SRC=/src SERVERMIND_DIR=/opt/servermind MESH_ENDPOINT=$CTRL:51820 bash /work/install.sh --mesh
  echo '__CTRL_INSTALL_DONE__'
  sleep infinity
" >/dev/null

echo "· waiting for the controller app + wg0 (real install: bun+pm2+wireguard, ~3-5 min)…"
DEADLINE=$(( $(date +%s) + 420 ))
until docker exec "$CTRL" curl -fsS http://127.0.0.1:5500/health >/dev/null 2>&1; do
  if ! docker ps --filter "name=$CTRL" --format '{{.Names}}' | grep -q "$CTRL"; then echo "  ✗ controller container exited"; docker logs "$CTRL" 2>&1 | tail -30; exit 1; fi
  [ "$(date +%s)" -lt "$DEADLINE" ] || { echo "  ✗ controller did not come up in time"; docker logs "$CTRL" 2>&1 | grep -vE 'debconf|TERM|ReadLine|frontend|@INC|Term::' | tail -30; exit 1; }
  sleep 5
done
docker exec "$CTRL" sh -c 'sudo -n wg show wg0 >/dev/null 2>&1 || wg show wg0 >/dev/null 2>&1' || { echo "  ✗ controller wg0 not up"; exit 1; }
TOKEN="$(docker exec "$CTRL" sh -c "grep '^FLEET_JOIN_TOKEN=' /opt/servermind/.env | cut -d= -f2")"
echo "  ✓ controller up (install.sh --mesh), wg0 live, token=${TOKEN:0:12}…"

# ── agents ──────────────────────────────────────────────────────────────────────
ok=0
for i in $(seq 1 "$AGENTS"); do
  A="sm-agent-$i"
  echo "· starting $A (real install.sh --controller … --mesh)…"
  docker run -d --name "$A" --network "$NET" $CAPS -v "$REPO":/work:ro "$IMG" bash -c "
    set -e
    $PREP
    $COPY_SRC
    SERVERMIND_SRC=/src SERVERMIND_DIR=/opt/servermind bash /work/install.sh \
      --controller ws://$CTRL:5500/fleet/agent --token '$TOKEN' --mesh
    echo '__AGENT_INSTALL_DONE__'
    sleep infinity
  " >/dev/null
done

echo "· waiting for agents to enroll + connect over the mesh…"
for i in $(seq 1 "$AGENTS"); do
  A="sm-agent-$i"; DEADLINE=$(( $(date +%s) + 420 ))
  until docker exec "$A" curl -fsS --max-time 3 http://10.99.0.1:5500/health >/dev/null 2>&1; do
    if ! docker ps --filter "name=$A" --format '{{.Names}}' | grep -q "$A"; then echo "  ✗ $A exited"; docker logs "$A" 2>&1 | tail -25; break; fi
    [ "$(date +%s)" -lt "$DEADLINE" ] || { echo "  ✗ $A did not reach the controller over the mesh"; docker logs "$A" 2>&1 | grep -vE 'debconf|TERM|ReadLine|frontend|@INC|Term::' | tail -25; break; }
    sleep 5
  done
  if docker exec "$A" curl -fsS --max-time 3 http://10.99.0.1:5500/health >/dev/null 2>&1; then
    IP="$(docker exec "$A" sh -c 'ip -br addr show wg0 2>/dev/null | grep -o "10\.99\.0\.[0-9]*" | head -1' || true)"
    echo "  ✓ $A on the mesh — reaches controller at 10.99.0.1:5500 (agent ip ${IP:-?})"
    ok=$((ok+1))
  fi
done

echo "═══ result: $ok/$AGENTS agents live on the mesh ═══"
echo "inspect:  docker exec -it $CTRL sh   |   docker exec $CTRL sh -c 'wg show wg0'"
echo "teardown: test/mesh/fresh-vps.sh down"
[ "$ok" = "$AGENTS" ]
