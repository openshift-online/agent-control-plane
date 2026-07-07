#!/usr/bin/env bash
# hcmai-smoke.sh — Pretty E2E smoke test against the hcmai OpenShift cluster
#
# Validates the full golden path with colorful output:
#   Login → Project → Provider → Credential → Agent → Session → LLM response
#
# Resources are KEPT after the run so you can inspect them.
# Uses `acpctl session messages -f` to live-stream the LLM event stream.
#
# Usage:
#   ./tests/e2e/hcmai-smoke.sh
#   USE_EXISTING_PROJECT=1 PROJECT_NAME=mturansk ./tests/e2e/hcmai-smoke.sh
#
# Prerequisites:
#   - acpctl on PATH (rebuilt with --agent-id support)
#   - oc authenticated to hcmai cluster
#   - ambient-code-gitops repo cloned with .secrets/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

ACPCTL="${ACPCTL:-acpctl}"
NAMESPACE="${NAMESPACE:-ambient-api}"
SESSION_READY_TIMEOUT="${SESSION_READY_TIMEOUT:-180}"
LLM_RESPONSE_TIMEOUT="${LLM_RESPONSE_TIMEOUT:-180}"
USE_EXISTING_PROJECT="${USE_EXISTING_PROJECT:-}"
VERTEX_REGION="${VERTEX_REGION:-global}"

GITOPS_SECRETS="${GITOPS_SECRETS:-$HOME/projects/src/gitlab.cee.redhat.com/ambient-code/ambient-code-gitops/.secrets}"
OC_CONTEXT="${OC_CONTEXT:-ambient-code/api-hcmais01ue1-s9m2-p3-openshiftapps-com:443/mturansk}"

RUN_ID="$(date +%s | tail -c6)"
PROJECT_NAME="${PROJECT_NAME:-smoke-llm-${RUN_ID}}"
AGENT_NAME="llm-smoke-agent"
PROVIDER_NAME="vertex"
CREDENTIAL_NAME="vertex-smoke-${RUN_ID}"

ORANGE='\033[38;5;214m'
WHITE='\033[1;37m'
GREEN='\033[32m'
RED='\033[31m'
CYAN='\033[36m'
YELLOW='\033[33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

PASSED=0
FAILED=0

AUTH_MODE=""
TOKEN_EXPIRY=0
AUTH_BEARER=""

bold()   { printf "${WHITE}%s${NC}\n" "$*"; }
dim()    { printf "${DIM}%s${NC}\n" "$*"; }
orange() { printf "${ORANGE}%s${NC}\n" "$*"; }
green()  { printf "${GREEN}%s${NC}\n" "$*"; }
cyan()   { printf "${CYAN}%s${NC}\n" "$*"; }
red()    { printf "${RED}%s${NC}\n" "$*"; }
sep()    { printf "${DIM}──────────────────────────────────────────────────────────${NC}\n"; }

pass() { printf "  ${GREEN}✓${NC} %s\n" "$1"; PASSED=$((PASSED + 1)); }
fail() { printf "  ${RED}✗${NC} %s\n" "$1"; FAILED=$((FAILED + 1)); }
die()  { printf "${RED}error:${NC} %s\n" "$*" >&2; exit 1; }

announce() {
  echo
  sep
  printf "${CYAN}━━  %s${NC}\n" "$*"
  sep
}

step() {
  local description="$1"
  shift
  echo
  sep
  bold "▶  $description"
  printf "${ORANGE}   $ %s${NC}\n" "$*"
  "$@"
  echo
}

step_silent() {
  local description="$1"
  shift
  echo
  sep
  bold "▶  $description"
  printf "${ORANGE}   $ %s${NC}\n" "$*"
  "$@" >/dev/null 2>&1
  echo
}

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

ensure_token() {
  refresh_oidc_token
}

# ── preflight ────────────────────────────────────────────────────────────────

echo
bold "hcmai E2E Smoke Test"
dim "  Cluster:  hcmai (rosa)"
dim "  Run ID:   ${RUN_ID}"
echo
printf "  ${ORANGE}%-38s${NC} %s\n" "Orange text like this" "= a terminal command being run"
printf "  ${WHITE}%-38s${NC} %s\n" "White bold text" "= section headers"
echo

announce "0 · Preflight"

if ! command -v "$ACPCTL" &>/dev/null; then
  die "acpctl not found on PATH"
fi
pass "acpctl found: $(command -v "$ACPCTL")"

command -v python3 &>/dev/null || die "python3 is required"
command -v curl    &>/dev/null || die "curl is required"
command -v jq      &>/dev/null || die "jq is required"
command -v oc      &>/dev/null || die "oc is required"

if [[ ! -d "$GITOPS_SECRETS" ]]; then
  die "secrets dir not found: $GITOPS_SECRETS"
fi
pass "gitops secrets found"

if [[ ! -f "$GITOPS_SECRETS/VERTEX_SA_KEY" ]]; then
  die "VERTEX_SA_KEY not found in $GITOPS_SECRETS"
fi
pass "VERTEX_SA_KEY present"

# ── resolve OIDC credentials from cluster ────────────────────────────────────

OIDC_CLIENT_ID="${OIDC_CLIENT_ID:-}"
OIDC_CLIENT_SECRET="${OIDC_CLIENT_SECRET:-}"

if [[ -z "$OIDC_CLIENT_ID" || -z "$OIDC_CLIENT_SECRET" ]]; then
  OIDC_CLIENT_ID=$(oc --context "$OC_CONTEXT" -n "$NAMESPACE" \
    get secret ambient-control-plane-oidc \
    -o jsonpath='{.data.client-id}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  OIDC_CLIENT_SECRET=$(oc --context "$OC_CONTEXT" -n "$NAMESPACE" \
    get secret ambient-control-plane-oidc \
    -o jsonpath='{.data.client-secret}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
fi

if [[ -z "$OIDC_CLIENT_ID" || -z "$OIDC_CLIENT_SECRET" ]]; then
  die "could not resolve OIDC credentials from cluster secret"
fi
pass "OIDC credentials resolved from cluster"

export API_URL="${API_URL:-https://ambient-api-server-ambient-api.apps.rosa.hcmais01ue1.s9m2.p3.openshiftapps.com}"
export OIDC_ISSUER_URL="${OIDC_ISSUER_URL:-https://keycloak-ambient-keycloak.apps.rosa.hcmais01ue1.s9m2.p3.openshiftapps.com/realms/ambient-code}"

dim "  API:     ${API_URL}"
dim "  Issuer:  ${OIDC_ISSUER_URL}"
dim "  Client:  ${OIDC_CLIENT_ID}"

HEALTH_STATUS=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 10 "${API_URL}/healthcheck" 2>/dev/null || echo "000")
if [[ "$HEALTH_STATUS" =~ ^(200|401|403)$ ]]; then
  pass "API server responding (HTTP ${HEALTH_STATUS})"
else
  fail "API server not responding (HTTP ${HEALTH_STATUS})"
  die "Cannot reach API server"
fi

# ── authentication ───────────────────────────────────────────────────────────

announce "1 · Authenticate"

AUTH_MODE="oidc"

sep
bold "▶  Login via client_credentials"
printf "${ORANGE}   $ acpctl login --client-credentials --client-id %s --issuer-url %s${NC}\n" "${OIDC_CLIENT_ID}" "${OIDC_ISSUER_URL}"
"$ACPCTL" login \
  --client-credentials \
  --client-id "${OIDC_CLIENT_ID}" \
  --client-secret "${OIDC_CLIENT_SECRET}" \
  --issuer-url "${OIDC_ISSUER_URL}" \
  --url "${API_URL}" \
  --project "${PROJECT_NAME}" \
  --insecure-skip-tls-verify \
  >/dev/null 2>&1
echo

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
  pass "authenticated"
else
  die "authentication failed"
fi

step "Show identity" "$ACPCTL" whoami

# ── project ──────────────────────────────────────────────────────────────────

announce "2 · Project"

if [[ -n "${USE_EXISTING_PROJECT}" ]]; then
  ensure_token
  EXISTING_PROJECT=$(api GET "/api/ambient/v1/projects?search=name+%3D+%27${PROJECT_NAME}%27&size=1" | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('items', []) if isinstance(data, dict) else data
print(items[0]['id'] if items else '')
" 2>/dev/null || echo "")
  if [[ -n "${EXISTING_PROJECT}" ]]; then
    PROJECT_ID="${EXISTING_PROJECT}"
    pass "using existing project: ${PROJECT_NAME} (${PROJECT_ID})"
  else
    die "project ${PROJECT_NAME} not found"
  fi
else
  PROJECT_JSON=$("$ACPCTL" create project --name "${PROJECT_NAME}" --description "hcmai smoke test ${RUN_ID}" -o json 2>/dev/null || echo "")
  PROJECT_ID=$(json_field "${PROJECT_JSON}" "id")

  if [[ -n "${PROJECT_ID}" && "${PROJECT_ID}" != "" ]]; then
    pass "project created: ${PROJECT_NAME} (${PROJECT_ID})"
  else
    die "could not create project ${PROJECT_NAME}"
  fi
fi

"$ACPCTL" project "${PROJECT_NAME}" >/dev/null 2>&1 || true

step "Confirm project context" "$ACPCTL" project current

# ── provider & credential ───────────────────────────────────────────────────

announce "3 · Vertex Provider & Credential"

VERTEX_SA_KEY="$(cat "${GITOPS_SECRETS}/VERTEX_SA_KEY")"
VERTEX_PROJECT_ID=$(echo "${VERTEX_SA_KEY}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('project_id',''))" 2>/dev/null || echo "")

dim "  vertex project: ${VERTEX_PROJECT_ID}"
dim "  vertex region:  ${VERTEX_REGION}"

MANIFEST_DIR=$(mktemp -d)

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
description: Vertex AI credential for smoke test ${RUN_ID}
EOF

ensure_token

sep
bold "▶  Apply provider manifest"
printf "${ORANGE}   $ acpctl apply -f provider-vertex.yaml${NC}\n"
SMOKE_VERTEX_SA_KEY="${VERTEX_SA_KEY}" \
  "$ACPCTL" apply -f "${MANIFEST_DIR}/provider-vertex.yaml" --project "${PROJECT_NAME}" 2>/dev/null && \
  pass "provider '${PROVIDER_NAME}' applied" || \
  fail "provider '${PROVIDER_NAME}' apply failed"

sep
bold "▶  Apply credential manifest"
printf "${ORANGE}   $ acpctl apply -f credential-vertex.yaml${NC}\n"
SMOKE_VERTEX_SA_KEY="${VERTEX_SA_KEY}" \
  "$ACPCTL" apply -f "${MANIFEST_DIR}/credential-vertex.yaml" --project "${PROJECT_NAME}" 2>/dev/null && \
  pass "credential '${CREDENTIAL_NAME}' applied" || \
  fail "credential '${CREDENTIAL_NAME}' apply failed"

rm -rf "${MANIFEST_DIR}"

PROVIDERS_RESP=$(api GET "/api/ambient/v1/projects/${PROJECT_ID}/providers?size=50" || echo "")
FOUND_PROVIDER=$(echo "$PROVIDERS_RESP" \
  | python3 -c "import sys,json; items=json.load(sys.stdin).get('items',[]); print(next((p['name'] for p in items if p.get('name')=='${PROVIDER_NAME}'),''))" 2>/dev/null || echo "")
if [[ -n "${FOUND_PROVIDER}" ]]; then
  pass "provider '${PROVIDER_NAME}' verified in project"
else
  fail "provider '${PROVIDER_NAME}' not found after apply"
fi

ensure_token
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

echo

# ── agent ────────────────────────────────────────────────────────────────────

announce "4 · Create Agent"

ensure_token
AGENT_JSON=$(
  "$ACPCTL" agent create \
    --name "${AGENT_NAME}" \
    --prompt "You are a concise test assistant. Answer questions directly and briefly." \
    -o json 2>/dev/null || echo ""
)
AGENT_ID=$(json_field "${AGENT_JSON}" "id")

if [[ -n "${AGENT_ID}" && "${AGENT_ID}" != "" ]]; then
  pass "agent created: ${AGENT_NAME} (${AGENT_ID})"
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
    pass "agent already exists: ${AGENT_NAME} (${AGENT_ID})"
  else
    die "could not create or find agent"
  fi
fi

# ── session ──────────────────────────────────────────────────────────────────

announce "5 · Create Session"

ensure_token

sep
bold "▶  Create session"
printf "${ORANGE}   $ acpctl create session --name llm-smoke-${RUN_ID} --agent-id ${AGENT_ID}${NC}\n"

SESSION_JSON=$(
  "$ACPCTL" create session \
    --name "llm-smoke-${RUN_ID}" \
    --agent-id "${AGENT_ID}" \
    --prompt "You are a concise test assistant. Answer questions directly and briefly." \
    -o json 2>/dev/null || echo ""
)

CREATED_SESSION_ID=$(json_field "${SESSION_JSON}" "id")
if [[ -z "${CREATED_SESSION_ID}" || "${CREATED_SESSION_ID}" == "" ]]; then
  die "session creation failed"
fi
pass "session created: ${CREATED_SESSION_ID}"
echo

# ── wait for Running ─────────────────────────────────────────────────────────

announce "6 · Wait for Running"

DEADLINE=$(( $(date +%s) + SESSION_READY_TIMEOUT ))
LAST_PHASE=""

while true; do
  ensure_token
  PHASE=$(
    "$ACPCTL" get session "${CREATED_SESSION_ID}" -o json 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('phase',''))" 2>/dev/null || echo ""
  )

  if [[ "$PHASE" != "$LAST_PHASE" ]]; then
    printf "   phase: ${ORANGE}%s${NC}\n" "$PHASE"
    LAST_PHASE="$PHASE"
  fi

  if [[ "$PHASE" == "Running" ]]; then
    pass "session is Running"
    break
  fi

  if [[ "$PHASE" == "Failed" || "$PHASE" == "Error" ]]; then
    fail "session entered ${PHASE}"
    die "session failed to start"
  fi

  if [[ $(date +%s) -ge $DEADLINE ]]; then
    fail "timed out waiting for Running (phase: ${PHASE:-unknown})"
    die "session did not reach Running within ${SESSION_READY_TIMEOUT}s"
  fi

  sleep 3
done

# ── stream initial turn via acpctl session messages -f ───────────────────────

announce "7 · Initial Turn (follow event stream)"

bold "▶  Following session event stream (continuous)"
printf "${ORANGE}   $ acpctl session messages %s -F${NC}\n" "${CREATED_SESSION_ID}"
echo
sep

ensure_token
timeout "${LLM_RESPONSE_TIMEOUT}" "$ACPCTL" session messages "${CREATED_SESSION_ID}" -F 2>/dev/null &
STREAM_PID=$!

INITIAL_DEADLINE=$(( $(date +%s) + LLM_RESPONSE_TIMEOUT ))
INITIAL_TURN_DONE=false
while [[ $(date +%s) -lt $INITIAL_DEADLINE ]]; do
  ensure_token
  INIT_EVENTS=$(
    "$ACPCTL" session events-history "${CREATED_SESSION_ID}" --event-type RUN_FINISHED --limit 1 -o json 2>/dev/null || echo "{}"
  )
  INIT_COUNT=$(echo "$INIT_EVENTS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total',0))" 2>/dev/null || echo "0")
  if [[ "$INIT_COUNT" -ge 1 ]]; then
    INITIAL_TURN_DONE=true
    break
  fi
  sleep 5
done

sep

if [[ "${INITIAL_TURN_DONE}" == "true" ]]; then
  pass "initial turn completed (RUN_FINISHED detected)"
else
  printf "  ${YELLOW}⊘${NC} initial turn not yet finished, continuing anyway\n"
fi

# ── send user question ──────────────────────────────────────────────────────

announce "8 · Send Question & Stream LLM Response"

USER_MESSAGE="What is 2+2? Reply with only the number, nothing else."

sep
bold "▶  Sending user message"
printf "${ORANGE}   $ acpctl session send %s \"%s\"${NC}\n" "${CREATED_SESSION_ID}" "${USER_MESSAGE}"

ensure_token
"$ACPCTL" session send "${CREATED_SESSION_ID}" "${USER_MESSAGE}" 2>/dev/null || true
echo

bold "▶  Waiting for LLM response (stream running in background)..."

RESPONSE_DEADLINE=$(( $(date +%s) + LLM_RESPONSE_TIMEOUT ))
LLM_TURN_OK=false
while [[ $(date +%s) -lt $RESPONSE_DEADLINE ]]; do
  ensure_token
  FINISH_EVENTS=$(
    "$ACPCTL" session events-history "${CREATED_SESSION_ID}" --event-type RUN_FINISHED --limit 5 -o json 2>/dev/null || echo "{}"
  )
  FINISH_COUNT=$(echo "$FINISH_EVENTS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total',0))" 2>/dev/null || echo "0")
  if [[ "$FINISH_COUNT" -ge 2 ]]; then
    LLM_TURN_OK=true
    break
  fi
  sleep 5
done

kill "$STREAM_PID" 2>/dev/null || true
wait "$STREAM_PID" 2>/dev/null || true

sep

if [[ "${LLM_TURN_OK}" == "true" ]]; then
  pass "LLM turn completed (2nd RUN_FINISHED detected)"
else
  fail "LLM turn did not complete within ${LLM_RESPONSE_TIMEOUT}s"
fi

# ── validate: fetch the response via API ─────────────────────────────────────

announce "9 · Validate Response"

ensure_token
ALL_MESSAGES=$(api GET "/api/ambient/v1/sessions/${CREATED_SESSION_ID}/messages" 2>/dev/null || echo "[]")

ASSISTANT_RESPONSE=$(echo "$ALL_MESSAGES" | python3 -c "
import sys, json
try:
    msgs = json.load(sys.stdin)
    if not isinstance(msgs, list):
        msgs = msgs.get('items', [])
    for m in reversed(msgs):
        if m.get('event_type') == 'assistant':
            print(m.get('payload', ''))
            break
except Exception:
    pass
" 2>/dev/null || echo "")

if [[ -n "${ASSISTANT_RESPONSE}" ]]; then
  pass "LLM response found in message store"
  echo
  printf "  ${WHITE}LLM says:${NC} ${ORANGE}%s${NC}\n" "${ASSISTANT_RESPONSE}"
  echo
else
  fail "no assistant response found in message store"
fi

CONTAINS_ANSWER=$(echo "${ASSISTANT_RESPONSE}" | python3 -c "
import sys
resp = sys.stdin.read()
print('true' if '4' in resp else 'false')
" 2>/dev/null || echo "false")

if [[ "${CONTAINS_ANSWER}" == "true" ]]; then
  pass "response contains expected answer (4)"
else
  fail "response does not contain expected answer (4)"
  dim "  got: ${ASSISTANT_RESPONSE:0:500}"
fi

# ── show full session detail ─────────────────────────────────────────────────

announce "10 · Session Detail"

step "Describe session" "$ACPCTL" describe session "${CREATED_SESSION_ID}"

step "Full event history" "$ACPCTL" session events-history "${CREATED_SESSION_ID}" --limit 50

# ── results (no cleanup) ────────────────────────────────────────────────────

echo
sep
printf "${BOLD}Results: ${GREEN}%d passed${NC}, ${RED}%d failed${NC}\n" "$PASSED" "$FAILED"
sep
echo
printf "  ${WHITE}Resources preserved for inspection:${NC}\n"
printf "  ${ORANGE}%-20s${NC} %s\n" "project"    "${PROJECT_NAME}"
printf "  ${ORANGE}%-20s${NC} %s\n" "agent"      "${AGENT_NAME} (${AGENT_ID})"
printf "  ${ORANGE}%-20s${NC} %s\n" "session"    "${CREATED_SESSION_ID}"
printf "  ${ORANGE}%-20s${NC} %s\n" "provider"   "${PROVIDER_NAME}"
printf "  ${ORANGE}%-20s${NC} %s\n" "credential" "${CREDENTIAL_NAME}"
echo
printf "  ${DIM}Replay the event stream:${NC}\n"
printf "  ${ORANGE}  $ acpctl session messages %s -f${NC}\n" "${CREATED_SESSION_ID}"
printf "  ${ORANGE}  $ acpctl session events-history %s --limit 100${NC}\n" "${CREATED_SESSION_ID}"
printf "  ${ORANGE}  $ acpctl describe session %s${NC}\n" "${CREATED_SESSION_ID}"
echo
sep

if [[ "${FAILED}" -gt 0 ]]; then
  exit 1
fi
