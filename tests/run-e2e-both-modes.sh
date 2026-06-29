#!/usr/bin/env bash
# Run e2e session provisioning tests for both pod mode and gateway mode.
# Strategy: deploy all components from Quay.io, then reload only the
# control plane from a local build so we exercise our specific changes
# without hitting pre-existing build failures in other components.
#
# Usage: ./tests/run-e2e-both-modes.sh

set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER_ENGINE="${CONTAINER_ENGINE:-podman}"

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

PHASE1_RESULT="PENDING"
PHASE2_RESULT="PENDING"

banner() { echo ""; echo -e "${BOLD}════════════════════════════════════════${NC}"; echo -e "${BOLD} $1${NC}"; echo -e "${BOLD}════════════════════════════════════════${NC}"; echo ""; }

teardown() {
  echo ""
  echo "▶ Tearing down kind cluster..."
  make kind-down CONTAINER_ENGINE="$CONTAINER_ENGINE" 2>&1 || true
}

get_token_and_port() {
  unset TEST_TOKEN KIND_FWD_API_SERVER_PORT
  # Re-source the freshly-written .env.test
  if [ -f e2e/.env.test ]; then
    # shellcheck disable=SC1091
    source e2e/.env.test
  fi
  TEST_TOKEN="${TEST_TOKEN:-$(kubectl get secret test-user-token -n ambient-code \
    -o jsonpath='{.data.token}' 2>/dev/null | base64 -d)}"
  KIND_FWD_API_SERVER_PORT="${KIND_FWD_API_SERVER_PORT:-12269}"
  export TEST_TOKEN KIND_FWD_API_SERVER_PORT
}

# The Quay.io-based 'kind' overlay sets imagePullPolicy: Always on the CP.
# Patch it to IfNotPresent first so the locally-loaded image is used instead of
# the kubelet trying (and failing) to pull localhost/<image> from a registry.
patch_cp_pull_policy() {
  echo "  Patching CP imagePullPolicy → IfNotPresent..."
  kubectl patch deployment ambient-control-plane -n ambient-code \
    -p '{"spec":{"template":{"spec":{"containers":[{"name":"ambient-control-plane","imagePullPolicy":"IfNotPresent"}]}}}}' \
    >/dev/null
  kubectl rollout status deployment/ambient-control-plane \
    -n ambient-code --timeout=90s >/dev/null
  echo "  CP imagePullPolicy patched."
}

# ─── Phase 1: Pod mode (OPENSHELL_USE_GATEWAY=false) ─────────────────────────

banner "Phase 1: Pod mode (OPENSHELL_USE_GATEWAY=false)"

echo "▶ Starting kind cluster (Quay.io images)..."
if make kind-up CONTAINER_ENGINE="$CONTAINER_ENGINE" 2>&1; then
  echo -e "${GREEN}✓ kind-up complete${NC}"

  patch_cp_pull_policy

  echo "▶ Rebuilding and reloading control plane from local source..."
  if make kind-reload-ambient-control-plane CONTAINER_ENGINE="$CONTAINER_ENGINE" 2>&1; then
    echo -e "${GREEN}✓ Control plane reloaded${NC}"

    get_token_and_port
    API_URL="http://localhost:${KIND_FWD_API_SERVER_PORT}"

    echo "▶ Starting port-forward..."
    kubectl port-forward -n ambient-code svc/ambient-api-server \
      "${KIND_FWD_API_SERVER_PORT}:8000" >/dev/null 2>&1 &
    PF1_PID=$!
    sleep 3

    echo "▶ Running pod-mode session test against $API_URL..."
    if TEST_TOKEN="$TEST_TOKEN" API_URL="$API_URL" ./tests/pod-mode-session.sh 2>&1; then
      PHASE1_RESULT="PASSED"
      echo -e "${GREEN}✓ Phase 1 PASSED${NC}"
    else
      PHASE1_RESULT="FAILED"
      echo -e "${RED}✗ Phase 1 FAILED${NC}"
    fi
    kill "$PF1_PID" 2>/dev/null || true
  else
    PHASE1_RESULT="FAILED (CP build error)"
    echo -e "${RED}✗ Control plane rebuild failed${NC}"
  fi
else
  PHASE1_RESULT="FAILED (kind-up error)"
  echo -e "${RED}✗ kind-up failed for pod mode${NC}"
fi

teardown

# ─── Phase 2: Gateway mode (OPENSHELL_USE_GATEWAY=true) ──────────────────────

banner "Phase 2: Gateway mode (OPENSHELL_USE_GATEWAY=true)"

echo "▶ Starting kind cluster (Quay.io images + gateway prerequisites)..."
if make kind-up OPENSHELL_USE_GATEWAY=true CONTAINER_ENGINE="$CONTAINER_ENGINE" 2>&1; then
  echo -e "${GREEN}✓ kind-up complete (gateway prereqs installed, CP patched)${NC}"

  patch_cp_pull_policy

  echo "▶ Rebuilding and reloading control plane from local source..."
  if make kind-reload-ambient-control-plane CONTAINER_ENGINE="$CONTAINER_ENGINE" 2>&1; then
    echo -e "${GREEN}✓ Control plane reloaded${NC}"

    # Restore OPENSHELL_USE_GATEWAY=true — kind-reload restarts the pod but
    # doesn't re-apply the env patch from setup-kind-openshell.sh.
    kubectl set env deployment/ambient-control-plane \
      -n ambient-code OPENSHELL_USE_GATEWAY=true >/dev/null
    kubectl rollout status deployment/ambient-control-plane \
      -n ambient-code --timeout=120s >/dev/null
    echo "  OPENSHELL_USE_GATEWAY=true confirmed on reloaded CP"

    get_token_and_port
    API_URL="http://localhost:${KIND_FWD_API_SERVER_PORT}"

    echo "▶ Starting port-forward..."
    kubectl port-forward -n ambient-code svc/ambient-api-server \
      "${KIND_FWD_API_SERVER_PORT}:8000" >/dev/null 2>&1 &
    PF2_PID=$!
    sleep 3

    echo "▶ Running dual-tenant gateway test against $API_URL..."
    if TEST_TOKEN="$TEST_TOKEN" API_URL="$API_URL" ./tests/openshell-dual-tenant.sh 2>&1; then
      PHASE2_RESULT="PASSED"
      echo -e "${GREEN}✓ Phase 2 PASSED${NC}"
    else
      PHASE2_RESULT="FAILED"
      echo -e "${RED}✗ Phase 2 FAILED${NC}"
    fi
    kill "$PF2_PID" 2>/dev/null || true
  else
    PHASE2_RESULT="FAILED (CP build error)"
    echo -e "${RED}✗ Control plane rebuild failed${NC}"
  fi
else
  PHASE2_RESULT="FAILED (kind-up error)"
  echo -e "${RED}✗ kind-up failed for gateway mode${NC}"
fi

teardown

# ─── Combined summary ─────────────────────────────────────────────────────────

banner "Combined Results"
if [ "$PHASE1_RESULT" = "PASSED" ]; then
  echo -e "  Phase 1 (pod mode):     ${GREEN}PASSED${NC}"
else
  echo -e "  Phase 1 (pod mode):     ${RED}${PHASE1_RESULT}${NC}"
fi
if [ "$PHASE2_RESULT" = "PASSED" ]; then
  echo -e "  Phase 2 (gateway mode): ${GREEN}PASSED${NC}"
else
  echo -e "  Phase 2 (gateway mode): ${RED}${PHASE2_RESULT}${NC}"
fi
echo ""

[ "$PHASE1_RESULT" = "PASSED" ] && [ "$PHASE2_RESULT" = "PASSED" ]
