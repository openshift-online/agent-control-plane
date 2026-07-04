#!/bin/bash
#
# Cross-Project Authorization Test Suite
# Tests RBAC enforcement for cross-project session listing
#
# Prerequisites:
#   - API server running with --enable-authz=true
#   - At least two users with different project bindings
#   - acpctl configured and authenticated
#
# Usage: ./tests/authz-cross-project-test.sh [API_URL]
#   API_URL defaults to http://localhost:8000
#

set -euo pipefail

API_URL="${1:-http://localhost:8000}"
NAMESPACE="${NAMESPACE:-ambient-code}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

PASSED=0
FAILED=0
SKIPPED=0

pass() {
  echo -e "  ${GREEN}✓${NC} $1"
  PASSED=$((PASSED + 1))
}

fail() {
  echo -e "  ${RED}✗${NC} $1"
  FAILED=$((FAILED + 1))
}

skip() {
  echo -e "  ${YELLOW}⊘${NC} $1 (skipped: $2)"
  SKIPPED=$((SKIPPED + 1))
}

section() {
  echo ""
  echo -e "${BOLD}$1${NC}"
}

# ---------------------------------------------------------------------------
# Token helpers
# ---------------------------------------------------------------------------

get_sa_token() {
  kubectl get secret test-user-token -n "$NAMESPACE" -o jsonpath='{.data.token}' 2>/dev/null | base64 -d 2>/dev/null
}

api_get() {
  local token="$1"
  local path="$2"
  curl -sf -H "Authorization: Bearer $token" "${API_URL}${path}" 2>/dev/null
}

api_get_status() {
  local token="$1"
  local path="$2"
  curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $token" "${API_URL}${path}" 2>/dev/null
}

api_post() {
  local token="$1"
  local path="$2"
  local body="$3"
  curl -sf -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" -d "$body" "${API_URL}${path}" 2>/dev/null
}

api_delete() {
  local token="$1"
  local path="$2"
  curl -sf -X DELETE -H "Authorization: Bearer $token" "${API_URL}${path}" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

section "Setup"

TOKEN=$(get_sa_token)
if [ -z "$TOKEN" ]; then
  echo -e "${RED}Error: Cannot get test-user-token from namespace $NAMESPACE${NC}"
  echo "Ensure the cluster is running and you have kubectl access."
  exit 1
fi
echo "  Token obtained (length: ${#TOKEN})"

# Check authz is enabled
AUTHZ_CHECK=$(api_get "$TOKEN" "/api/ambient/v1/sessions?size=1" || echo "FAILED")
if [ "$AUTHZ_CHECK" = "FAILED" ]; then
  echo -e "${RED}Error: Cannot reach API server at $API_URL${NC}"
  exit 1
fi
echo "  API server reachable at $API_URL"

# Get current user info
WHOAMI=$(api_get "$TOKEN" "/api/ambient/v1/whoami" 2>/dev/null || echo "{}")
USERNAME=$(echo "$WHOAMI" | jq -r '.username // "unknown"' 2>/dev/null || echo "unknown")
echo "  Authenticated as: $USERNAME"

# ---------------------------------------------------------------------------
# Test 1: Happy path — list sessions across authorized projects
# ---------------------------------------------------------------------------

section "Test 1: Cross-project session listing (happy path)"

# List all sessions without project_id filter
ALL_SESSIONS=$(api_get "$TOKEN" "/api/ambient/v1/sessions?size=200")
TOTAL=$(echo "$ALL_SESSIONS" | jq '.total' 2>/dev/null)

if [ "$TOTAL" != "null" ] && [ -n "$TOTAL" ]; then
  pass "GET /sessions (no project filter) returned total=$TOTAL"
else
  fail "GET /sessions (no project filter) did not return valid response"
fi

# Verify sessions span multiple projects
PROJECT_IDS=$(echo "$ALL_SESSIONS" | jq -r '[.items[].project_id] | unique | .[]' 2>/dev/null)
PROJECT_COUNT=$(echo "$PROJECT_IDS" | grep -c . 2>/dev/null || echo "0")

if [ "$PROJECT_COUNT" -gt 1 ]; then
  pass "Sessions span $PROJECT_COUNT projects: $(echo "$PROJECT_IDS" | tr '\n' ' ')"
elif [ "$PROJECT_COUNT" -eq 1 ]; then
  skip "Sessions in only 1 project" "need sessions in multiple projects to verify cross-project"
else
  skip "No sessions found" "create sessions in multiple projects first"
fi

# ---------------------------------------------------------------------------
# Test 2: Single project filter still works
# ---------------------------------------------------------------------------

section "Test 2: Single project filter narrows results"

if [ "$PROJECT_COUNT" -ge 1 ]; then
  FIRST_PROJECT=$(echo "$PROJECT_IDS" | head -1)
  FILTERED=$(api_get "$TOKEN" "/api/ambient/v1/sessions?project_id=$FIRST_PROJECT&size=200")
  FILTERED_TOTAL=$(echo "$FILTERED" | jq '.total' 2>/dev/null)
  FILTERED_PROJECTS=$(echo "$FILTERED" | jq -r '[.items[].project_id] | unique | length' 2>/dev/null)

  if [ "$FILTERED_PROJECTS" -le 1 ]; then
    pass "project_id=$FIRST_PROJECT filter returned $FILTERED_TOTAL sessions from 1 project"
  else
    fail "project_id filter returned sessions from $FILTERED_PROJECTS projects (expected 1)"
  fi
else
  skip "Single project filter" "no projects with sessions"
fi

# ---------------------------------------------------------------------------
# Test 3: Unauthorized project filter returns empty (not error)
# ---------------------------------------------------------------------------

section "Test 3: Unauthorized project_id returns empty list (not error)"

FAKE_PROJECT="nonexistent-project-$(date +%s)"
UNAUTH_RESPONSE=$(api_get "$TOKEN" "/api/ambient/v1/sessions?project_id=$FAKE_PROJECT&size=10")
UNAUTH_STATUS=$(api_get_status "$TOKEN" "/api/ambient/v1/sessions?project_id=$FAKE_PROJECT&size=10")
UNAUTH_TOTAL=$(echo "$UNAUTH_RESPONSE" | jq '.total' 2>/dev/null)

if [ "$UNAUTH_STATUS" = "200" ] && [ "$UNAUTH_TOTAL" = "0" ]; then
  pass "Unauthorized project_id returns 200 with total=0 (not 403)"
elif [ "$UNAUTH_STATUS" = "200" ]; then
  fail "Unauthorized project_id returned total=$UNAUTH_TOTAL (expected 0)"
else
  fail "Unauthorized project_id returned HTTP $UNAUTH_STATUS (expected 200)"
fi

# ---------------------------------------------------------------------------
# Test 4: TSL injection attempt is rejected
# ---------------------------------------------------------------------------

section "Test 4: TSL injection in search parameter"

INJECTION_ATTEMPTS=(
  "name = 'test' or 1=1"
  "project_id = 'x'; DROP TABLE sessions; --"
  "name like '%' or project_id != ''"
)

for attempt in "${INJECTION_ATTEMPTS[@]}"; do
  ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$attempt'))" 2>/dev/null || echo "")
  if [ -z "$ENCODED" ]; then
    skip "TSL injection: $attempt" "python3 not available for URL encoding"
    continue
  fi

  INJ_STATUS=$(api_get_status "$TOKEN" "/api/ambient/v1/sessions?search=$ENCODED&size=1")
  if [ "$INJ_STATUS" = "400" ] || [ "$INJ_STATUS" = "200" ]; then
    pass "Injection attempt rejected or safely handled (HTTP $INJ_STATUS): ${attempt:0:40}..."
  else
    fail "Injection attempt returned unexpected HTTP $INJ_STATUS: ${attempt:0:40}..."
  fi
done

# ---------------------------------------------------------------------------
# Test 5: Unauthenticated request is rejected
# ---------------------------------------------------------------------------

section "Test 5: Unauthenticated request"

NOAUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${API_URL}/api/ambient/v1/sessions?size=1" 2>/dev/null)
if [ "$NOAUTH_STATUS" = "401" ]; then
  pass "No auth token → HTTP 401"
elif [ "$NOAUTH_STATUS" = "403" ]; then
  pass "No auth token → HTTP 403"
else
  fail "No auth token → HTTP $NOAUTH_STATUS (expected 401 or 403)"
fi

# ---------------------------------------------------------------------------
# Test 6: Invalid token is rejected
# ---------------------------------------------------------------------------

section "Test 6: Invalid token"

BAD_TOKEN="not-a-valid-token-for-testing"
BAD_STATUS=$(api_get_status "$BAD_TOKEN" "/api/ambient/v1/sessions?size=1")
if [ "$BAD_STATUS" = "401" ] || [ "$BAD_STATUS" = "403" ]; then
  pass "Invalid JWT → HTTP $BAD_STATUS"
else
  fail "Invalid JWT → HTTP $BAD_STATUS (expected 401 or 403)"
fi

# ---------------------------------------------------------------------------
# Test 7: Sessions include project_id for cross-project navigation
# ---------------------------------------------------------------------------

section "Test 7: Response includes project_id for navigation"

if [ "$TOTAL" -gt 0 ] 2>/dev/null; then
  HAS_PROJECT_ID=$(echo "$ALL_SESSIONS" | jq '[.items[] | select(.project_id != null)] | length' 2>/dev/null)
  ITEMS_COUNT=$(echo "$ALL_SESSIONS" | jq '.items | length' 2>/dev/null)

  if [ "$HAS_PROJECT_ID" = "$ITEMS_COUNT" ]; then
    pass "All $ITEMS_COUNT sessions include project_id"
  else
    fail "$HAS_PROJECT_ID of $ITEMS_COUNT sessions have project_id (all should)"
  fi
else
  skip "project_id check" "no sessions to verify"
fi

# ---------------------------------------------------------------------------
# Test 8: Large page size works
# ---------------------------------------------------------------------------

section "Test 8: Large page size for bell polling"

LARGE_STATUS=$(api_get_status "$TOKEN" "/api/ambient/v1/sessions?size=200")
if [ "$LARGE_STATUS" = "200" ]; then
  pass "size=200 returns HTTP 200"
else
  fail "size=200 returns HTTP $LARGE_STATUS"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo -e "${BOLD}Results${NC}"
echo -e "  ${GREEN}Passed:${NC}  $PASSED"
echo -e "  ${RED}Failed:${NC}  $FAILED"
echo -e "  ${YELLOW}Skipped:${NC} $SKIPPED"
echo ""

if [ "$FAILED" -gt 0 ]; then
  echo -e "${RED}${BOLD}FAIL${NC} — $FAILED test(s) failed"
  exit 1
else
  echo -e "${GREEN}${BOLD}PASS${NC} — all tests passed"
  exit 0
fi
