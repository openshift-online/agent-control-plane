#!/usr/bin/env bash
# E2E test: gateway route exposure on OpenShift
#
# Validates OpenShift Route provisioning for gateways:
#   1. Route creation when gateway has route: {}
#   2. Route address populated from Route status
#   3. setup-cli uses route address by default
#   4. Route removal when route field is cleared
#
# Prerequisites:
#   - CRC (OpenShift Local) running with ACP deployed (make crc-up)
#   - acpctl built (make build-cli)
#   - oc CLI available and logged in
#
# Usage:
#   ./tests/e2e/route-e2e-test.sh [--skip-cleanup] [API_URL]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

NAMESPACE="${NAMESPACE:-ambient-code}"
TIMESTAMP="$(date +%s)"
TENANT="route-e2e-${TIMESTAMP}"
GW_NAME="route-gw-${TIMESTAMP}"
SKIP_CLEANUP=false

while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --skip-cleanup) SKIP_CLEANUP=true; shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

if [ -z "${API_URL:-}" ]; then
  API_ROUTE_HOST=$(oc get route ambient-api-server -n "$NAMESPACE" -o jsonpath='{.spec.host}' 2>/dev/null || true)
  if [ -n "$API_ROUTE_HOST" ]; then
    API_URL="https://${API_ROUTE_HOST}"
  else
    echo "ERROR: No API server route found. Is ACP deployed to CRC? (make crc-up)"
    exit 1
  fi
fi

ACPCTL=""
if command -v acpctl &>/dev/null; then
  ACPCTL=acpctl
elif [ -x "$REPO_ROOT/components/ambient-cli/acpctl" ]; then
  ACPCTL="$REPO_ROOT/components/ambient-cli/acpctl"
fi
if [ -z "$ACPCTL" ]; then
  echo "ERROR: acpctl not found. Run: make build-cli"
  exit 1
fi

ACPCTL="$ACPCTL --insecure-skip-tls-verify"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
ORANGE='\033[38;5;214m'
NC='\033[0m'

PASSED=0
FAILED=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILED=$((FAILED + 1)); }
skip() { echo -e "  ${YELLOW}⊘${NC} $1 (skipped: $2)"; }
section() { echo ""; echo -e "${BOLD}$1${NC}"; }

CMD_OUTPUT=""
CMD_RC=0
run_cmd() {
  CMD_RC=0
  echo ""
  printf '  %b▶%b  %b$ %s%b\n' "${BOLD}" "${NC}" "${ORANGE}" "$*" "${NC}"
  CMD_OUTPUT=$("$@" 2>&1) || CMD_RC=$?
  if [ -n "$CMD_OUTPUT" ]; then
    echo "$CMD_OUTPUT" | head -20 | sed 's/^/    /'
  fi
  echo ""
}

cleanup() {
  if [ "$SKIP_CLEANUP" = "true" ]; then
    echo "Skipping cleanup (--skip-cleanup)"
    return
  fi
  echo "Cleaning up..."
  run_cmd $ACPCTL delete gateway $GW_NAME
  run_cmd $ACPCTL delete project "$TENANT" -y
}
trap cleanup EXIT

echo "=== Gateway Route E2E Tests ==="
echo "API: $API_URL"
echo ""

# Setup: create project and gateway with route
echo "--- Setup ---"
run_cmd $ACPCTL config set api_url "$API_URL"

# Get token from Keycloak via password grant (curl bypasses TLS issues with self-signed certs)
run_cmd oc get route keycloak -n "$NAMESPACE" -o jsonpath='{.spec.host}'
KC_ROUTE_HOST=""
if [ "$CMD_RC" -eq 0 ]; then
  KC_ROUTE_HOST="${CMD_OUTPUT:-}"
fi
if [ -n "$KC_ROUTE_HOST" ] && [ -z "${AMBIENT_TOKEN:-}" ]; then
  AMBIENT_TOKEN=$(curl -sk -X POST "https://${KC_ROUTE_HOST}/realms/ambient-code/protocol/openid-connect/token" \
    -d "grant_type=password" \
    -d "client_id=openshell-cli" \
    -d "username=developer" \
    -d "password=developer" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || true)
  if [ -n "$AMBIENT_TOKEN" ]; then
    export AMBIENT_TOKEN
    echo "Authenticated via Keycloak password grant"
  else
    echo "Warning: failed to get token from Keycloak"
  fi
fi

echo ""
printf '  %b▶%b  %b$ %s%b\n' "${BOLD}" "${NC}" "${ORANGE}" "acpctl apply -f - <<YAML (Project: $TENANT)" "${NC}"
CMD_RC=0
CMD_OUTPUT=$($ACPCTL apply -f - <<YAML 2>&1
kind: Project
name: $TENANT
YAML
) || CMD_RC=$?
if [ -n "$CMD_OUTPUT" ]; then
  echo "$CMD_OUTPUT" | head -20 | sed 's/^/    /'
fi
echo ""

run_cmd $ACPCTL get project "$TENANT" -o json
TENANT_NS=$(echo "$CMD_OUTPUT" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
TENANT_NS="${TENANT_NS:-$TENANT}"

# ============================================================================
# Section 1: Route Creation
# ============================================================================

section "1. Route Creation"

echo ""
printf '  %b▶%b  %b$ %s%b\n' "${BOLD}" "${NC}" "${ORANGE}" "acpctl apply -f - <<YAML (Gateway: $GW_NAME, route: {})" "${NC}"
CMD_RC=0
CMD_OUTPUT=$($ACPCTL apply -f - <<YAML 2>&1
kind: Gateway
name: $GW_NAME
project: $TENANT
server_dns_names:
  - openshell-gateway.NAMESPACE_PLACEHOLDER.svc.cluster.local
route: {}
YAML
) || CMD_RC=$?
if [ -n "$CMD_OUTPUT" ]; then
  echo "$CMD_OUTPUT" | head -20 | sed 's/^/    /'
fi
echo ""

# Wait for route to appear
ROUTE_FOUND=false
for i in $(seq 1 30); do
  run_cmd oc get route openshell-gateway -n "$TENANT_NS"
  if [ "$CMD_RC" -eq 0 ]; then
    ROUTE_FOUND=true
    break
  fi
  sleep 5
done

if [ "$ROUTE_FOUND" = "true" ]; then
  pass "Route created in namespace $TENANT_NS"
else
  fail "Route not created after 150s"
fi

# Verify TLS termination
run_cmd oc get route openshell-gateway -n "$TENANT_NS" -o jsonpath='{.spec.tls.termination}'
TLS_TERM="${CMD_OUTPUT:-}"
if [ "$TLS_TERM" = "reencrypt" ]; then
  pass "Route has reencrypt TLS termination"
else
  fail "Expected reencrypt TLS, got: $TLS_TERM"
fi

# Verify timeout annotation
run_cmd oc get route openshell-gateway -n "$TENANT_NS" -o jsonpath='{.metadata.annotations.haproxy\.router\.openshift\.io/timeout}'
TIMEOUT_ANN="${CMD_OUTPUT:-}"
if [ "$TIMEOUT_ANN" = "3600s" ]; then
  pass "Route has 3600s timeout annotation"
else
  fail "Expected 3600s timeout annotation, got: $TIMEOUT_ANN"
fi

# ============================================================================
# Section 2: Route Address Populated
# ============================================================================

section "2. Route Address Populated"

ROUTE_ADDR=""
for i in $(seq 1 20); do
  run_cmd $ACPCTL get gateway $GW_NAME --project "$TENANT" -o json
  ROUTE_ADDR=$(echo "$CMD_OUTPUT" | grep -o '"route_address": *"[^"]*"' | cut -d'"' -f4 || true)
  if [ -n "$ROUTE_ADDR" ]; then
    break
  fi
  sleep 5
done

if [ -n "$ROUTE_ADDR" ]; then
  pass "routeAddress populated: $ROUTE_ADDR"
else
  fail "routeAddress not populated after 100s"
fi

# Verify it's an apps-crc.testing address
if echo "$ROUTE_ADDR" | grep -q "apps-crc.testing"; then
  pass "routeAddress is a CRC address"
else
  fail "routeAddress doesn't look like CRC: $ROUTE_ADDR"
fi

# Verify ROUTE column in table output
run_cmd $ACPCTL get gateways --project "$TENANT"
ROUTE_COL=$(echo "$CMD_OUTPUT" | grep "$GW_NAME" | grep -o 'https://[^ ]*' || true)
if [ -n "$ROUTE_COL" ]; then
  pass "ROUTE column shows address in table output"
else
  fail "ROUTE column missing from table output"
fi

# ============================================================================
# Section 3: setup-cli Via Route
# ============================================================================

section "3. setup-cli Via Route"

run_cmd $ACPCTL gateway setup-cli $GW_NAME --project "$TENANT" --print
SETUP_OUTPUT="${CMD_OUTPUT:-}"
if echo "$SETUP_OUTPUT" | grep -q "$ROUTE_ADDR"; then
  pass "setup-cli --print includes route address"
else
  fail "setup-cli --print missing route address"
fi

# ============================================================================
# Section 4: Route Removal
# ============================================================================

section "4. Route Removal"

# Patch gateway to remove route
echo ""
printf '  %b▶%b  %b$ %s%b\n' "${BOLD}" "${NC}" "${ORANGE}" "acpctl apply -f - <<YAML (Gateway: $GW_NAME, no route)" "${NC}"
CMD_RC=0
CMD_OUTPUT=$($ACPCTL apply -f - <<YAML 2>&1
kind: Gateway
name: $GW_NAME
project: $TENANT
server_dns_names:
  - openshell-gateway.NAMESPACE_PLACEHOLDER.svc.cluster.local
YAML
) || CMD_RC=$?
if [ -n "$CMD_OUTPUT" ]; then
  echo "$CMD_OUTPUT" | head -20 | sed 's/^/    /'
fi
echo ""

ROUTE_DELETED=false
for i in $(seq 1 20); do
  run_cmd oc get route openshell-gateway -n "$TENANT_NS"
  if [ "$CMD_RC" -ne 0 ]; then
    ROUTE_DELETED=true
    break
  fi
  sleep 5
done

if [ "$ROUTE_DELETED" = "true" ]; then
  pass "Route deleted after removing route field"
else
  fail "Route still exists after 100s"
fi

# Verify routeAddress cleared
run_cmd $ACPCTL get gateway $GW_NAME --project "$TENANT" -o json
CLEARED_ADDR=$(echo "$CMD_OUTPUT" | grep -o '"route_address": *"[^"]*"' | cut -d'"' -f4 || true)
if [ -z "$CLEARED_ADDR" ]; then
  pass "routeAddress cleared after route removal"
else
  fail "routeAddress still set: $CLEARED_ADDR"
fi

echo ""
echo -e "${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}"
if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
