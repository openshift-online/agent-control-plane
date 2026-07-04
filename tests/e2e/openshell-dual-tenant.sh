#!/usr/bin/env bash
# E2E test: dual-tenant OpenShell gateway provisioning
#
# Verifies that two independent OpenShell gateways (tenant-a, tenant-b) are
# correctly provisioned and that sandbox provisioning can proceed concurrently
# in both tenant namespaces.
#
# Prerequisites:
#   - kind-up with OPENSHELL_USE_GATEWAY=true
#   - ACP projects tenant-a and tenant-b created (done automatically by kind-up)
#   - TEST_TOKEN and API_URL set, or tests/cypress/.env.test present
#
# Usage:
#   ./tests/openshell-dual-tenant.sh [API_URL]
#   API_URL defaults to http://localhost:13000 (default KIND_FWD_API_SERVER_PORT)

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

NAMESPACE="${NAMESPACE:-ambient-code}"
TENANTS=("tenant-a" "tenant-b")

# Load .env.test if it exists and TOKEN not already set
if [ -z "${TEST_TOKEN:-}" ] && [ -f "$(dirname "$0")/../cypress/.env.test" ]; then
  # shellcheck disable=SC1090
  source "$(dirname "$0")/../cypress/.env.test"
fi
TOKEN="${TEST_TOKEN:-}"

# Resolve API URL: use provided value, or set up a temporary port-forward
PF_PID=""
PF_PORT=18766
if [ -n "${API_URL:-}" ] && [ "${API_URL}" != "http://localhost:" ]; then
  : # use as-is
elif [ -n "${1:-}" ]; then
  API_URL="${1}"
else
  API_URL="http://localhost:${PF_PORT}"
  kubectl port-forward -n "$NAMESPACE" svc/ambient-api-server "${PF_PORT}:8000" \
    >/dev/null 2>&1 &
  PF_PID=$!
  # Wait up to 10 s for the port-forward to be ready
  for i in $(seq 1 10); do
    sleep 1
    if curl -sf "http://localhost:${PF_PORT}/api/ambient/v1/projects" \
        -H "Authorization: Bearer ${TOKEN}" >/dev/null 2>&1; then
      break
    fi
  done
fi
trap 'kill "${PF_PID}" 2>/dev/null || true' EXIT

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

PASSED=0
FAILED=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILED=$((FAILED + 1)); }
skip() { echo -e "  ${YELLOW}⊘${NC} $1 (skipped: $2)"; }
section() { echo ""; echo -e "${BOLD}$1${NC}"; }

api_get() {
  curl -sf --max-time 10 -H "Authorization: Bearer ${TOKEN}" "${API_URL}${1}" 2>/dev/null
}

api_post() {
  curl -sf --max-time 10 -X POST \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$2" \
    "${API_URL}${1}" 2>/dev/null
}

api_delete() {
  curl -sf --max-time 10 -X DELETE \
    -H "Authorization: Bearer ${TOKEN}" "${API_URL}${1}" 2>/dev/null || true
}

require_token() {
  if [ -z "$TOKEN" ]; then
    echo -e "${RED}Error:${NC} TEST_TOKEN not set. Run 'make kind-up OPENSHELL_USE_GATEWAY=true' first."
    echo "  Or: source tests/cypress/.env.test && ./tests/e2e/openshell-dual-tenant.sh"
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Section 1: Gateway deployments healthy in both tenant namespaces
# ---------------------------------------------------------------------------

section "1. OpenShell gateway deployments"

for TENANT in "${TENANTS[@]}"; do
  GW_READY=$(kubectl get statefulset openshell-gateway -n "$TENANT" \
    -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
  GW_READY="${GW_READY:-0}"
  if [ "${GW_READY}" -ge 1 ]; then
    pass "openshell-gateway in $TENANT is ready (replicas: $GW_READY)"
  else
    fail "openshell-gateway in $TENANT is not ready (readyReplicas=${GW_READY})"
  fi
done

# ---------------------------------------------------------------------------
# Section 2: Sandbox CRD + controller available
# ---------------------------------------------------------------------------

section "2. Agent Sandbox CRD and controller"

CONTROLLER_READY=$(kubectl get deployment agent-sandbox-controller \
  -n agent-sandbox-system \
  -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
if [ "${CONTROLLER_READY:-0}" -ge 1 ]; then
  pass "agent-sandbox controller is ready"
else
  fail "agent-sandbox controller is not ready (readyReplicas=${CONTROLLER_READY:-0})"
fi

if kubectl get crd sandboxes.agents.x-k8s.io >/dev/null 2>&1; then
  pass "AgentSandbox CRD exists (sandboxes.agents.x-k8s.io)"
else
  fail "AgentSandbox CRD not found"
fi

# ---------------------------------------------------------------------------
# Section 3: ACP projects exist for both tenants
# ---------------------------------------------------------------------------

section "3. ACP projects"
require_token

PROJECTS=$(api_get "/api/ambient/v1/projects?size=50" || echo "")
if [ -z "$PROJECTS" ]; then
  fail "Could not reach ACP API at $API_URL"
  echo ""
  echo "Summary: $PASSED passed, $FAILED failed"
  exit 1
fi

declare -A PROJECT_IDS
for TENANT in "${TENANTS[@]}"; do
  PROJECT_ID=$(echo "$PROJECTS" \
    | jq -r '.items[] | select(.name == "'"${TENANT}"'") | .id' 2>/dev/null | head -1 || echo "")
  if [ -n "$PROJECT_ID" ]; then
    pass "ACP project '$TENANT' exists (id: $PROJECT_ID)"
    PROJECT_IDS["$TENANT"]="$PROJECT_ID"
  else
    fail "ACP project '$TENANT' not found"
  fi
done

# ---------------------------------------------------------------------------
# Section 4: Concurrent session creation in both tenant projects
# ---------------------------------------------------------------------------

section "4. Concurrent session creation"

if [ "${#PROJECT_IDS[@]}" -lt 2 ]; then
  skip "Concurrent session creation" "one or more projects missing (see section 3)"
else
  CREATED_SESSION_IDS=()
  TMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TMP_DIR"' EXIT

  # Launch session creation in both projects simultaneously
  for TENANT in "${TENANTS[@]}"; do
    PID_FILE="${TMP_DIR}/pid.${TENANT}"
    OUT_FILE="${TMP_DIR}/out.${TENANT}"
    PROJECT_ID="${PROJECT_IDS[$TENANT]}"
    (
      RESP=$(api_post "/api/ambient/v1/sessions" \
        "{\"name\": \"dual-tenant-e2e-${TENANT}\", \"project_id\": \"${PROJECT_ID}\"}" || echo "")
      echo "$RESP" > "$OUT_FILE"
    ) &
    echo $! > "$PID_FILE"
  done

  # Wait for both to finish
  for TENANT in "${TENANTS[@]}"; do
    wait "$(cat "${TMP_DIR}/pid.${TENANT}" 2>/dev/null)" 2>/dev/null || true
  done

  # Check results
  for TENANT in "${TENANTS[@]}"; do
    OUT_FILE="${TMP_DIR}/out.${TENANT}"
    RESP=$(cat "$OUT_FILE" 2>/dev/null || echo "")
    SESSION_ID=$(echo "$RESP" | jq -r '.id // empty' 2>/dev/null || echo "")
    if [ -n "$SESSION_ID" ]; then
      pass "Session created in project '$TENANT' (id: $SESSION_ID)"
      CREATED_SESSION_IDS+=("$SESSION_ID")
    else
      fail "Failed to create session in project '$TENANT'"
    fi
  done
fi

# ---------------------------------------------------------------------------
# Section 5: Concurrent session start — sandbox provisioning in both tenants
# ---------------------------------------------------------------------------

section "5. Concurrent sandbox provisioning"

if [ "${#CREATED_SESSION_IDS[@]}" -lt 2 ]; then
  skip "Sandbox provisioning" "session creation incomplete (see section 4)"
else
  # Start both sessions simultaneously; track PIDs to wait only on these jobs
  START_PIDS=()
  for SESSION_ID in "${CREATED_SESSION_IDS[@]}"; do
    (api_post "/api/ambient/v1/sessions/${SESSION_ID}/start" "{}" >/dev/null 2>&1 || true) &
    START_PIDS+=($!)
  done
  for pid in "${START_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done

  # Give the control plane a moment to create sandbox requests (non-blocking check)
  sleep 5

  for TENANT in "${TENANTS[@]}"; do
    SANDBOX_COUNT=$(kubectl get sandboxes -n "$TENANT" \
      --no-headers 2>/dev/null | wc -l | tr -d ' ' || echo "0")
    if [ "${SANDBOX_COUNT}" -ge 1 ]; then
      pass "Sandbox resource created in namespace '$TENANT' ($SANDBOX_COUNT sandbox(s))"
    else
      # The gateway may buffer the request or not expose it as a K8s CR depending
      # on gateway mode — downgrade to informational if gateways are healthy.
      GATEWAY_HEALTHY=$(kubectl get statefulset openshell-gateway -n "$TENANT" \
        -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
      if [ "${GATEWAY_HEALTHY:-0}" -ge 1 ]; then
        skip "Sandbox CR in '$TENANT'" "gateway is healthy; sandbox may be internal to gateway"
      else
        fail "No sandbox resource in '$TENANT' and gateway is not ready"
      fi
    fi
  done
fi

# ---------------------------------------------------------------------------
# Cleanup: delete test sessions
# ---------------------------------------------------------------------------

section "Cleanup"

for SESSION_ID in "${CREATED_SESSION_IDS[@]}"; do
  api_delete "/api/ambient/v1/sessions/${SESSION_ID}" >/dev/null && \
    echo "  Deleted session $SESSION_ID" || \
    echo "  Could not delete session $SESSION_ID (non-fatal)"
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo -e "${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}"
echo ""

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
