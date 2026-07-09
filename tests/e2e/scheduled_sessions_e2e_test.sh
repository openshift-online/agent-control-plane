#!/usr/bin/env bash
# Scheduled Sessions E2E Test
# Exercises the full lifecycle: CRUD, cron validation, suspend/resume,
# manual trigger, runs history, and scheduler polling against a real ACP cluster.
set -euo pipefail

API_URL="${API_URL:-http://localhost:13592/api/ambient/v1}"
KC_URL="${KC_URL:-http://localhost:18592}"
KC_REALM="ambient-code"
KC_ADMIN_USER="admin"
KC_ADMIN_PASS="admin"
KC_CLIENT_ID="ambient-frontend"
NS="${NAMESPACE:-ambient-code}"
KUBE_CONTEXT="${KUBE_CONTEXT:-}"

kubectl() {
  if [[ -n "$KUBE_CONTEXT" ]]; then
    command kubectl --context "$KUBE_CONTEXT" "$@"
  else
    command kubectl "$@"
  fi
}

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

pass() { PASS_COUNT=$((PASS_COUNT + 1)); echo -e "  ${GREEN}[PASS]${NC} $1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); echo -e "  ${RED}[FAIL]${NC} $1: $2"; }
skip() { SKIP_COUNT=$((SKIP_COUNT + 1)); echo -e "  ${YELLOW}[SKIP]${NC} $1"; }

HTTP_STATUS=""
HTTP_BODY=""

api() {
  local method="$1" path="$2" token="$3" body="${4:-}"
  local args=(-s --max-time 15 -w '\n%{http_code}' -H "Authorization: Bearer $token" -H "Content-Type: application/json")
  if [[ -n "$body" ]]; then
    args+=(-d "$body")
  fi
  local response _retry
  for _retry in 1 2 3; do
    response=$(curl "${args[@]}" -X "$method" "${API_URL}${path}" || true)
    HTTP_STATUS=$(echo "$response" | tail -1)
    HTTP_BODY=$(echo "$response" | sed '$d')
    case "$HTTP_STATUS" in
      000) sleep 2 ;;
      500|502|503) sleep $((_retry * 2)) ;;
      *) return 0 ;;
    esac
  done
}

assert_status() {
  local expected="$1" actual="$2" desc="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc"
  else
    fail "$desc" "expected $expected, got $actual (body: $(echo "$HTTP_BODY" | head -c 200))"
  fi
}

assert_field() {
  local json="$1" field="$2" expected="$3" desc="$4"
  local actual
  actual=$(echo "$json" | jq -r "if .${field} == null then \"\" else (.${field} | tostring) end")
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc"
  else
    fail "$desc" "expected ${field}=${expected}, got ${actual}"
  fi
}

assert_not_null() {
  local json="$1" field="$2" desc="$3"
  local val
  val=$(echo "$json" | jq -r ".${field} // \"null\"")
  if [[ "$val" != "null" && "$val" != "" ]]; then
    pass "$desc"
  else
    fail "$desc" "${field} is null or empty"
  fi
}

assert_null() {
  local json="$1" field="$2" desc="$3"
  local val
  val=$(echo "$json" | jq -r ".${field} // \"null\"")
  if [[ "$val" == "null" || "$val" == "" ]]; then
    pass "$desc"
  else
    fail "$desc" "expected ${field} to be null, got ${val}"
  fi
}

assert_list_count() {
  local json="$1" expected="$2" desc="$3"
  local actual
  actual=$(echo "$json" | jq '.items | length')
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc"
  else
    fail "$desc" "expected $expected items, got $actual"
  fi
}

# --- Keycloak token ---

KC_ADMIN_TOKEN=""
KC_CLIENT_SECRET=""

get_admin_token() {
  KC_ADMIN_TOKEN=$(curl -s --max-time 10 -X POST "${KC_URL}/realms/master/protocol/openid-connect/token" \
    -d "client_id=admin-cli" \
    -d "grant_type=password" \
    -d "username=${KC_ADMIN_USER}" \
    -d "password=${KC_ADMIN_PASS}" 2>/dev/null | jq -r '.access_token // empty')
  if [[ -z "$KC_ADMIN_TOKEN" || "$KC_ADMIN_TOKEN" == "null" ]]; then
    echo "ERROR: Failed to get Keycloak admin token"
    return 1
  fi
}

get_client_secret() {
  local clients
  clients=$(curl -s -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
    "${KC_URL}/admin/realms/${KC_REALM}/clients?clientId=${KC_CLIENT_ID}")
  local client_uuid
  client_uuid=$(echo "$clients" | jq -r '.[0].id // empty' 2>/dev/null)
  if [[ -z "$client_uuid" ]]; then
    return
  fi
  KC_CLIENT_SECRET=$(curl -s -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
    "${KC_URL}/admin/realms/${KC_REALM}/clients/${client_uuid}/client-secret" | jq -r '.value // empty')
}

get_token() {
  local username="$1" password="$2"
  local args=(-d "client_id=${KC_CLIENT_ID}" -d "grant_type=password" -d "username=${username}" -d "password=${password}" -d "scope=openid")
  if [[ -n "$KC_CLIENT_SECRET" ]]; then
    args+=(-d "client_secret=${KC_CLIENT_SECRET}")
  fi
  local resp
  resp=$(curl -s -X POST "${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token" "${args[@]}")
  echo "$resp" | jq -r '.access_token // empty'
}

# --- Cleanup ---

PROJECT_ID="sched-e2e-proj"
AGENT_ID=""
SCHED_ID=""

cleanup() {
  echo -e "\n${BOLD}Cleanup...${NC}"
  if [[ -n "$SCHED_ID" ]]; then
    api DELETE "/projects/${PROJECT_ID}/scheduled-sessions/${SCHED_ID}" "$TOKEN" 2>/dev/null || true
  fi
  if [[ -n "$AGENT_ID" ]]; then
    api DELETE "/projects/${PROJECT_ID}/agents/${AGENT_ID}" "$TOKEN" 2>/dev/null || true
  fi
  api DELETE "/projects/${PROJECT_ID}" "$TOKEN" 2>/dev/null || true
}

trap cleanup EXIT

# =============================================================================
echo -e "\n${BOLD}=== Scheduled Sessions E2E Test ===${NC}\n"

# --- Phase 0: Auth Setup ---
echo -e "${BOLD}Phase 0: Auth setup${NC}"
get_admin_token
get_client_secret
TOKEN=$(get_token "admin" "admin")
if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "ERROR: Failed to get admin token"
  exit 1
fi
pass "Got admin auth token"

# --- Phase 1: Create project + agent ---
echo -e "\n${BOLD}Phase 1: Create project and agent${NC}"

api POST "/projects" "$TOKEN" '{"name":"'"${PROJECT_ID}"'","description":"Scheduled sessions e2e test"}'
if [[ "$HTTP_STATUS" == "201" || "$HTTP_STATUS" == "409" ]]; then
  pass "Create project (or already exists)"
else
  fail "Create project" "expected 201 or 409, got $HTTP_STATUS"
fi

api POST "/projects/${PROJECT_ID}/agents" "$TOKEN" '{"name":"sched-test-agent","project_id":"'"${PROJECT_ID}"'","prompt":"You are a test agent."}'
assert_status "201" "$HTTP_STATUS" "Create agent"
AGENT_ID=$(echo "$HTTP_BODY" | jq -r '.id')
assert_not_null "$HTTP_BODY" "id" "Agent has ID"

# --- Phase 2: Create scheduled session ---
echo -e "\n${BOLD}Phase 2: Create scheduled session${NC}"

api POST "/projects/${PROJECT_ID}/scheduled-sessions" "$TOKEN" \
  '{"name":"e2e-daily","schedule":"0 9 * * 1-5","agent_id":"'"${AGENT_ID}"'","timezone":"UTC","enabled":true,"session_prompt":"Run e2e checks","overlap_policy":"skip"}'
assert_status "201" "$HTTP_STATUS" "Create scheduled session"
SCHED_ID=$(echo "$HTTP_BODY" | jq -r '.id')
assert_not_null "$HTTP_BODY" "id" "Schedule has ID"
assert_field "$HTTP_BODY" "name" "e2e-daily" "Schedule name matches"
assert_field "$HTTP_BODY" "schedule" "0 9 * * 1-5" "Cron expression matches"
assert_field "$HTTP_BODY" "timezone" "UTC" "Timezone matches"
assert_field "$HTTP_BODY" "enabled" "true" "Schedule is enabled"
assert_field "$HTTP_BODY" "overlap_policy" "skip" "Overlap policy is skip"
assert_not_null "$HTTP_BODY" "next_run_at" "next_run_at computed"
assert_not_null "$HTTP_BODY" "created_by_user_id" "created_by_user_id set"

# --- Phase 3: Cron validation ---
echo -e "\n${BOLD}Phase 3: Cron validation${NC}"

api POST "/projects/${PROJECT_ID}/scheduled-sessions" "$TOKEN" \
  '{"name":"bad-cron","schedule":"not-a-cron","agent_id":"'"${AGENT_ID}"'"}'
assert_status "400" "$HTTP_STATUS" "Invalid cron rejected"

api POST "/projects/${PROJECT_ID}/scheduled-sessions" "$TOKEN" \
  '{"name":"bad-tz","schedule":"0 9 * * *","timezone":"Mars/Olympus","agent_id":"'"${AGENT_ID}"'"}'
assert_status "400" "$HTTP_STATUS" "Invalid timezone rejected"

# --- Phase 4: Get and list ---
echo -e "\n${BOLD}Phase 4: Get and list${NC}"

api GET "/projects/${PROJECT_ID}/scheduled-sessions/${SCHED_ID}" "$TOKEN"
assert_status "200" "$HTTP_STATUS" "Get schedule by ID"
assert_field "$HTTP_BODY" "name" "e2e-daily" "Get returns correct name"

api GET "/projects/${PROJECT_ID}/scheduled-sessions" "$TOKEN"
assert_status "200" "$HTTP_STATUS" "List schedules"
ITEM_COUNT=$(echo "$HTTP_BODY" | jq '.items | length')
if [[ "$ITEM_COUNT" -ge 1 ]]; then
  pass "List returns at least 1 schedule"
else
  fail "List returns at least 1 schedule" "got $ITEM_COUNT items"
fi

# --- Phase 5: Patch ---
echo -e "\n${BOLD}Phase 5: Patch schedule${NC}"

api PATCH "/projects/${PROJECT_ID}/scheduled-sessions/${SCHED_ID}" "$TOKEN" \
  '{"schedule":"*/30 * * * *","description":"Updated to every 30 min","overlap_policy":"allow"}'
assert_status "200" "$HTTP_STATUS" "Patch schedule"
assert_field "$HTTP_BODY" "schedule" "*/30 * * * *" "Schedule updated"
assert_field "$HTTP_BODY" "description" "Updated to every 30 min" "Description updated"
assert_field "$HTTP_BODY" "overlap_policy" "allow" "Overlap policy updated"
assert_not_null "$HTTP_BODY" "next_run_at" "next_run_at recomputed after patch"

api PATCH "/projects/${PROJECT_ID}/scheduled-sessions/${SCHED_ID}" "$TOKEN" \
  '{"schedule":"invalid!!!"}'
assert_status "400" "$HTTP_STATUS" "Patch with invalid cron rejected"

# --- Phase 6: Suspend and resume ---
echo -e "\n${BOLD}Phase 6: Suspend and resume${NC}"

api POST "/projects/${PROJECT_ID}/scheduled-sessions/${SCHED_ID}/suspend" "$TOKEN"
assert_status "200" "$HTTP_STATUS" "Suspend schedule"
assert_field "$HTTP_BODY" "enabled" "false" "Schedule is disabled"
assert_null "$HTTP_BODY" "next_run_at" "next_run_at is null when disabled"

api POST "/projects/${PROJECT_ID}/scheduled-sessions/${SCHED_ID}/resume" "$TOKEN"
assert_status "200" "$HTTP_STATUS" "Resume schedule"
assert_field "$HTTP_BODY" "enabled" "true" "Schedule is re-enabled"
assert_not_null "$HTTP_BODY" "next_run_at" "next_run_at recomputed on resume"

# --- Phase 7: Manual trigger ---
echo -e "\n${BOLD}Phase 7: Manual trigger${NC}"

# Reset overlap_policy to skip for trigger test
api PATCH "/projects/${PROJECT_ID}/scheduled-sessions/${SCHED_ID}" "$TOKEN" '{"overlap_policy":"skip"}'

api POST "/projects/${PROJECT_ID}/scheduled-sessions/${SCHED_ID}/trigger" "$TOKEN"
assert_status "201" "$HTTP_STATUS" "Trigger schedule"
TRIGGERED_SESSION_ID=$(echo "$HTTP_BODY" | jq -r '.id // empty')
if [[ -n "$TRIGGERED_SESSION_ID" && "$TRIGGERED_SESSION_ID" != "null" ]]; then
  pass "Trigger returned session with ID"
  assert_not_null "$HTTP_BODY" "source_scheduled_session_id" "Session has source_scheduled_session_id"
  assert_not_null "$HTTP_BODY" "scheduled_for" "Session has scheduled_for"
  assert_not_null "$HTTP_BODY" "created_by_user_id" "Session inherits created_by_user_id"

  TRIGGER_SOURCE=$(echo "$HTTP_BODY" | jq -r '.source_scheduled_session_id')
  if [[ "$TRIGGER_SOURCE" == "$SCHED_ID" ]]; then
    pass "source_scheduled_session_id matches schedule ID"
  else
    fail "source_scheduled_session_id matches schedule ID" "expected $SCHED_ID, got $TRIGGER_SOURCE"
  fi
else
  fail "Trigger returned session with ID" "no session ID in response"
fi

# --- Phase 8: Runs endpoint ---
echo -e "\n${BOLD}Phase 8: Runs history${NC}"

api GET "/projects/${PROJECT_ID}/scheduled-sessions/${SCHED_ID}/runs" "$TOKEN"
assert_status "200" "$HTTP_STATUS" "Get runs"
RUNS_COUNT=$(echo "$HTTP_BODY" | jq '.items | length')
if [[ "$RUNS_COUNT" -ge 1 ]]; then
  pass "Runs shows at least 1 triggered session"
else
  fail "Runs shows at least 1 triggered session" "got $RUNS_COUNT"
fi

# --- Phase 9: Second trigger (same schedule) ---
echo -e "\n${BOLD}Phase 9: Multiple triggers${NC}"

sleep 2  # ensure different scheduled_for timestamp
api POST "/projects/${PROJECT_ID}/scheduled-sessions/${SCHED_ID}/trigger" "$TOKEN"
assert_status "201" "$HTTP_STATUS" "Second trigger succeeds"
SECOND_SESSION_ID=$(echo "$HTTP_BODY" | jq -r '.id // empty')
if [[ -n "$SECOND_SESSION_ID" && "$SECOND_SESSION_ID" != "$TRIGGERED_SESSION_ID" ]]; then
  pass "Second trigger creates a different session"
else
  fail "Second trigger creates a different session" "got same or empty ID"
fi

api GET "/projects/${PROJECT_ID}/scheduled-sessions/${SCHED_ID}/runs" "$TOKEN"
assert_status "200" "$HTTP_STATUS" "Get runs after second trigger"
RUNS_COUNT=$(echo "$HTTP_BODY" | jq '.items | length')
if [[ "$RUNS_COUNT" -ge 2 ]]; then
  pass "Runs shows at least 2 triggered sessions"
else
  fail "Runs shows at least 2 triggered sessions" "got $RUNS_COUNT"
fi

# --- Phase 10: Scheduler is running (advisory lock cycling) ---
echo -e "\n${BOLD}Phase 10: Scheduler health check${NC}"

SCHEDULER_LOGS=$(kubectl logs -n "$NS" -l app=ambient-api-server --tail=50 2>/dev/null | grep -c "scheduled-session-scheduler" || true)
if [[ "$SCHEDULER_LOGS" -ge 1 ]]; then
  pass "Scheduler advisory lock cycling in API server logs"
else
  skip "Scheduler log check (may not have cycled yet)"
fi

# --- Phase 11: Delete ---
echo -e "\n${BOLD}Phase 11: Delete schedule${NC}"

api DELETE "/projects/${PROJECT_ID}/scheduled-sessions/${SCHED_ID}" "$TOKEN"
assert_status "204" "$HTTP_STATUS" "Delete schedule"
SCHED_ID=""  # prevent double-delete in cleanup

api GET "/projects/${PROJECT_ID}/scheduled-sessions" "$TOKEN"
assert_status "200" "$HTTP_STATUS" "List after delete"
assert_list_count "$HTTP_BODY" "0" "Schedule removed from list"

# =============================================================================
echo -e "\n${BOLD}=== Results ===${NC}"
echo -e "  ${GREEN}Passed: ${PASS_COUNT}${NC}"
echo -e "  ${RED}Failed: ${FAIL_COUNT}${NC}"
echo -e "  ${YELLOW}Skipped: ${SKIP_COUNT}${NC}"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo -e "\n${RED}FAILED${NC}"
  exit 1
fi

echo -e "\n${GREEN}ALL PASSED${NC}"
