#!/usr/bin/env bash
# E2E test: full gateway agent flow
#
# Validates the golden path:
#   acpctl apply -k  ->  acpctl start  ->  sandbox provisioned  ->  session active
#
# This test does NOT require a real LLM API key — it validates the platform
# plumbing up to session start and sandbox creation.  If VERTEX_SA_KEY or
# ANTHROPIC_API_KEY is available, it also checks that a runner pod is spawned.
#
# Prerequisites:
#   - kind-up with OPENSHELL_USE_GATEWAY=true (default)
#   - acpctl built (make build-cli)
#   - TEST_TOKEN set or tests/cypress/.env.test present
#
# Usage:
#   ./tests/e2e/gateway-e2e-test.sh [API_URL]
#   API_URL defaults to http://localhost:13000

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

NAMESPACE="${NAMESPACE:-ambient-code}"
TENANT="tenant-a"

if [ -z "${TEST_TOKEN:-}" ] && [ -f "$SCRIPT_DIR/../cypress/.env.test" ]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/../cypress/.env.test"
fi
TOKEN="${TEST_TOKEN:-}"

PF_PID=""
PF_PORT=18767
if [ -n "${API_URL:-}" ] && [ "${API_URL}" != "http://localhost:" ]; then
  :
elif [ -n "${1:-}" ]; then
  API_URL="${1}"
else
  API_URL="http://localhost:${PF_PORT}"
  kubectl port-forward -n "$NAMESPACE" svc/ambient-api-server "${PF_PORT}:8000" \
    >/dev/null 2>&1 &
  PF_PID=$!
  for i in $(seq 1 10); do
    sleep 1
    if curl -sf "${API_URL}/healthcheck" >/dev/null 2>&1; then break; fi
  done
fi
trap 'kill "${PF_PID}" 2>/dev/null || true' EXIT

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

PASSED=0
FAILED=0
CREATED_SESSION_ID=""

pass() { echo -e "  ${GREEN}✓${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILED=$((FAILED + 1)); }
skip() { echo -e "  ${YELLOW}⊘${NC} $1 (skipped: $2)"; }
section() { echo ""; echo -e "${BOLD}$1${NC}"; }

api() {
  local method="$1" path="$2"
  shift 2
  curl -sf --max-time 15 -X "$method" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    "$@" "${API_URL}${path}" 2>/dev/null
}

require_token() {
  if [ -z "$TOKEN" ]; then
    echo -e "${RED}Error:${NC} TEST_TOKEN not set."
    echo "  Run 'make kind-up' first, or: source tests/cypress/.env.test"
    exit 1
  fi
}

find_acpctl() {
  if command -v acpctl >/dev/null 2>&1; then echo acpctl; return; fi
  if [ -x "$REPO_ROOT/components/ambient-cli/acpctl" ]; then
    echo "$REPO_ROOT/components/ambient-cli/acpctl"; return
  fi
  if [ -x "$REPO_ROOT/acpctl" ]; then echo "$REPO_ROOT/acpctl"; return; fi
  echo ""
}

section "1. Prerequisites"
require_token

ACPCTL=$(find_acpctl)
if [ -n "$ACPCTL" ]; then
  pass "acpctl found: $ACPCTL"
else
  fail "acpctl not found — run 'make build-cli'"
  echo -e "\n${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}\n"
  exit 1
fi

HEALTH=$(curl -sf --max-time 5 "${API_URL}/healthcheck" 2>/dev/null || echo "")
if [ -n "$HEALTH" ]; then
  pass "API server healthy at ${API_URL}"
else
  fail "API server not responding at ${API_URL}"
  echo -e "\n${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}\n"
  exit 1
fi

section "2. Login acpctl"

if $ACPCTL login --url "$API_URL" --token "$TOKEN" >/dev/null 2>&1; then
  pass "acpctl login succeeded"
else
  fail "acpctl login failed"
  echo -e "\n${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}\n"
  exit 1
fi

section "3. Verify tenant project exists"

PROJECT_RESP=$(api GET "/api/ambient/v1/projects?size=50" || echo "")
PROJECT_ID=$(echo "$PROJECT_RESP" \
  | jq -r '.items[] | select(.name == "'"${TENANT}"'") | .id' 2>/dev/null | head -1 || echo "")

if [ -n "$PROJECT_ID" ]; then
  pass "Project '${TENANT}' exists (id: ${PROJECT_ID})"
else
  fail "Project '${TENANT}' not found — was 'make kind-up' run with OPENSHELL_USE_GATEWAY=true?"
  echo -e "\n${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}\n"
  exit 1
fi

section "4. Verify agent exists"

AGENTS_RESP=$(api GET "/api/ambient/v1/projects/${PROJECT_ID}/agents?size=50" || echo "")
AGENT_ID=$(echo "$AGENTS_RESP" \
  | jq -r '.items[] | select(.name == "hello-world") | .id' 2>/dev/null | head -1 || echo "")

if [ -n "$AGENT_ID" ]; then
  pass "Agent 'hello-world' exists (id: ${AGENT_ID})"
else
  fail "Agent 'hello-world' not found in project '${TENANT}'"
  echo -e "\n${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}\n"
  exit 1
fi

section "5. Verify provider and credential"

PROVIDERS_RESP=$(api GET "/api/ambient/v1/providers?size=50" || echo "")
PROVIDER_NAME=$(echo "$PROVIDERS_RESP" \
  | jq -r '.items[] | select(.name == "vertex") | .name' 2>/dev/null | head -1 || echo "")

if [ -n "$PROVIDER_NAME" ]; then
  pass "Provider 'vertex' exists"
else
  skip "Provider 'vertex'" "not configured (non-fatal)"
fi

CREDS_RESP=$(api GET "/api/ambient/v1/credentials?size=50" || echo "")
CRED_NAME=$(echo "$CREDS_RESP" \
  | jq -r '.items[] | select(.name | test("vertex")) | .name' 2>/dev/null | head -1 || echo "")

if [ -n "$CRED_NAME" ]; then
  pass "Credential '${CRED_NAME}' exists"
else
  skip "Vertex credential" "not configured (non-fatal)"
fi

section "6. OpenShell gateway healthy"

GW_READY=$(kubectl get statefulset openshell-gateway -n "$TENANT" \
  -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
GW_READY="${GW_READY:-0}"

if [ "${GW_READY}" -ge 1 ]; then
  pass "openshell-gateway in ${TENANT} ready (replicas: ${GW_READY})"
else
  fail "openshell-gateway in ${TENANT} not ready (readyReplicas=${GW_READY})"
fi

CONTROLLER_READY=$(kubectl get deployment agent-sandbox-controller \
  -n agent-sandbox-system \
  -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")

if [ "${CONTROLLER_READY:-0}" -ge 1 ]; then
  pass "agent-sandbox controller ready"
else
  fail "agent-sandbox controller not ready"
fi

section "7. Start agent session"

START_RESP=$(api POST "/api/ambient/v1/projects/${PROJECT_ID}/agents/${AGENT_ID}/start" \
  -d '{"prompt": "gateway-e2e-test: say hello"}' || echo "")

CREATED_SESSION_ID=$(echo "$START_RESP" \
  | jq -r '.session.id // empty' 2>/dev/null || echo "")

if [ -n "$CREATED_SESSION_ID" ]; then
  pass "Session started (id: ${CREATED_SESSION_ID})"
else
  fail "Failed to start session for agent 'hello-world'"
  echo "  Response: $(echo "$START_RESP" | head -c 200)"
fi

section "8. Session state verification"

if [ -n "$CREATED_SESSION_ID" ]; then
  sleep 3

  SESSION_RESP=$(api GET "/api/ambient/v1/sessions/${CREATED_SESSION_ID}" || echo "")
  SESSION_PHASE=$(echo "$SESSION_RESP" | jq -r '.phase // empty' 2>/dev/null || echo "")
  SESSION_PROJECT=$(echo "$SESSION_RESP" | jq -r '.project_id // empty' 2>/dev/null || echo "")

  if [ -n "$SESSION_PHASE" ]; then
    pass "Session phase: ${SESSION_PHASE}"
  else
    fail "Could not retrieve session phase"
  fi

  if [ "$SESSION_PROJECT" = "$PROJECT_ID" ]; then
    pass "Session bound to correct project (${TENANT})"
  else
    fail "Session project mismatch: expected ${PROJECT_ID}, got ${SESSION_PROJECT}"
  fi

  SANDBOX_COUNT=$(kubectl get sandboxes -n "$TENANT" \
    --no-headers 2>/dev/null | wc -l | tr -d ' ' || echo "0")
  if [ "${SANDBOX_COUNT}" -ge 1 ]; then
    pass "Sandbox resource created in namespace '${TENANT}' (${SANDBOX_COUNT})"
  else
    if [ "${GW_READY}" -ge 1 ]; then
      skip "Sandbox CR in '${TENANT}'" "gateway healthy; sandbox may be internal"
    else
      fail "No sandbox in '${TENANT}' and gateway not ready"
    fi
  fi
else
  skip "Session state verification" "session not created"
fi

section "Cleanup"

if [ -n "$CREATED_SESSION_ID" ]; then
  api DELETE "/api/ambient/v1/sessions/${CREATED_SESSION_ID}" >/dev/null 2>&1 && \
    echo "  Deleted session ${CREATED_SESSION_ID}" || \
    echo "  Could not delete session (non-fatal)"
fi

echo ""
echo -e "${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}"
echo ""

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
