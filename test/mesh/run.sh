#!/usr/bin/env bash
# Run every WireGuard mesh container scenario. Requires Docker.
#
#   test/mesh/run.sh              # all scenarios, all distros
#   test/mesh/run.sh quick        # skip the slow multi-distro matrix
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:-full}"

# Distros covering every package manager: apt (ubuntu/debian), dnf (fedora),
# apk (alpine). yum is covered by dnf's code path.
DISTROS="ubuntu:24.04 debian:12 fedora:41 alpine:3"
[ "$MODE" = "quick" ] && DISTROS="ubuntu:24.04 alpine:3"

pass=0; fail=0
run() { if "$@"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  ‼ scenario failed: $*"; fi; echo; }

echo "═══ ServerMind mesh scenarios ═══"
run bash "$HERE/scenario-keygen-compat.sh"
run bash "$HERE/scenario-config-apply.sh"
for d in $DISTROS; do
  run bash "$HERE/scenario-controller-setup.sh" "$d"
done
run bash "$HERE/scenario-app-enroll.sh"

echo "═══ done: ${pass} passed, ${fail} failed ═══"
[ "$fail" = 0 ]
