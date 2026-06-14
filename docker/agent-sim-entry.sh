#!/usr/bin/env bash
# Sim agent entrypoint: start a couple of PM2 demo processes so the dashboard's
# PM2 panel shows real data, then run the ServerMind agent. (Sim only.)
set -e

pm2 start "node -e 'setInterval(function(){}, 1<<30)'" --name demo-api    >/dev/null 2>&1 || true
pm2 start "node -e 'setInterval(function(){}, 1<<30)'" --name demo-worker >/dev/null 2>&1 || true

exec bun run agent
