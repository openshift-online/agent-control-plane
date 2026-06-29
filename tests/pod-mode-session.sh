#!/usr/bin/env bash
# E2E test: pod-mode session provisioning (OPENSHELL_USE_GATEWAY=false)
#
# Verifies that when operating in standard pod mode, a Kubernetes Pod is
# created in the project namespace when a session is started.
#
# Prerequisites:
#   - kind-up with OPENSHELL_USE_GATEWAY=false (default)
#   - TEST_TOKEN set, or e2e/.env.test present
#
# Usage:
#   ./tests/pod-mode-session.sh [API_URL]

set -euo pipefail

NAMESPACE="${NAMESPACE:-ambient-code}"

if [ -z "${TEST_TOKEN:-}" ] && [ -f "$(dirname "$0")/../e2e/.env.test" ]; then
  # shellcheck disable=SC1090
  source "$(dirname "$0")/../e2e/.env.test"
fi
TOKEN="${TEST_TOKEN:-}"

PF_PID=""
PF_PORT=18767
if [ -n "${API_URL:-}" ] && [ "${API_URL}" != "http://localhost:" ]; then
  : # use as-is
elif [ -n "${1:-}" ]; then
  API_URL="${1}"
else
  API_URL="http://localhost:${PF_PORT}"
  kubectl port-forward -n "$NAMESPACE" svc/ambient-api-server "${PF_PORT}:8000" \
    >/dev/null 2>&1 &
  PF_PID=$!
  for i in $(seq 1 10); do
    sleep 1
    if curl -sf "http://localhost:${PF_PORT}/api/ambient/v1/projects" \
        -H "Authorization: Bearer ${TOKEN}" >/dev/null 2>&1; then
      break
    fi
  done
fi
trap 'kill "${PF_PID}" 2>/dev/null || true' EXIT

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

PASSED=0
FAILED=0
PROJECT_ID=""
SESSION_ID=""
PROJECT_NS=""

pass() { echo -e "  ${GREEN}✓${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILED=$((FAILED + 1)); }
section() { echo ""; echo -e "${BOLD}$1${NC}"; }

api_get()  { curl -sf --max-time 10 -H "Authorization: Bearer ${TOKEN}" "${API_URL}${1}" 2>/dev/null; }
api_post() {
  curl -sf --max-time 10 -X POST \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$2" "${API_URL}${1}" 2>/dev/null
}
api_delete() {
  curl -sf --max-time 10 -X DELETE \
    -H "Authorization: Bearer ${TOKEN}" "${API_URL}${1}" 2>/dev/null || true
}

require_token() {
  if [ -z "$TOKEN" ]; then
    echo -e "${RED}Error:${NC} TEST_TOKEN not set. Run 'make kind-up' first."
    exit 1
  fi
}

cleanup() {
  echo ""
  echo -e "${BOLD}Cleanup${NC}"
  if [ -n "$SESSION_ID" ]; then
    api_delete "/api/ambient/v1/sessions/${SESSION_ID}" && echo "  Deleted session $SESSION_ID" || true
  fi
  if [ -n "$PROJECT_ID" ]; then
    api_delete "/api/ambient/v1/projects/${PROJECT_ID}" && echo "  Deleted project $PROJECT_ID" || true
  fi
  if [ -n "$PROJECT_NS" ] && kubectl get namespace "$PROJECT_NS" >/dev/null 2>&1; then
    kubectl delete namespace "$PROJECT_NS" --ignore-not-found >/dev/null && echo "  Deleted namespace $PROJECT_NS" || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Section 1: Control plane is running in pod mode
# ---------------------------------------------------------------------------

section "1. Control plane pod mode"
require_token

CP_GATEWAY=$(kubectl get deployment ambient-control-plane -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="OPENSHELL_USE_GATEWAY")].value}' 2>/dev/null || echo "")
if [ "${CP_GATEWAY}" = "true" ]; then
  fail "OPENSHELL_USE_GATEWAY=true in control plane deployment — this test requires pod mode"
  echo ""
  echo -e "${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}"
  exit 1
else
  pass "Control plane is in pod mode (OPENSHELL_USE_GATEWAY=${CP_GATEWAY:-false})"
fi

# ---------------------------------------------------------------------------
# Section 2: Create a test project and its namespace
# ---------------------------------------------------------------------------

section "2. Project and namespace setup"

PROJECT_RESP=$(api_post "/api/ambient/v1/projects" \
  '{"name": "pod-mode-e2e", "description": "pod-mode e2e test project"}' || echo "")
PROJECT_ID=$(echo "$PROJECT_RESP" | jq -r '.id // empty' 2>/dev/null || echo "")

if [ -n "$PROJECT_ID" ]; then
  pass "ACP project created (id: $PROJECT_ID)"
else
  fail "Failed to create ACP project"
  echo ""
  echo -e "${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}"
  exit 1
fi

# Namespace = lowercase project ID (StandardNamespaceProvisioner.NamespaceName)
PROJECT_NS=$(echo "$PROJECT_ID" | tr '[:upper:]' '[:lower:]')
kubectl create namespace "$PROJECT_NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
pass "Namespace created: $PROJECT_NS"

# ---------------------------------------------------------------------------
# Section 3: Create and start a session
# ---------------------------------------------------------------------------

section "3. Session creation and start"

SESSION_RESP=$(api_post "/api/ambient/v1/sessions" \
  "{\"name\": \"pod-mode-e2e\", \"project_id\": \"${PROJECT_ID}\"}" || echo "")
SESSION_ID=$(echo "$SESSION_RESP" | jq -r '.id // empty' 2>/dev/null || echo "")

if [ -n "$SESSION_ID" ]; then
  pass "Session created (id: $SESSION_ID)"
else
  fail "Failed to create session"
  echo ""
  echo -e "${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}"
  exit 1
fi

api_post "/api/ambient/v1/sessions/${SESSION_ID}/start" "{}" >/dev/null 2>&1 || true
pass "Session start requested"

# ---------------------------------------------------------------------------
# Section 4: Wait for pod to appear in project namespace
# ---------------------------------------------------------------------------

section "4. Pod provisioning"

echo "  Waiting up to 60s for pod in namespace $PROJECT_NS..."
POD_NAME=""
for i in $(seq 1 20); do
  sleep 3
  POD_NAME=$(kubectl get pods -n "$PROJECT_NS" \
    -l "ambient-code.io/session-id=${SESSION_ID}" \
    --no-headers -o custom-columns=":metadata.name" 2>/dev/null | head -1 || echo "")
  if [ -n "$POD_NAME" ]; then
    break
  fi
done

if [ -n "$POD_NAME" ]; then
  POD_PHASE=$(kubectl get pod "$POD_NAME" -n "$PROJECT_NS" \
    -o jsonpath='{.status.phase}' 2>/dev/null || echo "Unknown")
  pass "Pod created: $POD_NAME (phase: $POD_PHASE)"
else
  # Show control plane logs for diagnosis
  echo "  No pod found — control plane logs (last 20 lines):"
  kubectl logs -n "$NAMESPACE" -l app=ambient-control-plane --tail=20 2>/dev/null | sed 's/^/    /' || true
  fail "No pod created in namespace $PROJECT_NS within 60s"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo -e "${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}"
echo ""

[ "$FAILED" -eq 0 ]
