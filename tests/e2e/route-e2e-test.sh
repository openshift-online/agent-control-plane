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
TENANT="tenant-route-e2e"
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

PASS=0
FAIL=0
TOTAL=0

pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  ✗ $1"; }

cleanup() {
  if [ "$SKIP_CLEANUP" = "true" ]; then
    echo "Skipping cleanup (--skip-cleanup)"
    return
  fi
  echo "Cleaning up..."
  $ACPCTL delete gateway route-test-gw --project "$TENANT" 2>/dev/null || true
  $ACPCTL delete project "$TENANT" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== Gateway Route E2E Tests ==="
echo "API: $API_URL"
echo ""

# Setup: create project and gateway with route
echo "--- Setup ---"
$ACPCTL config set url "$API_URL"

# Login via password grant if Keycloak is available
KC_ROUTE_HOST=$(oc get route keycloak -n "$NAMESPACE" -o jsonpath='{.spec.host}' 2>/dev/null || true)
if [ -n "$KC_ROUTE_HOST" ]; then
  $ACPCTL login --password-grant \
    --username developer --password developer \
    --issuer-url "https://${KC_ROUTE_HOST}/realms/ambient-code" \
    --client-id openshell-cli \
    --url "$API_URL" 2>/dev/null || echo "Warning: login failed, continuing with existing credentials"
fi

$ACPCTL apply -f - <<'YAML'
kind: Project
name: tenant-route-e2e
YAML

TENANT_NS=$($ACPCTL get project "$TENANT" -o json 2>/dev/null | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "$TENANT")

# ── Test 1: Route creation ──────────────────────────────────────────────────
echo ""
echo "--- Test 1: Route creation ---"

$ACPCTL apply -f - <<'YAML'
kind: Gateway
name: route-test-gw
project: tenant-route-e2e
server_dns_names:
  - openshell-gateway.NAMESPACE_PLACEHOLDER.svc.cluster.local
route: {}
YAML

# Wait for route to appear
ROUTE_FOUND=false
for i in $(seq 1 30); do
  if oc get route openshell-gateway -n "$TENANT_NS" &>/dev/null; then
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
TLS_TERM=$(oc get route openshell-gateway -n "$TENANT_NS" -o jsonpath='{.spec.tls.termination}' 2>/dev/null || true)
if [ "$TLS_TERM" = "reencrypt" ]; then
  pass "Route has reencrypt TLS termination"
else
  fail "Expected reencrypt TLS, got: $TLS_TERM"
fi

# Verify timeout annotation
TIMEOUT_ANN=$(oc get route openshell-gateway -n "$TENANT_NS" -o jsonpath='{.metadata.annotations.haproxy\.router\.openshift\.io/timeout}' 2>/dev/null || true)
if [ "$TIMEOUT_ANN" = "3600s" ]; then
  pass "Route has 3600s timeout annotation"
else
  fail "Expected 3600s timeout annotation, got: $TIMEOUT_ANN"
fi

# ── Test 2: Route address populated ─────────────────────────────────────────
echo ""
echo "--- Test 2: Route address populated ---"

ROUTE_ADDR=""
for i in $(seq 1 20); do
  ROUTE_ADDR=$($ACPCTL get gateway route-test-gw --project "$TENANT" -o json 2>/dev/null | grep -o '"route_address":"[^"]*"' | cut -d'"' -f4 || true)
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
ROUTE_COL=$($ACPCTL get gateways --project "$TENANT" 2>/dev/null | grep "route-test-gw" | grep -o 'https://[^ ]*' || true)
if [ -n "$ROUTE_COL" ]; then
  pass "ROUTE column shows address in table output"
else
  fail "ROUTE column missing from table output"
fi

# ── Test 3: setup-cli uses route address ────────────────────────────────────
echo ""
echo "--- Test 3: setup-cli via route ---"

SETUP_OUTPUT=$($ACPCTL gateway setup-cli route-test-gw --project "$TENANT" --print 2>/dev/null || true)
if echo "$SETUP_OUTPUT" | grep -q "$ROUTE_ADDR"; then
  pass "setup-cli --print includes route address"
else
  fail "setup-cli --print missing route address"
fi

# ── Test 4: Route removal ──────────────────────────────────────────────────
echo ""
echo "--- Test 4: Route removal ---"

# Patch gateway to remove route
$ACPCTL apply -f - <<'YAML'
kind: Gateway
name: route-test-gw
project: tenant-route-e2e
server_dns_names:
  - openshell-gateway.NAMESPACE_PLACEHOLDER.svc.cluster.local
YAML

ROUTE_DELETED=false
for i in $(seq 1 20); do
  if ! oc get route openshell-gateway -n "$TENANT_NS" &>/dev/null; then
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
CLEARED_ADDR=$($ACPCTL get gateway route-test-gw --project "$TENANT" -o json 2>/dev/null | grep -o '"route_address":"[^"]*"' | cut -d'"' -f4 || true)
if [ -z "$CLEARED_ADDR" ]; then
  pass "routeAddress cleared after route removal"
else
  fail "routeAddress still set: $CLEARED_ADDR"
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS/$TOTAL passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
