#!/usr/bin/env bash
# smoke-test-llm.sh — End-to-end LLM round-trip smoke test
#
# Validates the full golden path through the platform:
#   Login → Project → Provider → Credential → Agent → Session → LLM response
#
# This test REQUIRES a working LLM backend (Vertex AI or Anthropic API).
# It creates a project, configures a Vertex provider with credentials,
# creates an agent, starts a session, sends a message, and verifies the
# LLM produces a valid response.
#
# Supports two authentication modes:
#   1. Bearer token  (--token / TEST_TOKEN env)
#   2. Client credentials (OIDC_CLIENT_ID + OIDC_CLIENT_SECRET env)
#
# Prerequisites:
#   - acpctl built and on PATH (or set ACPCTL=/path/to/acpctl)
#   - API server reachable at API_URL
#   - One of: VERTEX_SA_KEY env var, VERTEX_SA_KEY_FILE path, or
#     a pre-existing vertex K8s secret (for OpenShift deployments)
#
# Usage:
#   # Local Kind cluster (token auth, vertex key from env)
#   VERTEX_SA_KEY_FILE=~/vertex-key.json ./tests/e2e/smoke-test-llm.sh
#
#   # Remote OpenShift (client_credentials auth)
#   API_URL=https://api.example.com \
#   OIDC_CLIENT_ID=my-client \
#   OIDC_CLIENT_SECRET=secret \
#   VERTEX_SA_KEY="$(cat key.json)" \
#     ./tests/e2e/smoke-test-llm.sh
#
#   # Skip provider/credential setup (already configured)
#   SKIP_PROVIDER_SETUP=1 ./tests/e2e/smoke-test-llm.sh
#
# Environment variables:
#   API_URL                — API server URL (default: http://localhost:8000)
#   TEST_TOKEN             — Bearer token for auth (mutually exclusive with OIDC_*)
#   OIDC_CLIENT_ID         — OAuth2 client ID for client_credentials grant
#   OIDC_CLIENT_SECRET     — OAuth2 client secret
#   OIDC_ISSUER_URL        — OIDC issuer (default: https://sso.redhat.com/auth/realms/redhat-external)
#   VERTEX_SA_KEY          — Raw GCP service account JSON key
#   VERTEX_SA_KEY_FILE     — Path to GCP service account JSON key file
#   VERTEX_PROJECT_ID      — GCP project for Vertex AI (default: extracted from SA key)
#   VERTEX_REGION          — Vertex AI region (default: global)
#   SKIP_PROVIDER_SETUP    — Set to 1 to skip provider/credential creation
#   SKIP_CLEANUP           — Set to 1 to keep resources after test
#   ACPCTL                 — Path to acpctl binary (default: acpctl)
#   NAMESPACE              — K8s namespace for Kind port-forwards (default: ambient-code)
#   SESSION_READY_TIMEOUT  — Seconds to wait for Running phase (default: 120)
#   LLM_RESPONSE_TIMEOUT   — Seconds to wait for LLM response (default: 120)
#   PROJECT_NAME           — Project to use (default: smoke-llm-<timestamp>)
#   USE_EXISTING_PROJECT   — Set to 1 to use PROJECT_NAME without creating it

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

ACPCTL="${ACPCTL:-acpctl}"
API_URL="${API_URL:-http://localhost:8000}"
NAMESPACE="${NAMESPACE:-ambient-code}"
SESSION_READY_TIMEOUT="${SESSION_READY_TIMEOUT:-120}"
LLM_RESPONSE_TIMEOUT="${LLM_RESPONSE_TIMEOUT:-120}"
SKIP_PROVIDER_SETUP="${SKIP_PROVIDER_SETUP:-}"
SKIP_CLEANUP="${SKIP_CLEANUP:-}"
USE_EXISTING_PROJECT="${USE_EXISTING_PROJECT:-}"
VERTEX_REGION="${VERTEX_REGION:-global}"

RUN_ID="$(date +%s | tail -c6)"
PROJECT_NAME="${PROJECT_NAME:-smoke-llm-${RUN_ID}}"
AGENT_NAME="llm-smoke-agent"
PROVIDER_NAME="vertex"
CREDENTIAL_NAME="vertex-smoke-${RUN_ID}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

PASSED=0
FAILED=0
CREATED_PROJECT=""
CREATED_SESSION_ID=""

AUTH_MODE=""
TOKEN_EXPIRY=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILED=$((FAILED + 1)); }
skip() { echo -e "  ${YELLOW}⊘${NC} $1 (skipped: $2)"; }
section() { echo ""; echo -e "${BOLD}$1${NC}"; }
dim() { echo -e "${DIM}  $1${NC}"; }
die() { echo -e "${RED}error:${NC} $*" >&2; exit 1; }

json_field() {
  local json="$1" field="$2"
  echo "$json" | python3 -c "
import sys, json
raw = sys.stdin.read()
start = raw.find('{')
if start >= 0:
    print(json.loads(raw[start:]).get('${field}',''))
else:
    print('')
" 2>/dev/null
}

refresh_oidc_token() {
  if [[ "${AUTH_MODE}" != "oidc" ]]; then
    return
  fi

  local now
  now=$(date +%s)
  if [[ $now -lt $((TOKEN_EXPIRY - 30)) ]]; then
    return
  fi

  "$ACPCTL" login \
    --client-credentials \
    --client-id "${OIDC_CLIENT_ID}" \
    --client-secret "${OIDC_CLIENT_SECRET}" \
    --issuer-url "${OIDC_ISSUER_URL}" \
    --url "${API_URL}" \
    --project "${PROJECT_NAME}" \
    --insecure-skip-tls-verify \
    >/dev/null 2>&1

  AUTH_BEARER=$(jq -r '.access_token' ~/.config/ambient/config.json 2>/dev/null || echo "")
  TOKEN_EXPIRY=$(echo "${AUTH_BEARER}" | python3 -c "
import sys, json, base64
token = sys.stdin.read().strip()
parts = token.split('.')
if len(parts) >= 2:
    payload = parts[1] + '=' * (4 - len(parts[1]) % 4)
    data = json.loads(base64.urlsafe_b64decode(payload))
    print(data.get('exp', 0))
else:
    print(0)
" 2>/dev/null || echo "0")
}

api() {
  refresh_oidc_token
  local method="$1" path="$2"
  shift 2
  curl -sk --max-time 30 -X "$method" \
    -H "Authorization: Bearer ${AUTH_BEARER}" \
    -H "Content-Type: application/json" \
    -H "X-Ambient-Project: ${PROJECT_NAME}" \
    "$@" "${API_URL}${path}" 2>/dev/null
}

ensure_acpctl_token() {
  refresh_oidc_token
}

# ── cleanup ──────────────────────────────────────────────────────────────────

cleanup() {
  if [[ -n "${SKIP_CLEANUP}" ]]; then
    echo ""
    echo -e "${YELLOW}  SKIP_CLEANUP set — resources preserved:${NC}"
    dim "project:  ${PROJECT_NAME}"
    dim "session:  ${CREATED_SESSION_ID:-<none>}"
    return
  fi

  section "Cleanup"

  ensure_acpctl_token

  if [[ -n "${CREATED_SESSION_ID}" ]]; then
    dim "stopping session ${CREATED_SESSION_ID}..."
    "$ACPCTL" stop "${CREATED_SESSION_ID}" 2>/dev/null || true
    sleep 2
    "$ACPCTL" delete session "${CREATED_SESSION_ID}" -y 2>/dev/null || true
  fi

  if [[ -n "${CREATED_PROJECT}" ]]; then
    dim "deleting project ${CREATED_PROJECT}..."
    "$ACPCTL" delete project "${CREATED_PROJECT}" -y 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── preflight ────────────────────────────────────────────────────────────────

section "0. Preflight checks"

if ! command -v "$ACPCTL" &>/dev/null; then
  if [[ -x "$REPO_ROOT/components/ambient-cli/acpctl" ]]; then
    ACPCTL="$REPO_ROOT/components/ambient-cli/acpctl"
    pass "acpctl found at ${ACPCTL}"
  else
    fail "acpctl not found — run 'make build-cli' or set ACPCTL=/path/to/acpctl"
    die "Cannot proceed without acpctl"
  fi
else
  pass "acpctl found: $(command -v "$ACPCTL")"
fi

command -v python3 &>/dev/null || die "python3 is required"
command -v curl    &>/dev/null || die "curl is required"
command -v jq      &>/dev/null || die "jq is required"

HEALTH_STATUS=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 10 "${API_URL}/healthcheck" 2>/dev/null || echo "000")
if [[ "$HEALTH_STATUS" =~ ^(200|401|403)$ ]]; then
  pass "API server responding at ${API_URL} (HTTP ${HEALTH_STATUS})"
else
  fail "API server not responding at ${API_URL} (HTTP ${HEALTH_STATUS})"
  die "Cannot reach API server"
fi

# ── authentication ───────────────────────────────────────────────────────────

section "1. Authentication"

AUTH_BEARER=""

if [[ -n "${OIDC_CLIENT_ID:-}" && -n "${OIDC_CLIENT_SECRET:-}" ]]; then
  AUTH_MODE="oidc"
  OIDC_ISSUER_URL="${OIDC_ISSUER_URL:-https://sso.redhat.com/auth/realms/redhat-external}"

  dim "authenticating via client_credentials grant..."
  dim "issuer: ${OIDC_ISSUER_URL}"
  dim "client: ${OIDC_CLIENT_ID}"

  "$ACPCTL" login \
    --client-credentials \
    --client-id "${OIDC_CLIENT_ID}" \
    --client-secret "${OIDC_CLIENT_SECRET}" \
    --issuer-url "${OIDC_ISSUER_URL}" \
    --url "${API_URL}" \
    --project "${PROJECT_NAME}" \
    --insecure-skip-tls-verify \
    >/dev/null 2>&1

  AUTH_BEARER=$(jq -r '.access_token' ~/.config/ambient/config.json 2>/dev/null || echo "")
  if [[ -n "${AUTH_BEARER}" && "${AUTH_BEARER}" != "null" ]]; then
    TOKEN_EXPIRY=$(echo "${AUTH_BEARER}" | python3 -c "
import sys, json, base64
token = sys.stdin.read().strip()
parts = token.split('.')
if len(parts) >= 2:
    payload = parts[1] + '=' * (4 - len(parts[1]) % 4)
    data = json.loads(base64.urlsafe_b64decode(payload))
    print(data.get('exp', 0))
else:
    print(0)
" 2>/dev/null || echo "0")
    pass "client_credentials login succeeded"
  else
    fail "client_credentials login failed"
    die "Authentication failed"
  fi

elif [[ -n "${TEST_TOKEN:-}" ]]; then
  AUTH_MODE="token"
  AUTH_BEARER="${TEST_TOKEN}"

  "$ACPCTL" login "${API_URL}" \
    --token "${AUTH_BEARER}" \
    --project "${PROJECT_NAME}" \
    --insecure-skip-tls-verify \
    >/dev/null 2>&1

  pass "bearer token login succeeded"

elif [[ -f "$SCRIPT_DIR/../cypress/.env.test" ]]; then
  AUTH_MODE="token"
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/../cypress/.env.test"
  AUTH_BEARER="${TEST_TOKEN:-}"

  if [[ -n "${AUTH_BEARER}" ]]; then
    "$ACPCTL" login "${API_URL}" \
      --token "${AUTH_BEARER}" \
      --project "${PROJECT_NAME}" \
      --insecure-skip-tls-verify \
      >/dev/null 2>&1
    pass "bearer token login succeeded (from .env.test)"
  else
    fail "TEST_TOKEN not found in .env.test"
    die "No authentication method available"
  fi

else
  fail "no authentication configured"
  echo ""
  echo "  Set one of:"
  echo "    OIDC_CLIENT_ID + OIDC_CLIENT_SECRET  (client_credentials)"
  echo "    TEST_TOKEN                            (bearer token)"
  die "No authentication method available"
fi

WHOAMI=$("$ACPCTL" whoami 2>/dev/null || echo "")
if [[ -n "$WHOAMI" ]]; then
  dim "identity: $(echo "$WHOAMI" | head -1)"
else
  fail "acpctl whoami failed after login"
fi

# ── project ──────────────────────────────────────────────────────────────────

section "2. Project setup"

if [[ -n "${USE_EXISTING_PROJECT}" ]]; then
  ensure_acpctl_token
  EXISTING_PROJECT=$(api GET "/api/ambient/v1/projects?search=name+%3D+%27${PROJECT_NAME}%27&size=1" | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('items', []) if isinstance(data, dict) else data
print(items[0]['id'] if items else '')
" 2>/dev/null || echo "")
  if [[ -n "${EXISTING_PROJECT}" ]]; then
    PROJECT_ID="${EXISTING_PROJECT}"
    pass "using existing project: ${PROJECT_NAME} (id: ${PROJECT_ID})"
  else
    fail "project ${PROJECT_NAME} not found (USE_EXISTING_PROJECT=1)"
    die "Project not found"
  fi
else
  PROJECT_JSON=$("$ACPCTL" create project --name "${PROJECT_NAME}" --description "LLM smoke test ${RUN_ID}" -o json 2>/dev/null || echo "")
  PROJECT_ID=$(json_field "${PROJECT_JSON}" "id")

  if [[ -n "${PROJECT_ID}" && "${PROJECT_ID}" != "" ]]; then
    CREATED_PROJECT="${PROJECT_NAME}"
    pass "project created: ${PROJECT_NAME} (id: ${PROJECT_ID})"
  else
    ensure_acpctl_token
    EXISTING_PROJECT=$(api GET "/api/ambient/v1/projects?search=name+%3D+%27${PROJECT_NAME}%27&size=1" | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('items', []) if isinstance(data, dict) else data
print(items[0]['id'] if items else '')
" 2>/dev/null || echo "")
    if [[ -n "${EXISTING_PROJECT}" ]]; then
      PROJECT_ID="${EXISTING_PROJECT}"
      CREATED_PROJECT="${PROJECT_NAME}"
      pass "project already exists: ${PROJECT_NAME} (id: ${PROJECT_ID})"
    else
      fail "could not create or find project ${PROJECT_NAME}"
      die "Project setup failed"
    fi
  fi
fi

"$ACPCTL" project "${PROJECT_NAME}" >/dev/null 2>&1 || true

# ── vertex provider & credential ─────────────────────────────────────────────

section "3. Provider & credential setup"

if [[ -n "${SKIP_PROVIDER_SETUP}" ]]; then
  skip "provider setup" "SKIP_PROVIDER_SETUP=1"
else
  if [[ -z "${VERTEX_SA_KEY:-}" && -n "${VERTEX_SA_KEY_FILE:-}" && -f "${VERTEX_SA_KEY_FILE}" ]]; then
    VERTEX_SA_KEY="$(cat "${VERTEX_SA_KEY_FILE}")"
  fi

  if [[ -z "${VERTEX_SA_KEY:-}" ]]; then
    fail "VERTEX_SA_KEY or VERTEX_SA_KEY_FILE is required (unless SKIP_PROVIDER_SETUP=1)"
    die "Cannot set up Vertex provider without service account key"
  fi

  if [[ -z "${VERTEX_PROJECT_ID:-}" ]]; then
    VERTEX_PROJECT_ID=$(echo "${VERTEX_SA_KEY}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('project_id',''))" 2>/dev/null || echo "")
  fi

  if [[ -z "${VERTEX_PROJECT_ID}" ]]; then
    fail "could not determine VERTEX_PROJECT_ID from SA key"
    die "Set VERTEX_PROJECT_ID explicitly"
  fi

  dim "vertex project: ${VERTEX_PROJECT_ID}"
  dim "vertex region:  ${VERTEX_REGION}"

  MANIFEST_DIR=$(mktemp -d)
  trap 'rm -rf "${MANIFEST_DIR}"; cleanup' EXIT

  cat > "${MANIFEST_DIR}/provider-vertex.yaml" <<EOF
kind: Provider
name: ${PROVIDER_NAME}
type: vertex
EOF

  cat > "${MANIFEST_DIR}/credential-vertex.yaml" <<EOF
kind: Credential
name: ${CREDENTIAL_NAME}
provider: vertex
token: \$SMOKE_VERTEX_SA_KEY
description: Vertex AI credential for LLM smoke test ${RUN_ID}
EOF

  ensure_acpctl_token
  SMOKE_VERTEX_SA_KEY="${VERTEX_SA_KEY}" \
    "$ACPCTL" apply -f "${MANIFEST_DIR}/provider-vertex.yaml" --project "${PROJECT_NAME}" 2>/dev/null && \
    pass "provider '${PROVIDER_NAME}' applied" || \
    fail "provider '${PROVIDER_NAME}' apply failed"

  SMOKE_VERTEX_SA_KEY="${VERTEX_SA_KEY}" \
    "$ACPCTL" apply -f "${MANIFEST_DIR}/credential-vertex.yaml" --project "${PROJECT_NAME}" 2>/dev/null && \
    pass "credential '${CREDENTIAL_NAME}' applied" || \
    fail "credential '${CREDENTIAL_NAME}' apply failed"

  rm -rf "${MANIFEST_DIR}"
  trap cleanup EXIT

  PROVIDERS_RESP=$(api GET "/api/ambient/v1/projects/${PROJECT_ID}/providers?size=50" || echo "")
  FOUND_PROVIDER=$(echo "$PROVIDERS_RESP" \
    | python3 -c "import sys,json; items=json.load(sys.stdin).get('items',[]); print(next((p['name'] for p in items if p.get('name')=='${PROVIDER_NAME}'),''))" 2>/dev/null || echo "")
  if [[ -n "${FOUND_PROVIDER}" ]]; then
    pass "provider '${PROVIDER_NAME}' verified in project"
  else
    fail "provider '${PROVIDER_NAME}' not found in project after apply"
  fi

  ensure_acpctl_token
  CREDS_RESP=$("$ACPCTL" credential list -o json 2>/dev/null || echo "")
  FOUND_CREDENTIAL=$(echo "$CREDS_RESP" \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('items', []) if isinstance(data, dict) else data
for c in items:
    if c.get('name') == '${CREDENTIAL_NAME}':
        print(c['name'])
        break
" 2>/dev/null || echo "")
  if [[ -n "${FOUND_CREDENTIAL}" ]]; then
    pass "credential '${CREDENTIAL_NAME}' verified"
  else
    fail "credential '${CREDENTIAL_NAME}' not found after apply"
  fi
fi

# ── agent ────────────────────────────────────────────────────────────────────

section "4. Create agent"

ensure_acpctl_token
AGENT_JSON=$(
  "$ACPCTL" agent create \
    --name "${AGENT_NAME}" \
    --prompt "You are a concise test assistant. Answer questions directly and briefly." \
    -o json 2>/dev/null || echo ""
)
AGENT_ID=$(json_field "${AGENT_JSON}" "id")

if [[ -n "${AGENT_ID}" && "${AGENT_ID}" != "" ]]; then
  pass "agent created: ${AGENT_NAME} (id: ${AGENT_ID})"
else
  EXISTING_AGENTS=$("$ACPCTL" get agents -o json 2>/dev/null || echo "")
  AGENT_ID=$(echo "$EXISTING_AGENTS" \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('items', []) if isinstance(data, dict) else data
for a in items:
    if a.get('name') == '${AGENT_NAME}':
        print(a['id'])
        break
" 2>/dev/null || echo "")
  if [[ -n "${AGENT_ID}" ]]; then
    pass "agent already exists: ${AGENT_NAME} (id: ${AGENT_ID})"
  else
    fail "could not create or find agent ${AGENT_NAME}"
    die "Agent setup failed"
  fi
fi

# ── session ──────────────────────────────────────────────────────────────────

section "5. Create session"

ensure_acpctl_token
SESSION_JSON=$(
  "$ACPCTL" create session \
    --name "llm-smoke-${RUN_ID}" \
    --agent-id "${AGENT_ID}" \
    --prompt "You are a concise test assistant. Answer questions directly and briefly." \
    -o json 2>/dev/null || echo ""
)

CREATED_SESSION_ID=$(json_field "${SESSION_JSON}" "id")
if [[ -z "${CREATED_SESSION_ID}" || "${CREATED_SESSION_ID}" == "" ]]; then
  fail "could not create session"
  echo "  Response: $(echo "${SESSION_JSON}" | head -c 300)"
  die "Session creation failed"
fi
pass "session created: ${CREATED_SESSION_ID}"

# ── wait for Running ─────────────────────────────────────────────────────────

section "6. Wait for session Running"

DEADLINE=$(( $(date +%s) + SESSION_READY_TIMEOUT ))
LAST_PHASE=""

while true; do
  ensure_acpctl_token
  PHASE=$(
    "$ACPCTL" get session "${CREATED_SESSION_ID}" -o json 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('phase',''))" 2>/dev/null || echo ""
  )

  if [[ "$PHASE" != "$LAST_PHASE" ]]; then
    dim "phase: ${PHASE}"
    LAST_PHASE="$PHASE"
  fi

  if [[ "$PHASE" == "Running" ]]; then
    pass "session reached Running phase"
    break
  fi

  if [[ "$PHASE" == "Failed" || "$PHASE" == "Error" ]]; then
    fail "session entered ${PHASE} phase"
    die "Session failed to start"
  fi

  if [[ $(date +%s) -ge $DEADLINE ]]; then
    fail "timed out waiting for Running (last phase: ${PHASE:-unknown})"
    die "Session did not reach Running within ${SESSION_READY_TIMEOUT}s"
  fi

  sleep 3
done

# ── wait for initial turn then send question ─────────────────────────────────

section "7. Wait for initial turn, then send question"

USER_MESSAGE="What is 2+2? Reply with only the number, nothing else."

dim "waiting for initial turn to complete..."

INITIAL_DEADLINE=$(( $(date +%s) + LLM_RESPONSE_TIMEOUT ))
INITIAL_TURN_DONE=false

while [[ $(date +%s) -lt $INITIAL_DEADLINE ]]; do
  ensure_acpctl_token

  INIT_MESSAGES=$(
    api GET "/api/ambient/v1/sessions/${CREATED_SESSION_ID}/messages" || echo "[]"
  )

  INIT_FINISHED=$(echo "$INIT_MESSAGES" | python3 -c "
import sys, json
try:
    msgs = json.load(sys.stdin)
    if not isinstance(msgs, list):
        msgs = msgs.get('items', [])
    for m in msgs:
        if m.get('event_type') == 'lifecycle':
            payload = m.get('payload', '')
            if 'run_finished' in payload:
                print('true')
                break
except Exception:
    pass
" 2>/dev/null || echo "")

  if [[ "${INIT_FINISHED}" == "true" ]]; then
    INITIAL_TURN_DONE=true
    break
  fi

  sleep 3
done

if [[ "${INITIAL_TURN_DONE}" == "true" ]]; then
  pass "initial turn completed"
else
  fail "initial turn did not complete within ${LLM_RESPONSE_TIMEOUT}s"
  dim "sending question anyway..."
fi

dim "sending: ${USER_MESSAGE}"
dim "waiting up to ${LLM_RESPONSE_TIMEOUT}s for response..."

ensure_acpctl_token

BEFORE_SEQ=$(
  api GET "/api/ambient/v1/sessions/${CREATED_SESSION_ID}/messages" \
  | python3 -c "
import sys, json
try:
    msgs = json.load(sys.stdin)
    if not isinstance(msgs, list):
        msgs = msgs.get('items', [])
    print(max((m.get('seq', 0) for m in msgs), default=0))
except Exception:
    print(0)
" 2>/dev/null || echo "0"
)

"$ACPCTL" session send "${CREATED_SESSION_ID}" "${USER_MESSAGE}" 2>/dev/null || true

RESPONSE_DEADLINE=$(( $(date +%s) + LLM_RESPONSE_TIMEOUT ))
ASSISTANT_RESPONSE=""
LLM_RESPONDED=false
MESSAGES=""

while [[ $(date +%s) -lt $RESPONSE_DEADLINE ]]; do
  ensure_acpctl_token

  MESSAGES=$(
    api GET "/api/ambient/v1/sessions/${CREATED_SESSION_ID}/messages?after_seq=${BEFORE_SEQ}" || echo "[]"
  )

  ASSISTANT_RESPONSE=$(echo "$MESSAGES" | python3 -c "
import sys, json
try:
    msgs = json.load(sys.stdin)
    if not isinstance(msgs, list):
        msgs = msgs.get('items', [])
    for m in msgs:
        if m.get('event_type') == 'assistant':
            payload = m.get('payload', '')
            print(payload)
            break
except Exception:
    pass
" 2>/dev/null || echo "")

  if [[ -n "${ASSISTANT_RESPONSE}" ]]; then
    LLM_RESPONDED=true
    break
  fi

  sleep 5
done

if [[ "${LLM_RESPONDED}" == "true" ]]; then
  pass "LLM response received"
  dim "response: ${ASSISTANT_RESPONSE}"
else
  fail "no LLM response within ${LLM_RESPONSE_TIMEOUT}s"

  dim "fetching all session messages for debugging..."
  ensure_acpctl_token
  ALL_MESSAGES=$(api GET "/api/ambient/v1/sessions/${CREATED_SESSION_ID}/messages" 2>/dev/null || echo "[]")
  echo "$ALL_MESSAGES" | python3 -m json.tool 2>/dev/null || echo "$ALL_MESSAGES"

  die "LLM round-trip failed"
fi

# ── validate response ────────────────────────────────────────────────────────

section "8. Validate LLM response"

IS_ERROR=$(echo "${ASSISTANT_RESPONSE}" | python3 -c "
import sys
resp = sys.stdin.read().lower()
error_markers = ['permission_denied', 'error', '403', '401', 'unauthorized', 'failed to authenticate']
is_err = any(marker in resp for marker in error_markers)
print('true' if is_err else 'false')
" 2>/dev/null || echo "false")

if [[ "${IS_ERROR}" == "true" ]]; then
  fail "LLM response contains an error"
  dim "response: ${ASSISTANT_RESPONSE:0:500}"
else
  pass "LLM response is not an error"
fi

CONTAINS_ANSWER=$(echo "${ASSISTANT_RESPONSE}" | python3 -c "
import sys
resp = sys.stdin.read()
print('true' if '4' in resp else 'false')
" 2>/dev/null || echo "false")

if [[ "${CONTAINS_ANSWER}" == "true" ]]; then
  pass "LLM response contains expected answer (4)"
else
  fail "LLM response does not contain expected answer (4)"
  dim "response: ${ASSISTANT_RESPONSE:0:500}"
fi

LIFECYCLE_EVENTS=$(echo "$MESSAGES" | python3 -c "
import sys, json
try:
    msgs = json.load(sys.stdin)
    if not isinstance(msgs, list):
        msgs = msgs.get('items', [])
    events = [m.get('payload','') for m in msgs if m.get('event_type') == 'lifecycle']
    has_started = any('run_started' in e for e in events)
    has_finished = any('run_finished' in e for e in events)
    print('started' if has_started else '', 'finished' if has_finished else '')
except Exception:
    pass
" 2>/dev/null || echo "")

if echo "${LIFECYCLE_EVENTS}" | grep -q "started"; then
  pass "lifecycle: run_started event present"
else
  fail "lifecycle: run_started event missing"
fi

if echo "${LIFECYCLE_EVENTS}" | grep -q "finished"; then
  pass "lifecycle: run_finished event present"
else
  skip "lifecycle: run_finished" "turn may still be completing"
fi

# ── results ──────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}────────────────────────────────────────────────────${NC}"
echo -e "${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}"
echo -e "${BOLD}────────────────────────────────────────────────────${NC}"
echo ""

if [[ "${FAILED}" -gt 0 ]]; then
  exit 1
fi
