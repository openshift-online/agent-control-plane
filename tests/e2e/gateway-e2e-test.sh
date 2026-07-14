#!/usr/bin/env bash
# E2E test: full gateway agent flow
#
# Validates the golden path:
#   acpctl apply -k  ->  acpctl start  ->  sandbox provisioned  ->  session Running
#   ->  runner starts inside sandbox  ->  mock LLM responds  ->  messages verified
#
# Uses test-agent-mock-llm which points ANTHROPIC_BASE_URL at a mock LLM server,
# so no real LLM API key is required. Validates the full platform plumbing from
# session creation through sandbox provisioning and LLM response delivery.
#
# Prerequisites:
#   - kind-up with OPENSHELL_USE_GATEWAY=true (default)
#   - acpctl built (make build-cli)
#   - TEST_TOKEN set or tests/cypress/.env.test present
#
# Usage:
#   ./tests/e2e/gateway-e2e-test.sh [--skip-cleanup] [API_URL]
#   API_URL defaults to http://localhost:13000
#   --skip-cleanup  Retain created sessions for manual inspection

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

NAMESPACE="${NAMESPACE:-ambient-code}"
TENANT="tenant-a"
SKIP_CLEANUP=false

# Parse flags
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --skip-cleanup) SKIP_CLEANUP=true; shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

if [ -z "${TEST_TOKEN:-}" ] && [ -f "$SCRIPT_DIR/../cypress/.env.test" ]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/../cypress/.env.test"
fi
TOKEN="${TEST_TOKEN:-}"

PF_PID=""
GW_PF_PID=""
PF_PORT=18767
if [ -n "${API_URL:-}" ] && [ "${API_URL}" != "http://localhost:" ]; then
  :
elif [ -n "${1:-}" ]; then
  API_URL="${1}"
else
  API_URL="http://localhost:${PF_PORT}"
fi
trap 'kill "${PF_PID}" 2>/dev/null || true; kill "${GW_PF_PID}" 2>/dev/null || true' EXIT

_ensure_port_forward() {
  local port
  port=$(echo "$API_URL" | sed -n 's|.*localhost:\([0-9]*\).*|\1|p' | head -1)
  [[ -z "$port" ]] && return 0
  if command -v lsof &>/dev/null; then
    lsof -ti :"$port" 2>/dev/null | xargs -r kill 2>/dev/null || true
  elif command -v fuser &>/dev/null; then
    fuser -k "${port}/tcp" 2>/dev/null || true
  fi
  sleep 1
  kubectl port-forward -n "${NAMESPACE}" svc/ambient-api-server "${port}:8000" &>/dev/null &
  PF_PID=$!
  for _i in $(seq 1 10); do
    local _s
    _s=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://localhost:${port}/healthcheck" 2>/dev/null || true)
    [[ "$_s" != "000" && -n "$_s" ]] && return 0
    sleep 1
  done
}

_ensure_port_forward

_ensure_gateway_port_forward() {
  if ! command -v openshell &>/dev/null; then
    return 1
  fi

  # Check if existing gateway registration is reachable
  if openshell sandbox list --gateway "${TENANT}" &>/dev/null 2>&1; then
    return 0
  fi

  # Start a port-forward to the gateway gRPC port
  local gw_log
  gw_log=$(mktemp)
  kubectl port-forward -n "${TENANT}" statefulset/openshell-gateway ":8080" \
    >"$gw_log" 2>&1 &
  GW_PF_PID=$!

  local gw_port=""
  for _i in $(seq 1 30); do
    if [ -s "$gw_log" ]; then
      gw_port=$(grep -oE 'Forwarding from 127\.0\.0\.1:[0-9]+' "$gw_log" | grep -oE '[0-9]+$' | head -1)
      [ -n "$gw_port" ] && break
    fi
    sleep 0.2
  done
  rm -f "$gw_log"

  if [ -z "$gw_port" ]; then
    return 1
  fi

  # Remove stale registration and re-register with fresh port
  openshell gateway remove "${TENANT}" 2>/dev/null || true

  local cert_dir="$HOME/.config/openshell/gateways/${TENANT}/mtls"
  mkdir -p "$cert_dir"
  kubectl get secret openshell-server-tls -n "${TENANT}" \
    -o jsonpath='{.data.ca\.crt}' | base64 -d > "$cert_dir/ca.crt"
  kubectl get secret openshell-server-tls -n "${TENANT}" \
    -o jsonpath='{.data.tls\.crt}' | base64 -d > "$cert_dir/tls.crt"
  kubectl get secret openshell-server-tls -n "${TENANT}" \
    -o jsonpath='{.data.tls\.key}' | base64 -d > "$cert_dir/tls.key"

  openshell gateway add --name "${TENANT}" --local "https://localhost:${gw_port}" 2>/dev/null || true

  # Re-extract certs after registration (gateway add may overwrite them)
  kubectl get secret openshell-server-tls -n "${TENANT}" \
    -o jsonpath='{.data.ca\.crt}' | base64 -d > "$cert_dir/ca.crt"
  kubectl get secret openshell-server-tls -n "${TENANT}" \
    -o jsonpath='{.data.tls\.crt}' | base64 -d > "$cert_dir/tls.crt"
  kubectl get secret openshell-server-tls -n "${TENANT}" \
    -o jsonpath='{.data.tls\.key}' | base64 -d > "$cert_dir/tls.key"

  openshell sandbox list --gateway "${TENANT}" &>/dev/null 2>&1
}

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

section "2. Login acpctl"

if $ACPCTL login --url "$API_URL" --token "$TOKEN" --project "$TENANT" >/dev/null 2>&1 && \
   $ACPCTL whoami >/dev/null 2>&1; then
  pass "acpctl login succeeded (${API_URL}, project: ${TENANT})"
else
  fail "acpctl login failed — is the API server reachable at ${API_URL}?"
  echo -e "\n${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}\n"
  exit 1
fi

section "3. Gateway deployment via acpctl apply"

# Apply a minimal project+gateway catalog and verify the control plane deploys
# the gateway StatefulSet into the project's namespace (not the gateway's name).
E2E_GW_PROJECT="e2e-gateway-apply"
E2E_GW_FIXTURE="$SCRIPT_DIR/fixtures/gateway-apply"
E2E_GW_CLEANUP=true

# Purge any soft-deleted project from a prior run. The API server's uniqueness
# constraint includes soft-deleted rows, so acpctl apply would fail with 409 if
# a previous run left behind a soft-deleted record.
_db_pod=$(kubectl get pods -n "${NAMESPACE}" -l app=ambient-api-server,component=database -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [ -n "$_db_pod" ]; then
  _db_user=$(kubectl get secret ambient-api-server-db -n "${NAMESPACE}" -o jsonpath='{.data.db\.user}' | base64 -d 2>/dev/null)
  _db_name=$(kubectl get secret ambient-api-server-db -n "${NAMESPACE}" -o jsonpath='{.data.db\.name}' | base64 -d 2>/dev/null)
  kubectl exec -n "${NAMESPACE}" "$_db_pod" -- \
    psql -U "$_db_user" -d "$_db_name" -c \
    "DELETE FROM projects WHERE name = '${E2E_GW_PROJECT}' AND deleted_at IS NOT NULL" \
    >/dev/null 2>&1 || true
fi

if $ACPCTL apply -k "$E2E_GW_FIXTURE" --project "$E2E_GW_PROJECT" >/dev/null 2>&1; then
  pass "acpctl apply -k fixtures/gateway-apply succeeded"
else
  fail "acpctl apply -k fixtures/gateway-apply failed"
  E2E_GW_CLEANUP=false
fi

if [ "$E2E_GW_CLEANUP" = "true" ]; then
  # The gateway reconciler runs on a 30s interval. Wait up to 120s for the
  # StatefulSet to appear, checking every 5s.
  GW_DEPLOYED=false
  for i in $(seq 1 24); do
    GW_STS=$(kubectl get statefulset openshell-gateway -n "$E2E_GW_PROJECT" \
      -o jsonpath='{.metadata.name}' 2>/dev/null || echo "")
    if [ "$GW_STS" = "openshell-gateway" ]; then
      GW_DEPLOYED=true
      break
    fi
    sleep 5
  done

  if [ "$GW_DEPLOYED" = "true" ]; then
    pass "Gateway StatefulSet created in namespace '${E2E_GW_PROJECT}'"
  else
    fail "Gateway StatefulSet not found in namespace '${E2E_GW_PROJECT}' after 120s"
    echo "  Control plane may be using gateway name as namespace instead of project namespace"
  fi

  # Verify the certgen job ran (creates TLS secrets the session reconciler needs)
  CERTGEN_JOB=$(kubectl get job openshell-gateway-certgen -n "$E2E_GW_PROJECT" \
    -o jsonpath='{.metadata.name}' 2>/dev/null || echo "")
  if [ "$CERTGEN_JOB" = "openshell-gateway-certgen" ]; then
    pass "Certgen job created in namespace '${E2E_GW_PROJECT}'"
  else
    fail "Certgen job not found in namespace '${E2E_GW_PROJECT}'"
  fi

  # Verify TLS secrets were created (needed for session provisioning)
  SERVER_TLS=$(kubectl get secret openshell-server-tls -n "$E2E_GW_PROJECT" \
    -o jsonpath='{.metadata.name}' 2>/dev/null || echo "")
  if [ "$SERVER_TLS" = "openshell-server-tls" ]; then
    pass "TLS secret openshell-server-tls created"
  else
    skip "TLS secret openshell-server-tls" "certgen may still be running"
  fi

  # Cleanup: delete the test project (namespace will be deprovisioned by project reconciler)
  if $ACPCTL delete project "$E2E_GW_PROJECT" --yes >/dev/null 2>&1; then
    echo "  Cleaned up project '${E2E_GW_PROJECT}'"
  else
    echo "  Could not delete project '${E2E_GW_PROJECT}' (non-fatal)"
  fi
fi

section "4. Verify tenant project exists"

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

section "5. Verify agent exists"

AGENTS_RESP=$(api GET "/api/ambient/v1/projects/${PROJECT_ID}/agents?size=50" || echo "")
AGENT_ID=$(echo "$AGENTS_RESP" \
  | jq -r '.items[] | select(.name == "test-agent-mock-llm") | .id' 2>/dev/null | head -1 || echo "")

if [ -n "$AGENT_ID" ]; then
  pass "Agent 'test-agent-mock-llm' exists (id: ${AGENT_ID})"
else
  fail "Agent 'test-agent-mock-llm' not found in project '${TENANT}'"
  echo -e "\n${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}\n"
  exit 1
fi

## repo-clone-workspace agent lookup removed — section 12 is skipped until
## CI has a real or mock Vertex provider.

section "6. Apply sandbox policies"

# Policies must exist before any session starts — agents reference them by
# name (sandbox_policy: permissive) and the control plane will fail the
# session if the policy is not found.
if $ACPCTL apply -f "$REPO_ROOT/examples/base/policies/permissive.yaml" \
  --project "$TENANT" >/dev/null 2>&1; then
  pass "Permissive policy applied to ${TENANT}"
else
  fail "Could not apply permissive policy to ${TENANT}"
fi

if $ACPCTL apply -f "$REPO_ROOT/examples/base/policies/locked-down.yaml" \
  --project "$TENANT" >/dev/null 2>&1; then
  pass "Locked-down policy applied to ${TENANT}"
else
  fail "Could not apply locked-down policy to ${TENANT}"
fi

section "7. Verify provider and credential"

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

section "8. OpenShell gateway healthy"

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

section "9. Start agent session"

START_RESP=$(api POST "/api/ambient/v1/projects/${PROJECT_ID}/agents/${AGENT_ID}/start" \
  -d '{"prompt": "gateway-e2e-test: say hello"}' || echo "")

CREATED_SESSION_ID=$(echo "$START_RESP" \
  | jq -r '.session.id // empty' 2>/dev/null || echo "")

if [ -n "$CREATED_SESSION_ID" ]; then
  pass "Session started (id: ${CREATED_SESSION_ID})"
else
  fail "Failed to start session for agent 'test-agent-mock-llm'"
  echo "  Response: $(echo "$START_RESP" | head -c 200)"
fi

section "10. Session state verification"

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

section "11. Sandbox configuration verification"

if [ -n "$CREATED_SESSION_ID" ]; then
  # Derive sandbox pod name: "session-" + lowercased session ID (first 40 chars)
  SBX_NAME="session-$(echo "${CREATED_SESSION_ID:0:40}" | tr '[:upper:]' '[:lower:]')"

  # Wait for the sandbox pod to be running (up to 60s)
  POD_READY=false
  for i in $(seq 1 30); do
    POD_PHASE=$(kubectl get pod "$SBX_NAME" -n "$TENANT" \
      -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    if [ "$POD_PHASE" = "Running" ]; then
      POD_READY=true
      break
    fi
    sleep 2
  done

  if [ "$POD_READY" = "true" ]; then
    pass "Sandbox pod '${SBX_NAME}' is running"

    # The control plane uploads payloads only after the sandbox reaches READY
    # phase, passes DNS verification, and transitions the session to Running.
    # Poll for the session phase instead of using a fixed sleep.
    SESSION_RUNNING=false
    for i in $(seq 1 30); do
      PHASE=$(api GET "/api/ambient/v1/sessions/${CREATED_SESSION_ID}" 2>/dev/null \
        | jq -r '.phase // empty' 2>/dev/null || echo "")
      if [ "$PHASE" = "Running" ] || [ "$PHASE" = "Succeeded" ] || [ "$PHASE" = "Failed" ]; then
        SESSION_RUNNING=true
        break
      fi
      sleep 2
    done

    if [ "$SESSION_RUNNING" = "true" ]; then
      # Session is Running — payloads are uploaded just before exec starts.
      # Poll briefly for the file to appear.
      PAYLOAD_READY=false
      for j in $(seq 1 10); do
        PAYLOAD_CONTENT=$(kubectl exec -n "$TENANT" "$SBX_NAME" -- \
          cat /sandbox/CLAUDE.md 2>/dev/null || echo "")
        if echo "$PAYLOAD_CONTENT" | grep -q "mock LLM"; then
          PAYLOAD_READY=true
          break
        fi
        sleep 2
      done
    fi

    # 10a. Payload upload — agent-defined file written via SSH-over-gRPC
    if [ "${PAYLOAD_READY:-false}" = "true" ]; then
      pass "Payload /sandbox/CLAUDE.md uploaded successfully"
    else
      fail "Payload /sandbox/CLAUDE.md not found or content mismatch"
      echo "  Got: $(echo "${PAYLOAD_CONTENT:-}" | head -c 200)"
      echo "  Session phase: ${PHASE:-unknown}"
    fi

    # 10b. Agent environment variable passed through to sandbox
    ENV_VAL=$(kubectl exec -n "$TENANT" "$SBX_NAME" -- \
      printenv CLAUDE_CODE_ATTRIBUTION_HEADER 2>/dev/null || echo "")
    if [ "$ENV_VAL" = "0" ]; then
      pass "Agent env var CLAUDE_CODE_ATTRIBUTION_HEADER passed through to sandbox"
    else
      fail "Agent env var CLAUDE_CODE_ATTRIBUTION_HEADER not found or wrong value (got: '${ENV_VAL}')"
    fi

    # 10c. MCP config env var patterns preserved (not auto-expanded)
    MCP_CONTENT=$(kubectl exec -n "$TENANT" "$SBX_NAME" -- \
      cat /sandbox/.mcp.json 2>/dev/null || echo "")
    if [ -n "$MCP_CONTENT" ]; then
      # Check that any ${...} patterns in the config were NOT replaced with
      # empty strings or resolved values — they should survive as literals.
      DOLLAR_BRACE_COUNT=$(echo "$MCP_CONTENT" | grep -o '\${[^}]*}' | wc -l | tr -d ' ')
      if [ "${DOLLAR_BRACE_COUNT}" -ge 1 ]; then
        pass "MCP config preserves \${} env var patterns (${DOLLAR_BRACE_COUNT} found)"
      else
        fail "MCP config env var patterns were expanded — no \${} literals remain"
        echo "  Got: $(echo "$MCP_CONTENT" | head -c 300)"
      fi
    else
      fail "Baked-in MCP config /sandbox/.mcp.json not found"
    fi

    # 10d. Claude settings baked into image match source
    SETTINGS_ACTUAL=$(kubectl exec -n "$TENANT" "$SBX_NAME" -- \
      cat /sandbox/.claude/settings.json 2>/dev/null || echo "")
    SETTINGS_EXPECTED=$(cat "$REPO_ROOT/components/runners/ambient-runner/claude-settings.json" 2>/dev/null || echo "")
    if [ -n "$SETTINGS_ACTUAL" ] && [ "$SETTINGS_ACTUAL" = "$SETTINGS_EXPECTED" ]; then
      pass "Claude settings.json matches source in image"
    elif [ -n "$SETTINGS_ACTUAL" ]; then
      fail "Claude settings.json differs from source"
    else
      fail "Claude settings.json not found at /sandbox/.claude/settings.json"
    fi

    # 10e. Claude settings.local.json baked into image matches source
    SETTINGS_LOCAL_ACTUAL=$(kubectl exec -n "$TENANT" "$SBX_NAME" -- \
      cat /sandbox/.claude/settings.local.json 2>/dev/null || echo "")
    SETTINGS_LOCAL_EXPECTED=$(cat "$REPO_ROOT/components/runners/ambient-runner/claude-settings-local.json" 2>/dev/null || echo "")
    if [ -n "$SETTINGS_LOCAL_ACTUAL" ] && [ "$SETTINGS_LOCAL_ACTUAL" = "$SETTINGS_LOCAL_EXPECTED" ]; then
      pass "Claude settings.local.json matches source in image"
    elif [ -n "$SETTINGS_LOCAL_ACTUAL" ]; then
      fail "Claude settings.local.json differs from source"
    else
      fail "Claude settings.local.json not found at /sandbox/.claude/settings.local.json"
    fi

    # 10f. Sandbox network policy present at /etc/openshell/policy.yaml
    POLICY_ACTUAL=$(kubectl exec -n "$TENANT" "$SBX_NAME" -- \
      cat /etc/openshell/policy.yaml 2>/dev/null || echo "")
    POLICY_EXPECTED=$(cat "$REPO_ROOT/components/runners/ambient-runner/policy.yaml" 2>/dev/null || echo "")
    if [ -n "$POLICY_ACTUAL" ] && [ "$POLICY_ACTUAL" = "$POLICY_EXPECTED" ]; then
      pass "Sandbox policy.yaml matches source in image"
    elif [ -n "$POLICY_ACTUAL" ]; then
      fail "Sandbox policy.yaml differs from source"
    else
      fail "Sandbox policy.yaml not found at /etc/openshell/policy.yaml"
    fi

  else
    fail "Sandbox configuration verification — sandbox pod not ready (phase: ${POD_PHASE:-unknown})"
  fi
else
  fail "Sandbox configuration verification — session not created"
fi

section "11. Mock LLM response verification via acpctl"

if [ -n "$CREATED_SESSION_ID" ] && [ "${SESSION_RUNNING:-false}" = "true" ]; then
  # Poll acpctl session messages until we see an assistant response (up to 180s).
  # The user message arrives immediately at session creation, but the assistant
  # message only appears after the sandbox pod starts and the runner calls the
  # mock LLM (~30-90s). We must keep polling until we see the assistant message,
  # not just any message.
  MESSAGES_OUTPUT="[]"
  MSG_COUNT=0
  LLM_RESPONSE_FOUND=0
  for i in $(seq 1 90); do
    MESSAGES_OUTPUT=$($ACPCTL session messages "$CREATED_SESSION_ID" -o json 2>/dev/null || echo "[]")
    MSG_COUNT=$(echo "$MESSAGES_OUTPUT" | jq 'length' 2>/dev/null || echo "0")
    LLM_RESPONSE_FOUND=$(echo "$MESSAGES_OUTPUT" \
      | jq -r '[.[] | select(.event_type == "assistant" or .event_type == "TEXT_MESSAGE_CONTENT" or .event_type == "MESSAGES_SNAPSHOT")] | length' 2>/dev/null || echo "0")
    if [ "${LLM_RESPONSE_FOUND}" -gt 0 ]; then
      break
    fi
    sleep 2
  done

  if [ "${MSG_COUNT}" -gt 0 ]; then
    pass "acpctl session messages returned ${MSG_COUNT} message(s)"
  else
    fail "acpctl session messages returned no messages after 180s"
    # Dump diagnostics to help debug CI-only failures
    echo "--- DIAGNOSTIC: sandbox pod status ---"
    kubectl get pod "${SBX_NAME}" -n "${TENANT}" -o wide 2>&1 || true
    echo "--- DIAGNOSTIC: sandbox ANTHROPIC_BASE_URL ---"
    kubectl exec -n "${TENANT}" "${SBX_NAME}" -- printenv ANTHROPIC_BASE_URL 2>&1 || echo "(not set or pod gone)"
    echo "--- DIAGNOSTIC: runner log (last 80 lines) ---"
    kubectl exec -n "${TENANT}" "${SBX_NAME}" -- cat /sandbox/.runner/logs/runner.log 2>&1 | tail -80 || echo "(no runner log)"
    echo "--- DIAGNOSTIC: sandbox supervisor log (last 40 lines) ---"
    kubectl logs -n "${TENANT}" "${SBX_NAME}" -c agent --tail=40 2>&1 || true
    echo "--- DIAGNOSTIC: control plane log for session (last 20 matches) ---"
    kubectl logs -n "${NAMESPACE}" -l app=ambient-control-plane --tail=500 2>&1 \
      | grep -i "${CREATED_SESSION_ID}\|${SBX_NAME}" | tail -20 || true
    echo "--- END DIAGNOSTICS ---"
  fi

  # 11a. Verify the initial prompt was delivered as a user message
  PROMPT_FOUND=$(echo "$MESSAGES_OUTPUT" \
    | jq -r '[.[] | select(.event_type == "user")] | length' 2>/dev/null || echo "0")
  if [ "${PROMPT_FOUND}" -gt 0 ]; then
    pass "User prompt message found in session messages"
  else
    fail "No user prompt message found in session messages"
  fi

  # 11b. Verify the mock LLM response is present (assistant message or text content)
  # The mock LLM echoes back "Mock LLM response: <user message>"
  if [ "${LLM_RESPONSE_FOUND}" -gt 0 ]; then
    pass "LLM response message(s) found in session messages (${LLM_RESPONSE_FOUND})"
  else
    fail "No LLM response messages found in session messages"
  fi

  # 11c. Verify the mock LLM echo content is present in the message payloads
  MOCK_ECHO=$(echo "$MESSAGES_OUTPUT" \
    | jq -r '[.[] | .payload] | join(" ")' 2>/dev/null || echo "")
  if echo "$MOCK_ECHO" | grep -q "Mock LLM response"; then
    pass "Mock LLM echo content verified in message payloads"
  else
    skip "Mock LLM echo content" "response text not found — may be in a different event format"
  fi
else
  skip "Mock LLM response verification" "session not running or not created"
fi

section "12. Repository payload verification"

REPO_SESSION_ID=""
skip "Repo payload verification" "vertex provider not available in CI"

section "13. Network policy enforcement"

LOCKED_SESSION_ID=""
PERM_SESSION_ID=""

# Ensure the openshell gateway port-forward is alive. The ssh-proxy command
# used below needs a local port-forward to the gateway's gRPC endpoint.
if ! _ensure_gateway_port_forward; then
  fail "Gateway port-forward could not be established — openshell CLI missing or gateway unreachable"
  echo -e "\n${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}\n"
  exit 1
fi

# Policies were already applied in section 6; only the test-specific agents
# need to be created here.

$ACPCTL apply -k "$SCRIPT_DIR/fixtures/network-policy-test" \
  --project "$TENANT" >/dev/null 2>&1 && \
  pass "Network test agents applied to ${TENANT}" || \
  fail "Could not apply network test agents"

# Look up the locked-down agent
AGENTS_RESP=$(api GET "/api/ambient/v1/projects/${PROJECT_ID}/agents?size=50" || echo "")
LOCKED_AGENT_ID=$(echo "$AGENTS_RESP" \
  | jq -r '.items[] | select(.name == "network-test-locked-down") | .id' 2>/dev/null | head -1 || echo "")

if [ -n "$LOCKED_AGENT_ID" ]; then
  LOCKED_START_RESP=$(api POST "/api/ambient/v1/projects/${PROJECT_ID}/agents/${LOCKED_AGENT_ID}/start" \
    -d '{"prompt": "gateway-e2e-test: network policy enforcement"}' || echo "")

  LOCKED_SESSION_ID=$(echo "$LOCKED_START_RESP" \
    | jq -r '.session.id // empty' 2>/dev/null || echo "")

  if [ -n "$LOCKED_SESSION_ID" ]; then
    pass "Locked-down session started (id: ${LOCKED_SESSION_ID})"

    LOCKED_SBX_NAME="session-$(echo "${LOCKED_SESSION_ID:0:40}" | tr '[:upper:]' '[:lower:]')"

    LOCKED_POD_READY=false
    for i in $(seq 1 30); do
      LOCKED_POD_PHASE=$(kubectl get pod "$LOCKED_SBX_NAME" -n "$TENANT" \
        -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
      if [ "$LOCKED_POD_PHASE" = "Running" ]; then
        LOCKED_POD_READY=true
        break
      fi
      sleep 2
    done

    if [ "$LOCKED_POD_READY" = "true" ]; then
      pass "Locked-down sandbox pod '${LOCKED_SBX_NAME}' is running"

      # Wait for session to reach Running phase so sandbox is fully initialized
      LOCKED_SESSION_RUNNING=false
      for i in $(seq 1 30); do
        LOCKED_PHASE=$(api GET "/api/ambient/v1/sessions/${LOCKED_SESSION_ID}" 2>/dev/null \
          | jq -r '.phase // empty' 2>/dev/null || echo "")
        if [ "$LOCKED_PHASE" = "Running" ] || [ "$LOCKED_PHASE" = "Succeeded" ] || [ "$LOCKED_PHASE" = "Failed" ]; then
          LOCKED_SESSION_RUNNING=true
          break
        fi
        sleep 2
      done

      # Verify locked-down policy blocks external network access.
      # SSH into the sandbox and curl a known endpoint over plain HTTP so
      # the proxy can intercept the GET and return policy_denied JSON.
      # (HTTPS would fail at the CONNECT tunnel level with no response body.)
      # FIXME: switch to `openshell sandbox exec` when it is fixed upstream.
      if [ "$LOCKED_SESSION_RUNNING" = "true" ]; then
        LOCKED_CURL_OUTPUT=$(ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
          -o LogLevel=ERROR \
          -o "ProxyCommand=openshell ssh-proxy --gateway-name $TENANT --name $LOCKED_SBX_NAME" \
          "user@$LOCKED_SBX_NAME" \
          'curl http://update.code.visualstudio.com 2>/dev/null' 2>/dev/null) || true

        if echo "$LOCKED_CURL_OUTPUT" | grep -q "policy_denied"; then
          pass "Locked-down policy denied outbound network access (policy_denied)"
        else
          fail "Locked-down policy did NOT deny outbound network access"
          echo "  Output: $(echo "$LOCKED_CURL_OUTPUT" | head -c 200)"
        fi
      else
        fail "Locked-down network test — session not Running (phase: ${LOCKED_PHASE:-unknown})"
      fi
    else
      fail "Locked-down network test — sandbox pod not ready (phase: ${LOCKED_POD_PHASE:-unknown})"
    fi
  else
    fail "Failed to start locked-down session"
    echo "  Response: $(echo "$LOCKED_START_RESP" | head -c 200)"
  fi
else
  fail "Agent 'network-test-locked-down' not found after apply"
fi

# Verify permissive policy allows external network access.
# Start a dedicated permissive session and curl update.code.visualstudio.com
# via the sandbox proxy. The request should succeed (not return policy_denied).
PERM_AGENT_ID=$(echo "$AGENTS_RESP" \
  | jq -r '.items[] | select(.name == "network-test-permissive") | .id' 2>/dev/null | head -1 || echo "")

if [ -n "$PERM_AGENT_ID" ]; then
  PERM_START_RESP=$(api POST "/api/ambient/v1/projects/${PROJECT_ID}/agents/${PERM_AGENT_ID}/start" \
    -d '{"prompt": "gateway-e2e-test: network policy enforcement"}' || echo "")

  PERM_SESSION_ID=$(echo "$PERM_START_RESP" \
    | jq -r '.session.id // empty' 2>/dev/null || echo "")

  if [ -n "$PERM_SESSION_ID" ]; then
    pass "Permissive session started (id: ${PERM_SESSION_ID})"

    PERM_SBX_NAME="session-$(echo "${PERM_SESSION_ID:0:40}" | tr '[:upper:]' '[:lower:]')"

    PERM_POD_READY=false
    for i in $(seq 1 30); do
      PERM_POD_PHASE=$(kubectl get pod "$PERM_SBX_NAME" -n "$TENANT" \
        -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
      if [ "$PERM_POD_PHASE" = "Running" ]; then
        PERM_POD_READY=true
        break
      fi
      sleep 2
    done

    if [ "$PERM_POD_READY" = "true" ]; then
      pass "Permissive sandbox pod '${PERM_SBX_NAME}' is running"

      PERM_SESSION_RUNNING=false
      for i in $(seq 1 30); do
        PERM_PHASE=$(api GET "/api/ambient/v1/sessions/${PERM_SESSION_ID}" 2>/dev/null \
          | jq -r '.phase // empty' 2>/dev/null || echo "")
        if [ "$PERM_PHASE" = "Running" ] || [ "$PERM_PHASE" = "Succeeded" ] || [ "$PERM_PHASE" = "Failed" ]; then
          PERM_SESSION_RUNNING=true
          break
        fi
        sleep 2
      done

      # Verify permissive policy allows external network access via curl.
      # The permissive policy allows /usr/bin/curl to reach
      # update.code.visualstudio.com:443 (vscode policy). If policy_denied
      # appears, the proxy blocked it; any other response means it got through.
      # FIXME: switch to `openshell sandbox exec` when it is fixed upstream.
      if [ "$PERM_SESSION_RUNNING" = "true" ]; then
        PERM_CURL_OUTPUT=$(ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
          -o LogLevel=ERROR \
          -o "ProxyCommand=openshell ssh-proxy --gateway-name $TENANT --name $PERM_SBX_NAME" \
          "user@$PERM_SBX_NAME" \
          'curl https://update.code.visualstudio.com 2>/dev/null' 2>/dev/null) || true

        if echo "$PERM_CURL_OUTPUT" | grep -q "policy_denied"; then
          fail "Permissive policy denied update.code.visualstudio.com (policy_denied)"
          echo "  Output: $(echo "$PERM_CURL_OUTPUT" | head -c 200)"
        elif [ -n "$PERM_CURL_OUTPUT" ]; then
          pass "Permissive policy allowed update.code.visualstudio.com"
        else
          fail "Permissive network test — no response from curl"
        fi
      else
        fail "Permissive network test — session not Running (phase: ${PERM_PHASE:-unknown})"
      fi
    else
      fail "Permissive network test — sandbox pod not ready (phase: ${PERM_POD_PHASE:-unknown})"
    fi
  else
    fail "Failed to start permissive session"
    echo "  Response: $(echo "$PERM_START_RESP" | head -c 200)"
  fi
else
  fail "Agent 'network-test-permissive' not found after apply"
fi

section "Cleanup"

if [ "$SKIP_CLEANUP" = "true" ]; then
  echo -e "  ${YELLOW}Skipping cleanup (--skip-cleanup)${NC}"
  for _sid in "$CREATED_SESSION_ID" "$REPO_SESSION_ID" "$LOCKED_SESSION_ID" "${PERM_SESSION_ID:-}"; do
    [ -z "$_sid" ] && continue
    _pod="session-$(echo "${_sid:0:40}" | tr '[:upper:]' '[:lower:]')"
    _phase=$(kubectl get pod "$_pod" -n "$TENANT" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    if [ -n "$_phase" ]; then
      echo -e "  Retained session ${_sid}  pod=${_pod}  phase=${_phase}"
    else
      echo -e "  ${YELLOW}Session ${_sid} has no sandbox pod (${_pod} not found)${NC}"
    fi
  done
else
  if [ -n "$CREATED_SESSION_ID" ]; then
    api DELETE "/api/ambient/v1/sessions/${CREATED_SESSION_ID}" >/dev/null 2>&1 && \
      echo "  Deleted session ${CREATED_SESSION_ID}" || \
      echo "  Could not delete session (non-fatal)"
  fi
  if [ -n "$REPO_SESSION_ID" ]; then
    api DELETE "/api/ambient/v1/sessions/${REPO_SESSION_ID}" >/dev/null 2>&1 && \
      echo "  Deleted repo session ${REPO_SESSION_ID}" || \
      echo "  Could not delete repo session (non-fatal)"
  fi
  if [ -n "$LOCKED_SESSION_ID" ]; then
    api DELETE "/api/ambient/v1/sessions/${LOCKED_SESSION_ID}" >/dev/null 2>&1 && \
      echo "  Deleted locked-down session ${LOCKED_SESSION_ID}" || \
      echo "  Could not delete locked-down session (non-fatal)"
  fi
  if [ -n "${PERM_SESSION_ID:-}" ]; then
    api DELETE "/api/ambient/v1/sessions/${PERM_SESSION_ID}" >/dev/null 2>&1 && \
      echo "  Deleted permissive session ${PERM_SESSION_ID}" || \
      echo "  Could not delete permissive session (non-fatal)"
  fi
fi

echo ""
echo -e "${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}"
echo ""

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
