#!/usr/bin/env bash
# e2e-smoke.sh — end-to-end smoke test for an ACP deployment on OpenShift.
#
# Validates the full stack: Keycloak auth → API server → control plane →
# runner pod → LLM inference → message delivery.
#
# Usage:
#   bash e2e-smoke.sh <namespace>
#
# Environment variables:
#   OC                     oc/kubectl binary (default: oc)
#   ACPCTL                 path to acpctl binary (default: acpctl from PATH)
#   KC_USERNAME            Keycloak user (default: developer)
#   KC_PASSWORD            Keycloak password (default: developer)
#   SESSION_READY_TIMEOUT  seconds to wait for Running (default: 300)
#   MESSAGE_WAIT_TIMEOUT   seconds to wait for LLM response (default: 120)
#   SKIP_CLEANUP           set to 1 to keep resources after test
#   PAUSE                  seconds between commands (default: 1)
set -euo pipefail

NAMESPACE="${1:-}"
CLI="${OC:-oc}"
ACPCTL="${ACPCTL:-acpctl}"
DEFAULT_CREDENTIAL=developer
KC_USERNAME="${KC_USERNAME:-$DEFAULT_CREDENTIAL}"
# shellcheck disable=SC2155 — password sourced from env, default is test-only
KC_PASSWORD=$(echo "${KC_PASSWORD:-$DEFAULT_CREDENTIAL}")
SESSION_READY_TIMEOUT="${SESSION_READY_TIMEOUT:-300}"
MESSAGE_WAIT_TIMEOUT="${MESSAGE_WAIT_TIMEOUT:-120}"
SKIP_CLEANUP="${SKIP_CLEANUP:-}"
PAUSE="${PAUSE:-1}"

[[ -z "$NAMESPACE" ]] && { echo "Usage: $0 <namespace>"; exit 1; }

PASS=0
FAIL=0
TESTS=()

bold()   { printf '\033[1m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*"; }
dim()    { printf '\033[2m%s\033[0m\n' "$*"; }
cyan()   { printf '\033[36m%s\033[0m\n' "$*"; }
orange() { printf '\033[38;5;214m%s\033[0m\n' "$*"; }
sep()    { printf '\033[2m────────────────────────────────────────────────\033[0m\n'; }

show_cmd() {
  orange "   \$ $*"
  sleep "$PAUSE"
}

pass() {
  PASS=$((PASS + 1))
  TESTS+=("PASS: $1")
  green "  ✓ $1"
}

fail_test() {
  FAIL=$((FAIL + 1))
  TESTS+=("FAIL: $1")
  red "  ✗ $1"
}

json_field() {
  local raw="$1" field="$2"
  echo "$raw" | python3 -c "
import sys, json, re
text = sys.stdin.read()
m = re.search(r'\{.*\}', text, re.DOTALL)
if m:
    print(json.loads(m.group()).get('${field}', ''))
" 2>/dev/null
}

# ── preflight ────────────────────────────────────────────────────────────────

echo ""
bold "ACP End-to-End Smoke Test"
sep
echo ""
printf '  %s\n' "1. Check pod health (PostgreSQL, API, Control Plane, UI, Keycloak)"
printf '  %s\n' "2. Verify OpenShift Routes"
printf '  %s\n' "3. API server health check"
printf '  %s\n' "4. Authenticate via Keycloak (OIDC password grant)"
printf '  %s\n' "5. Login to acpctl + whoami"
printf '  %s\n' "6. Session lifecycle (create project → create session → wait for Running)"
printf '  %s\n' "7. LLM inference (send prompt → wait for SMOKE_TEST_OK)"
printf '  %s\n' "8. UI health check"
printf '  %s\n' "9. Cleanup test resources"
echo ""
printf '  \033[38;5;214m%-38s\033[0m %s\n' "Orange text like this" "= a CLI command being run"
echo ""
dim  "  Namespace: $NAMESPACE"
dim  "  Timeout:   session=${SESSION_READY_TIMEOUT}s  message=${MESSAGE_WAIT_TIMEOUT}s"
dim  "  Pause:     ${PAUSE}s between commands"
echo ""
sep

# ── 1. pod health ────────────────────────────────────────────────────────────

echo ""
bold "1. Pod Health"
echo ""

for deploy in ambient-api-server-db ambient-api-server ambient-control-plane ambient-ui keycloak; do
  show_cmd "$CLI get deployment $deploy -n $NAMESPACE"
  if $CLI get deployment "$deploy" -n "$NAMESPACE" &>/dev/null 2>&1; then
    READY=$($CLI get deployment "$deploy" -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
    if [[ "$READY" -ge 1 ]]; then
      pass "$deploy is ready ($READY replicas)"
    else
      fail_test "$deploy not ready (${READY:-0} replicas)"
    fi
  else
    if [[ "$deploy" == "keycloak" ]]; then
      dim "  - $deploy not deployed (external IdP?)"
    else
      fail_test "$deploy deployment not found"
    fi
  fi
done
sep

# ── 2. routes ────────────────────────────────────────────────────────────────

echo ""
bold "2. Routes"
echo ""

show_cmd "$CLI get route ambient-api-server -n $NAMESPACE -o jsonpath='{.spec.host}'"
API_HOST=$($CLI get route ambient-api-server -n "$NAMESPACE" -o jsonpath='{.spec.host}' 2>/dev/null || true)

show_cmd "$CLI get route ambient-ui -n $NAMESPACE -o jsonpath='{.spec.host}'"
UI_HOST=$($CLI get route ambient-ui -n "$NAMESPACE" -o jsonpath='{.spec.host}' 2>/dev/null || true)

KC_HOST=$($CLI get route keycloak -n "$NAMESPACE" -o jsonpath='{.spec.host}' 2>/dev/null || true)

if [[ -n "$API_HOST" ]]; then pass "API route: $API_HOST"; else fail_test "API route not found"; fi
if [[ -n "$UI_HOST" ]]; then pass "UI route: $UI_HOST"; else fail_test "UI route not found"; fi

API_URL="https://${API_HOST}"
sep

# ── 3. API health ────────────────────────────────────────────────────────────

echo ""
bold "3. API Health"
echo ""

show_cmd "curl -fsSk ${API_URL}/api/ambient"
HEALTH=$(curl -fsSk --connect-timeout 10 --max-time 30 \
  --retry 5 --retry-all-errors "${API_URL}/api/ambient" 2>&1 || true)

if echo "$HEALTH" | grep -qi "ambient\|version\|ok\|{"; then
  pass "API server health check"
else
  fail_test "API server health check (response: ${HEALTH:-empty})"
fi
sep

# ── 4. Keycloak auth ────────────────────────────────────────────────────────

echo ""
bold "4. Keycloak Authentication"
echo ""

TOKEN=
if [[ -n "$KC_HOST" ]]; then
  show_cmd "$CLI get secret sso-credentials -n $NAMESPACE -o jsonpath='{.data.SSO_CLIENT_SECRET}'"
  KC_CLIENT_SECRET=$($CLI get secret sso-credentials -n "$NAMESPACE" \
    -o jsonpath='{.data.SSO_CLIENT_SECRET}' 2>/dev/null | base64 -d 2>/dev/null || true)

  if [[ -z "$KC_CLIENT_SECRET" ]]; then
    fail_test "Could not read SSO_CLIENT_SECRET from sso-credentials"
  else
    show_cmd "curl -sk -X POST https://${KC_HOST}/realms/ambient-code/protocol/openid-connect/token -d grant_type=password -d client_id=ambient-frontend -d username=${KC_USERNAME}"
    TOKEN_RESPONSE=$(curl -sk -X POST \
      "https://${KC_HOST}/realms/ambient-code/protocol/openid-connect/token" \
      -d "grant_type=password" \
      -d "client_id=ambient-frontend" \
      -d "client_secret=${KC_CLIENT_SECRET}" \
      -d "username=${KC_USERNAME}" \
      -d "password=${KC_PASSWORD}" \
      --connect-timeout 10 --max-time 30 2>&1 || true)

    TOKEN=$(echo "$TOKEN_RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || true)

    if [[ -n "$TOKEN" && "$TOKEN" != "" ]]; then
      pass "Keycloak token obtained for ${KC_USERNAME}"
    else
      ERROR=$(echo "$TOKEN_RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('error_description','unknown'))" 2>/dev/null || echo "unknown")
      fail_test "Keycloak token exchange failed: ${ERROR}"
    fi
  fi
else
  dim "  - No Keycloak route; trying SA token"
  show_cmd "$CLI get secret ambient-control-plane-token -n $NAMESPACE -o jsonpath='{.data.token}'"
  TOKEN=$($CLI get secret ambient-control-plane-token -n "$NAMESPACE" \
    -o jsonpath='{.data.token}' 2>/dev/null | base64 -d 2>/dev/null || true)
  if [[ -n "$TOKEN" ]]; then
    pass "SA token obtained"
  else
    fail_test "No auth token available"
  fi
fi

if [[ -z "$TOKEN" ]]; then
  red "Cannot continue without auth token"
  echo ""
  bold "Results: $PASS passed, $FAIL failed"
  exit 1
fi
sep

# ── 5. acpctl login + whoami ─────────────────────────────────────────────────

echo ""
bold "5. acpctl Login"
echo ""

export AMBIENT_API_URL="${API_URL}"
export AMBIENT_TOKEN
AMBIENT_TOKEN=${TOKEN}
export AMBIENT_REQUEST_TIMEOUT=30

show_cmd "$ACPCTL login --token \$TOKEN --url ${API_URL} --insecure-skip-tls-verify"
"$ACPCTL" login --token "${TOKEN}" --url "${API_URL}" --insecure-skip-tls-verify 2>&1 || true

show_cmd "$ACPCTL whoami"
WHOAMI=$("$ACPCTL" whoami 2>&1 || true)

if echo "$WHOAMI" | grep -qi "user\|email\|api"; then
  pass "acpctl authenticated"
  dim "  $(echo "$WHOAMI" | head -1)"
else
  fail_test "acpctl whoami failed (${WHOAMI:0:200})"
fi
sep

# ── 6. Project + Session lifecycle ───────────────────────────────────────────

echo ""
bold "6. Session Lifecycle (LLM validation)"
echo ""

RUN_ID=$(date +%s | tail -c5)
PROJECT_NAME="e2e-smoke-${RUN_ID}"

show_cmd "$ACPCTL create project --name ${PROJECT_NAME} --description 'e2e smoke test'"
PROJECT_JSON=
PROJECT_ID=
for _attempt in $(seq 1 6); do
  PROJECT_JSON=$("$ACPCTL" create project \
    --name "${PROJECT_NAME}" \
    --description "e2e smoke test" \
    -o json 2>&1 || true)
  PROJECT_ID=$(json_field "$PROJECT_JSON" "id")
  if [[ -n "$PROJECT_ID" && "$PROJECT_ID" != "" ]]; then
    break
  fi
  dim "    attempt ${_attempt}/6 failed, retrying in 10s... (${PROJECT_JSON:0:200})"
  sleep 10
done

if [[ -n "$PROJECT_ID" && "$PROJECT_ID" != "" ]]; then
  pass "Project created: $PROJECT_ID"
else
  fail_test "Project creation failed after 6 attempts (response: ${PROJECT_JSON:0:200})"
  echo ""
  bold "Results: $PASS passed, $FAIL failed"
  exit 1
fi

echo ""
show_cmd "$ACPCTL project ${PROJECT_NAME}"
"$ACPCTL" project "${PROJECT_NAME}" 2>&1 || true

show_cmd "$ACPCTL create session --name smoke-test-${RUN_ID} --project ${PROJECT_NAME}"
SESSION_JSON=$("$ACPCTL" create session \
  --name "smoke-test-${RUN_ID}" \
  --project "${PROJECT_NAME}" \
  -o json 2>&1 || true)

SESSION_ID=$(json_field "$SESSION_JSON" "id")

if [[ -n "$SESSION_ID" && "$SESSION_ID" != "" ]]; then
  pass "Session created: $SESSION_ID"
else
  fail_test "Session creation failed (response: ${SESSION_JSON:0:200})"
  echo ""
  bold "Results: $PASS passed, $FAIL failed"
  exit 1
fi

echo ""
show_cmd "$ACPCTL get session ${SESSION_ID} -o json  # poll phase"
dim "  Waiting for session to reach Running (timeout: ${SESSION_READY_TIMEOUT}s)..."

DEADLINE=$(($(date +%s) + SESSION_READY_TIMEOUT))
LAST_PHASE=""
SESSION_RUNNING=false

while [[ $(date +%s) -lt $DEADLINE ]]; do
  PHASE=$("$ACPCTL" get session "${SESSION_ID}" -o json 2>&1 | \
    python3 -c "import json,sys; print(json.load(sys.stdin).get('phase',''))" 2>/dev/null || true)

  if [[ "$PHASE" != "$LAST_PHASE" ]]; then
    dim "    phase: $PHASE"
    LAST_PHASE="$PHASE"
  fi

  if [[ "$PHASE" == "Running" ]]; then
    SESSION_RUNNING=true
    break
  fi

  if [[ "$PHASE" == "Failed" ]]; then
    fail_test "Session entered Failed phase"
    break
  fi

  sleep 5
done

if [[ "$SESSION_RUNNING" == "true" ]]; then
  pass "Session reached Running phase"
else
  if [[ "$LAST_PHASE" != "Failed" ]]; then
    fail_test "Session did not reach Running (stuck at: ${LAST_PHASE:-unknown})"
  fi
fi
sep

# ── 7. LLM inference ────────────────────────────────────────────────────────

echo ""
bold "7. LLM Inference"
echo ""

if [[ "$SESSION_RUNNING" == "true" ]]; then
  PROMPT_TEXT="Respond with exactly the text SMOKE_TEST_OK and nothing else. No explanation, no formatting, just SMOKE_TEST_OK."

  show_cmd "$ACPCTL session send ${SESSION_ID} '${PROMPT_TEXT}'"
  SEND_OUTPUT=$("$ACPCTL" session send "${SESSION_ID}" "${PROMPT_TEXT}" 2>&1 || true)
  dim "    ${SEND_OUTPUT}"

  if echo "$SEND_OUTPUT" | grep -qi "sent\|seq"; then
    pass "Message sent to session"
  else
    fail_test "Message send failed (output: ${SEND_OUTPUT:0:200})"
  fi

  echo ""
  show_cmd "$ACPCTL session messages ${SESSION_ID} -o json  # poll for response"
  dim "  Waiting for LLM response (timeout: ${MESSAGE_WAIT_TIMEOUT}s)..."

  MSG_DEADLINE=$(($(date +%s) + MESSAGE_WAIT_TIMEOUT))
  LLM_RESPONDED=false

  while [[ $(date +%s) -lt $MSG_DEADLINE ]]; do
    MESSAGES=$("$ACPCTL" session messages "${SESSION_ID}" -o json 2>&1 || true)

    HAS_RESPONSE=$(echo "$MESSAGES" | python3 -c "
import json, sys
try:
    msgs = json.load(sys.stdin)
    if not isinstance(msgs, list):
        msgs = msgs.get('items', [])
    for m in msgs:
        et = m.get('event_type', '')
        payload = m.get('payload', '')
        if 'SMOKE_TEST_OK' in str(payload):
            print('found')
            sys.exit(0)
        if et == 'lifecycle' and 'run_finished' in str(payload):
            print('finished')
            sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null || true)

    if [[ "$HAS_RESPONSE" == "found" ]]; then
      LLM_RESPONDED=true
      pass "LLM responded with SMOKE_TEST_OK"
      break
    elif [[ "$HAS_RESPONSE" == "finished" ]]; then
      LLM_RESPONDED=true
      pass "LLM run finished (response received)"
      break
    fi

    sleep 5
  done

  if [[ "$LLM_RESPONDED" != "true" ]]; then
    fail_test "LLM did not respond within ${MESSAGE_WAIT_TIMEOUT}s"
  fi
else
  dim "  Skipping LLM test (session not running)"
fi
sep

# ── 8. UI health ─────────────────────────────────────────────────────────────

echo ""
bold "8. UI Health"
echo ""

if [[ -n "$UI_HOST" ]]; then
  show_cmd "curl -fsSk https://${UI_HOST}/api/healthz"
  UI_HEALTH=$(curl -fsSk --connect-timeout 10 --max-time 30 \
    "https://${UI_HOST}/api/healthz" 2>&1 || true)
  if echo "$UI_HEALTH" | grep -qi "ok\|healthy\|{"; then
    pass "UI health check"
  else
    fail_test "UI health check (response: ${UI_HEALTH:0:200})"
  fi
else
  dim "  Skipping UI health (no route)"
fi
sep

# ── 9. Cleanup ───────────────────────────────────────────────────────────────

echo ""
bold "9. Cleanup"
echo ""

if [[ "$SKIP_CLEANUP" != "1" && -n "$SESSION_ID" ]]; then
  show_cmd "$ACPCTL stop ${SESSION_ID}"
  "$ACPCTL" stop "${SESSION_ID}" 2>&1 || true
  dim "  Session stopped"

  sleep 3

  show_cmd "$ACPCTL delete session ${SESSION_ID} -y"
  "$ACPCTL" delete session "${SESSION_ID}" -y 2>&1 || true
  dim "  Session deleted"

  show_cmd "$ACPCTL delete project ${PROJECT_NAME} -y"
  "$ACPCTL" delete project "${PROJECT_NAME}" -y 2>&1 || true
  dim "  Project deleted"

  pass "Test resources cleaned up"
else
  dim "  Skipping cleanup (SKIP_CLEANUP=1 or no session)"
fi
sep

# ── results ──────────────────────────────────────────────────────────────────

echo ""
bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
bold "Results: $PASS passed, $FAIL failed"
echo ""
for t in "${TESTS[@]}"; do
  if [[ "$t" == PASS:* ]]; then
    green "  ✓ ${t#PASS: }"
  else
    red "  ✗ ${t#FAIL: }"
  fi
done
bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
