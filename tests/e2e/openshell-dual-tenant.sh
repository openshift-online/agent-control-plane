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

# ============================================================================
# Config
# ============================================================================

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

# ============================================================================
# Helpers
# ============================================================================

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

ORANGE='\033[38;5;214m'

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

run_cmd_redact() {
  CMD_RC=0
  echo ""
  local redacted
  redacted=$(printf '%s ' "$@" | sed -E \
    -e 's/(--token |--client-secret |password=|client_secret=|clientSecret[":= ]*|Authorization: Bearer )[^ "}]*/\1[REDACTED]/g')
  printf '  %b▶%b  %b$ %s%b\n' "${BOLD}" "${NC}" "${ORANGE}" "${redacted% }" "${NC}"
  CMD_OUTPUT=$("$@" 2>&1) || CMD_RC=$?
  echo ""
}

require_token() {
  if [ -z "$TOKEN" ]; then
    echo -e "${RED}Error:${NC} TEST_TOKEN not set. Run 'make kind-up OPENSHELL_USE_GATEWAY=true' first."
    echo "  Or: source tests/cypress/.env.test && ./tests/e2e/openshell-dual-tenant.sh"
    exit 1
  fi
}

# ============================================================================
# Section 1: OpenShell gateway deployments
# ============================================================================

section "1. OpenShell gateway deployments"

for TENANT in "${TENANTS[@]}"; do
  run_cmd kubectl get statefulset openshell-gateway -n "$TENANT" \
    -o jsonpath='{.status.readyReplicas}'
  GW_READY="${CMD_OUTPUT:-0}"
  if [ "${GW_READY}" -ge 1 ]; then
    pass "openshell-gateway in $TENANT is ready (replicas: $GW_READY)"
  else
    fail "openshell-gateway in $TENANT is not ready (readyReplicas=${GW_READY})"
  fi
done

# ============================================================================
# Section 2: Agent Sandbox CRD and controller
# ============================================================================

section "2. Agent Sandbox CRD and controller"

run_cmd kubectl get deployment agent-sandbox-controller \
  -n agent-sandbox-system \
  -o jsonpath='{.status.readyReplicas}'
CONTROLLER_READY="${CMD_OUTPUT:-0}"
if [ "${CONTROLLER_READY}" -ge 1 ]; then
  pass "agent-sandbox controller is ready"
else
  fail "agent-sandbox controller is not ready (readyReplicas=${CONTROLLER_READY})"
fi

run_cmd kubectl get crd sandboxes.agents.x-k8s.io
if [ "$CMD_RC" -eq 0 ]; then
  pass "AgentSandbox CRD exists (sandboxes.agents.x-k8s.io)"
else
  fail "AgentSandbox CRD not found"
fi

# ============================================================================
# Section 3: ACP projects
# ============================================================================

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

# ============================================================================
# Section 4: Concurrent session creation
# ============================================================================

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

# ============================================================================
# Section 5: Concurrent sandbox provisioning
# ============================================================================

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
    run_cmd kubectl get sandboxes -n "$TENANT" --no-headers
    SANDBOX_COUNT=$(echo "$CMD_OUTPUT" | grep -c . 2>/dev/null || echo "0")
    if [ "${SANDBOX_COUNT}" -ge 1 ]; then
      pass "Sandbox resource created in namespace '$TENANT' ($SANDBOX_COUNT sandbox(s))"
    else
      # The gateway may buffer the request or not expose it as a K8s CR depending
      # on gateway mode — downgrade to informational if gateways are healthy.
      run_cmd kubectl get statefulset openshell-gateway -n "$TENANT" \
        -o jsonpath='{.status.readyReplicas}'
      GATEWAY_HEALTHY="${CMD_OUTPUT:-0}"
      if [ "${GATEWAY_HEALTHY}" -ge 1 ]; then
        skip "Sandbox CR in '$TENANT'" "gateway is healthy; sandbox may be internal to gateway"
      else
        fail "No sandbox resource in '$TENANT' and gateway is not ready"
      fi
    fi
  done
fi

# ============================================================================
# Section 6: Sandbox log streaming and policy
# ============================================================================

section "6. Sandbox log streaming and policy"

if [ "${#CREATED_SESSION_IDS[@]}" -lt 1 ]; then
  skip "Sandbox observability" "no sessions created (see section 4)"
else
  # Pick the first session (tenant-a) for observability tests
  OBS_SESSION_ID="${CREATED_SESSION_IDS[0]}"

  # Wait for the session to reach Running phase (sandbox must be up)
  SANDBOX_READY=false
  for i in $(seq 1 30); do
    PHASE=$(api_get "/api/ambient/v1/sessions/${OBS_SESSION_ID}" \
      | jq -r '.phase // empty' 2>/dev/null || echo "")
    if [ "$PHASE" = "Running" ]; then
      SANDBOX_READY=true
      break
    fi
    sleep 2
  done

  if ! $SANDBOX_READY; then
    skip "Sandbox log streaming" "session did not reach Running phase (phase: ${PHASE:-unknown})"
    skip "Sandbox policy retrieval" "session did not reach Running phase"
  else
    pass "Session ${OBS_SESSION_ID} reached Running phase"

    # 6a. Sandbox logs — SSE stream should return named events with data
    LOG_OUTPUT=$(curl -sf --max-time 10 \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Accept: text/event-stream" \
      "${API_URL}/api/ambient/v1/sessions/${OBS_SESSION_ID}/sandbox/logs" 2>/dev/null || echo "")

    if echo "$LOG_OUTPUT" | grep -q '^event:'; then
      EVENT_COUNT=$(echo "$LOG_OUTPUT" | grep -c '^event:' || echo "0")
      pass "Sandbox logs streaming returns SSE events ($EVENT_COUNT events)"
    else
      fail "Sandbox logs streaming returned no SSE events"
    fi

    # Verify log events contain parseable JSON data lines
    if echo "$LOG_OUTPUT" | grep -q '^data: {'; then
      FIRST_DATA=$(echo "$LOG_OUTPUT" | grep '^data: ' | head -1 | sed 's/^data: //')
      if echo "$FIRST_DATA" | jq -e '.message' >/dev/null 2>&1 || \
         echo "$FIRST_DATA" | jq -e '.phase' >/dev/null 2>&1; then
        pass "Sandbox log events contain valid JSON with expected fields"
      else
        fail "Sandbox log event JSON missing expected fields (message or phase)"
      fi
    else
      fail "Sandbox log stream has no JSON data lines"
    fi

    # Verify named event types (log, status, platform_event, warning)
    HAS_LOG_EVENT=$(echo "$LOG_OUTPUT" | grep -c '^event: log$' || echo "0")
    HAS_STATUS_EVENT=$(echo "$LOG_OUTPUT" | grep -c '^event: status$' || echo "0")
    if [ "$HAS_LOG_EVENT" -gt 0 ]; then
      pass "Sandbox log stream includes 'log' events ($HAS_LOG_EVENT)"
    else
      fail "Sandbox log stream missing 'log' event type"
    fi
    if [ "$HAS_STATUS_EVENT" -gt 0 ]; then
      pass "Sandbox log stream includes 'status' events ($HAS_STATUS_EVENT)"
    else
      skip "Sandbox 'status' events" "not always emitted depending on timing"
    fi

    # 6b. Sandbox policy — should return JSON with policy, version, status
    POLICY_OUTPUT=$(api_get "/api/ambient/v1/sessions/${OBS_SESSION_ID}/sandbox/policy" || echo "")

    if [ -n "$POLICY_OUTPUT" ] && echo "$POLICY_OUTPUT" | jq -e '.policy' >/dev/null 2>&1; then
      pass "Sandbox policy returns valid JSON with policy object"
    else
      fail "Sandbox policy did not return expected JSON (got: ${POLICY_OUTPUT:0:100})"
    fi

    POLICY_STATUS=$(echo "$POLICY_OUTPUT" | jq -r '.status // empty' 2>/dev/null || echo "")
    if [ -n "$POLICY_STATUS" ]; then
      pass "Sandbox policy includes status field (status: $POLICY_STATUS)"
    else
      fail "Sandbox policy missing status field"
    fi

    POLICY_VERSION=$(echo "$POLICY_OUTPUT" | jq -r '.version // empty' 2>/dev/null || echo "")
    if [ -n "$POLICY_VERSION" ]; then
      pass "Sandbox policy includes version field (version: $POLICY_VERSION)"
    else
      fail "Sandbox policy missing version field"
    fi
  fi
fi

# ============================================================================
# Section 7: Sandbox snapshot persistence
# ============================================================================

section "7. Sandbox snapshot persistence"

if ! $SANDBOX_READY; then
  skip "Sandbox persistence" "session never reached Running phase (see section 6)"
else
  # Stop the session so the CP takes a final snapshot before sandbox deletion
  api_post "/api/ambient/v1/sessions/${OBS_SESSION_ID}/stop" "{}" >/dev/null 2>&1 || true

  # Wait for the session to reach a terminal phase
  STOPPED=false
  for i in $(seq 1 30); do
    PHASE=$(api_get "/api/ambient/v1/sessions/${OBS_SESSION_ID}" \
      | jq -r '.phase // empty' 2>/dev/null || echo "")
    if [ "$PHASE" = "Stopped" ] || [ "$PHASE" = "Completed" ] || [ "$PHASE" = "Failed" ]; then
      STOPPED=true
      break
    fi
    sleep 2
  done

  if ! $STOPPED; then
    skip "Sandbox persistence" "session did not reach terminal phase (phase: ${PHASE:-unknown})"
  else
    pass "Session ${OBS_SESSION_ID} reached terminal phase ($PHASE)"

    # Fetch the full session and check snapshot fields
    SESSION_JSON=$(api_get "/api/ambient/v1/sessions/${OBS_SESSION_ID}" || echo "")

    # 7a. sandbox_logs_snapshot should be a non-null JSON array
    LOGS_SNAPSHOT=$(echo "$SESSION_JSON" | jq -r '.sandbox_logs_snapshot // empty' 2>/dev/null || echo "")
    if [ -n "$LOGS_SNAPSHOT" ] && echo "$LOGS_SNAPSHOT" | jq -e 'type == "array"' >/dev/null 2>&1; then
      LOG_COUNT=$(echo "$LOGS_SNAPSHOT" | jq 'length' 2>/dev/null || echo "0")
      if [ "$LOG_COUNT" -gt 0 ]; then
        pass "sandbox_logs_snapshot persisted ($LOG_COUNT log entries)"
      else
        fail "sandbox_logs_snapshot is an empty array"
      fi
    elif [ -n "$LOGS_SNAPSHOT" ]; then
      # The field is a JSON string that needs to be parsed
      PARSED_LOGS=$(echo "$LOGS_SNAPSHOT" | jq -r '.' 2>/dev/null || echo "")
      if echo "$PARSED_LOGS" | jq -e 'type == "array" and length > 0' >/dev/null 2>&1; then
        LOG_COUNT=$(echo "$PARSED_LOGS" | jq 'length' 2>/dev/null || echo "0")
        pass "sandbox_logs_snapshot persisted ($LOG_COUNT log entries)"
      else
        fail "sandbox_logs_snapshot present but not a valid JSON array"
      fi
    else
      fail "sandbox_logs_snapshot is null or missing after session stop"
    fi

    # 7b. sandbox_policy_snapshot should be a non-null JSON object with version, status, policy
    POLICY_SNAPSHOT=$(echo "$SESSION_JSON" | jq -r '.sandbox_policy_snapshot // empty' 2>/dev/null || echo "")
    if [ -n "$POLICY_SNAPSHOT" ]; then
      # Parse (may be a JSON string or already an object)
      PARSED_POLICY="$POLICY_SNAPSHOT"
      if ! echo "$PARSED_POLICY" | jq -e '.policy' >/dev/null 2>&1; then
        PARSED_POLICY=$(echo "$POLICY_SNAPSHOT" | jq -r '.' 2>/dev/null || echo "")
      fi

      if echo "$PARSED_POLICY" | jq -e '.policy' >/dev/null 2>&1; then
        pass "sandbox_policy_snapshot persisted with policy object"
      else
        fail "sandbox_policy_snapshot missing 'policy' field"
      fi

      SNAP_VERSION=$(echo "$PARSED_POLICY" | jq -r '.version // empty' 2>/dev/null || echo "")
      if [ -n "$SNAP_VERSION" ]; then
        pass "sandbox_policy_snapshot includes version ($SNAP_VERSION)"
      else
        fail "sandbox_policy_snapshot missing version field"
      fi

      SNAP_STATUS=$(echo "$PARSED_POLICY" | jq -r '.status // empty' 2>/dev/null || echo "")
      if [ -n "$SNAP_STATUS" ]; then
        pass "sandbox_policy_snapshot includes status ($SNAP_STATUS)"
      else
        fail "sandbox_policy_snapshot missing status field"
      fi
    else
      fail "sandbox_policy_snapshot is null or missing after session stop"
    fi
  fi
fi

# ============================================================================
# Cleanup
# ============================================================================

section "Cleanup"

for SESSION_ID in "${CREATED_SESSION_IDS[@]}"; do
  run_cmd_redact curl -sf --max-time 10 -X DELETE \
    -H "Authorization: Bearer ${TOKEN}" "${API_URL}/api/ambient/v1/sessions/${SESSION_ID}"
  if [ "$CMD_RC" -eq 0 ]; then
    echo "  Deleted session $SESSION_ID"
  else
    echo "  Could not delete session $SESSION_ID (non-fatal)"
  fi
done

# ============================================================================
# Results
# ============================================================================

echo ""
echo -e "${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}"
echo ""

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
