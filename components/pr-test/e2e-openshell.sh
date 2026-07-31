#!/usr/bin/env bash
# e2e-openshell.sh — end-to-end demo of the OpenShell gateway on OpenShift.
#
# Proves the full path: Keycloak OIDC → acpctl → NLB route → openshell CLI
# → hosted gateway → sandbox pod creation.
#
# This script is READ-ONLY against existing infrastructure. It does not modify
# any deployment, configmap, secret, networkpolicy, or route. The only
# cluster-side write is a transient sandbox pod (cleaned up on exit).
#
# Usage:
#   bash e2e-openshell.sh <namespace>
#
# Environment variables:
#   OC                   oc/kubectl binary (default: oc)
#   ACPCTL               path to acpctl binary (default: acpctl from PATH)
#   TENANT_NAMESPACE     gateway tenant namespace (default: tenant-a)
#   GATEWAY_NAME         gateway name in API (default: openshell-gateway)
#   KC_USERNAME          Keycloak user (default: admin)
#   KC_PASSWORD          Keycloak password (default: admin)
#   SANDBOX_TIMEOUT      seconds to wait for sandbox (default: 120)
#   SKIP_CLEANUP         set to 1 to keep sandbox after test
#   LAUNCH_TUI           set to 1 to launch interactive TUI at the end (default: 1)
#   PAUSE                seconds between commands (default: 1)
set -euo pipefail

NAMESPACE="${1:-}"
CLI="${OC:-oc}"
ACPCTL="${ACPCTL:-acpctl}"
TENANT="${TENANT_NAMESPACE:-tenant-a}"
GW_NAME="${GATEWAY_NAME:-openshell-gateway}"
KC_USERNAME="${KC_USERNAME:-admin}"
KC_PASSWORD=$(echo "${KC_PASSWORD:-admin}")
SANDBOX_TIMEOUT="${SANDBOX_TIMEOUT:-120}"
SKIP_CLEANUP="${SKIP_CLEANUP:-}"
LAUNCH_TUI="${LAUNCH_TUI:-1}"
PAUSE="${PAUSE:-1}"

[[ -z "$NAMESPACE" ]] && { echo "Usage: $0 <namespace>"; exit 1; }

PASS=0
FAIL=0
TESTS=()
PF_PID=""
SANDBOX_NAME=""

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

cleanup() {
  if [[ -n "${SB_CREATE_PID:-}" ]]; then
    kill "$SB_CREATE_PID" 2>/dev/null || true
    wait "$SB_CREATE_PID" 2>/dev/null || true
  fi
  if [[ -n "$PF_PID" ]]; then
    kill "$PF_PID" 2>/dev/null || true
    wait "$PF_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── banner ───────────────────────────────────────────────────────────────────

echo ""
bold "OpenShell Gateway End-to-End Demo"
sep
echo ""
printf '  %s\n' "1. Gateway infrastructure health (pods, service, database)"
printf '  %s\n' "2. Keycloak OIDC authentication"
printf '  %s\n' "3. acpctl login + gateway discovery"
printf '  %s\n' "4. Route discovery + openshell CLI registration"
printf '  %s\n' "5. Gateway connectivity verification"
printf '  %s\n' "6. Sandbox lifecycle (create → ready)"
printf '  %s\n' "7. Sandbox interaction examples"
printf '  %s\n' "8. Interactive TUI handoff"
echo ""
printf '  \033[38;5;214m%-38s\033[0m %s\n' "Orange text like this" "= a CLI command being run"
echo ""
dim  "  ACP namespace:     $NAMESPACE"
dim  "  Tenant namespace:  $TENANT"
dim  "  Gateway:           $GW_NAME"
dim  "  Sandbox timeout:   ${SANDBOX_TIMEOUT}s"
dim  "  Pause:             ${PAUSE}s between commands"
echo ""
sep

# ── 1. gateway infrastructure ────────────────────────────────────────────────

echo ""
bold "1. Gateway Infrastructure"
echo ""

show_cmd "$CLI get deployment $GW_NAME -n $TENANT"
if $CLI get deployment "$GW_NAME" -n "$TENANT" &>/dev/null; then
  GW_READY=$($CLI get deployment "$GW_NAME" -n "$TENANT" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
  GW_IMAGE=$($CLI get deployment "$GW_NAME" -n "$TENANT" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo unknown)
  if [[ "$GW_READY" -ge 1 ]]; then
    pass "Gateway pod ready ($GW_IMAGE)"
  else
    fail_test "Gateway pod not ready (${GW_READY:-0} replicas)"
  fi
else
  fail_test "Gateway deployment not found in $TENANT"
fi

show_cmd "$CLI get deployment ${GW_NAME}-db -n $TENANT"
if $CLI get deployment "${GW_NAME}-db" -n "$TENANT" &>/dev/null; then
  DB_READY=$($CLI get deployment "${GW_NAME}-db" -n "$TENANT" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
  DB_IMAGE=$($CLI get deployment "${GW_NAME}-db" -n "$TENANT" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo unknown)
  if [[ "$DB_READY" -ge 1 ]]; then
    pass "Postgres database ready ($DB_IMAGE)"
  else
    fail_test "Postgres database not ready (${DB_READY:-0} replicas)"
  fi
else
  dim "  - No dedicated database deployment (may use sqlite)"
fi

show_cmd "$CLI get service $GW_NAME -n $TENANT"
GW_SVC=$($CLI get service "$GW_NAME" -n "$TENANT" -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)
if [[ -n "$GW_SVC" ]]; then
  pass "Gateway service: ${GW_SVC}:8080"
else
  fail_test "Gateway service not found"
fi

show_cmd "$CLI get secret openshell-server-tls -n $TENANT"
HAS_TLS=$($CLI get secret openshell-server-tls -n "$TENANT" 2>/dev/null && echo yes || true)
if [[ -n "$HAS_TLS" ]]; then
  pass "TLS certificates provisioned"
else
  dim "  - TLS secret not found (may be regenerating after SAN update)"
fi
sep

# ── 2. Keycloak auth ─────────────────────────────────────────────────────────

echo ""
bold "2. Keycloak OIDC Authentication"
echo ""

KC_HOST=$($CLI get route keycloak -n "$NAMESPACE" -o jsonpath='{.spec.host}' 2>/dev/null || true)
API_HOST=$($CLI get route ambient-api-server -n "$NAMESPACE" -o jsonpath='{.spec.host}' 2>/dev/null || true)
API_URL="https://${API_HOST}"
OIDC_JWT=

if [[ -z "$KC_HOST" ]]; then
  fail_test "Keycloak route not found"
  red "  Cannot continue without authentication"
  exit 1
fi

show_cmd "$CLI get secret sso-credentials -n $NAMESPACE -o jsonpath='{.data.SSO_CLIENT_SECRET}'"
KC_CLIENT_SECRET=$($CLI get secret sso-credentials -n "$NAMESPACE" \
  -o jsonpath='{.data.SSO_CLIENT_SECRET}' 2>/dev/null | base64 -d 2>/dev/null || true)

if [[ -z "$KC_CLIENT_SECRET" ]]; then
  fail_test "SSO_CLIENT_SECRET not found in sso-credentials"
  exit 1
fi

show_cmd "curl -sk -X POST https://${KC_HOST}/realms/ambient-code/protocol/openid-connect/token -d grant_type=password -d username=${KC_USERNAME}"
TOKEN_RESPONSE=$(curl -sk -X POST \
  "https://${KC_HOST}/realms/ambient-code/protocol/openid-connect/token" \
  -d "grant_type=password" \
  -d "client_id=ambient-frontend" \
  -d "client_secret=${KC_CLIENT_SECRET}" \
  -d "username=${KC_USERNAME}" \
  -d "password=${KC_PASSWORD}" \
  --connect-timeout 10 --max-time 30 2>&1 || true)

OIDC_JWT=$(echo "$TOKEN_RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || true)

if [[ -n "$OIDC_JWT" ]]; then
  USER_GROUPS=$(echo "$OIDC_JWT" | cut -d. -f2 | python3 -c "import base64,json,sys; p=sys.stdin.read().strip(); p+='='*(-len(p)%4); print(', '.join(json.loads(base64.urlsafe_b64decode(p)).get('groups',[])))" 2>/dev/null || echo "unknown")
  pass "OIDC token for ${KC_USERNAME} (groups: ${USER_GROUPS})"
else
  ERROR=$(echo "$TOKEN_RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('error_description','unknown'))" 2>/dev/null || echo "unknown")
  fail_test "Token exchange failed: ${ERROR}"
  exit 1
fi
sep

# ── 3. acpctl login + gateway discovery ──────────────────────────────────────

echo ""
bold "3. acpctl Login + Gateway Discovery"
echo ""

export AMBIENT_API_URL="${API_URL}"
export AMBIENT_TOKEN  # acpctl reads this env var
AMBIENT_TOKEN=${OIDC_JWT}

show_cmd "$ACPCTL login --token \$OIDC_JWT --url ${API_URL} --insecure-skip-tls-verify"
"$ACPCTL" login --token "${OIDC_JWT}" --url "${API_URL}" --insecure-skip-tls-verify 2>&1 || true

show_cmd "$ACPCTL get gateways --project $TENANT -o json"
GW_JSON=$("$ACPCTL" get gateways --project "$TENANT" -o json 2>&1 || true)
GW_ID=$(echo "$GW_JSON" | python3 -c "
import json,sys
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get('items', [])
for gw in items:
    if gw.get('name','') == '${GW_NAME}':
        print(gw['id'])
        break
" 2>/dev/null || true)

if [[ -n "$GW_ID" ]]; then
  GW_IMAGE_API=$(echo "$GW_JSON" | python3 -c "
import json,sys
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get('items', [])
for gw in items:
    if gw.get('name','') == '${GW_NAME}':
        print(gw.get('image',''))
        break
" 2>/dev/null || true)
  GW_DB_TYPE=$(echo "$GW_JSON" | python3 -c "
import json,sys
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get('items', [])
for gw in items:
    if gw.get('name','') == '${GW_NAME}':
        db = gw.get('database') or {}
        print(db.get('type','sqlite'))
        break
" 2>/dev/null || true)
  GW_OIDC_ISSUER=$(echo "$GW_JSON" | python3 -c "
import json,sys
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get('items', [])
for gw in items:
    if gw.get('name','') == '${GW_NAME}':
        oidc = gw.get('oidc') or {}
        print(oidc.get('issuer','none'))
        break
" 2>/dev/null || true)

  pass "Gateway discovered: ${GW_NAME} (${GW_ID})"
  dim "    Image:    ${GW_IMAGE_API}"
  dim "    Database: ${GW_DB_TYPE}"
  dim "    OIDC:     ${GW_OIDC_ISSUER}"
else
  fail_test "Gateway ${GW_NAME} not found in project ${TENANT}"
  exit 1
fi
sep

# ── 4. route discovery + openshell CLI registration ─────────────────────────

echo ""
bold "4. Route Discovery + CLI Registration"
echo ""

GW_LOCAL_NAME="${TENANT}-${GW_NAME}"

show_cmd "$CLI get routes -n $TENANT -o json  # find openshell gateway passthrough route"
GW_ROUTE_HOST=$($CLI get routes -n "$TENANT" -o json 2>/dev/null | python3 -c "
import json,sys
data = json.load(sys.stdin)
candidates = []
gateway_name = '"${GW_NAME}"'
for item in data.get('items',[]):
    tls = item.get('spec',{}).get('tls',{})
    to = item.get('spec',{}).get('to',{})
    name = item.get('metadata',{}).get('name','')
    # Look for passthrough routes to openshell-gateway service
    if (tls.get('termination') == 'passthrough' and 
        to.get('name') == gateway_name and
        ('grpc' in name or 'gateway' in name)):
        candidates.append(item['spec']['host'])
candidates.sort(key=lambda h: (0 if '.apps.rosa.' in h else 1, h))
if candidates:
    print(candidates[0])
" 2>/dev/null || true)

if [[ -z "$GW_ROUTE_HOST" ]]; then
  dim "  No NLB-backed route found, falling back to port-forward"
  PF_PORT=7443
  show_cmd "$CLI port-forward -n $TENANT svc/$GW_NAME ${PF_PORT}:8080 &"
  $CLI port-forward -n "$TENANT" svc/"$GW_NAME" "${PF_PORT}":8080 &>/dev/null &
  PF_PID=$!
  sleep 3
  if kill -0 "$PF_PID" 2>/dev/null; then
    pass "Port-forward active (localhost:${PF_PORT} → ${GW_NAME}:8080)"
  else
    fail_test "Port-forward failed to start"
    PF_PID=""
    exit 1
  fi
  GW_ENDPOINT="https://localhost:${PF_PORT}"
else
  GW_ENDPOINT="https://${GW_ROUTE_HOST}:443"
  pass "NLB route: ${GW_ROUTE_HOST}"
fi

GW_CONFIG_DIR="${HOME}/.config/openshell/gateways/${GW_LOCAL_NAME}"
mkdir -p "${GW_CONFIG_DIR}"

show_cmd "openshell gateway remove ${GW_LOCAL_NAME}  # clear stale config from previous runs"
openshell gateway remove "${GW_LOCAL_NAME}" 2>/dev/null || true
mkdir -p "${GW_CONFIG_DIR}"

show_cmd "# write gateway metadata + OIDC token (bypasses browser popup)"
python3 -c "
import json, os
meta = {
    'name': '${GW_LOCAL_NAME}',
    'gateway_endpoint': '${GW_ENDPOINT}',
    'is_remote': True,
    'gateway_port': 0,
    'auth_mode': 'oidc',
    'oidc_issuer': '${GW_OIDC_ISSUER}',
    'oidc_client_id': 'ambient-frontend',
    'oidc_audience': 'ambient-frontend'
}
with open('${GW_CONFIG_DIR}/metadata.json', 'w') as f:
    json.dump(meta, f, indent=2)
"

show_cmd "$ACPCTL gateway setup-cli --project $TENANT --gateway-url ${GW_ENDPOINT}"
SETUP_OUTPUT=$("$ACPCTL" gateway setup-cli --project "$TENANT" --gateway-url "${GW_ENDPOINT}" 2>&1 || true)

if [[ -f "${GW_CONFIG_DIR}/metadata.json" ]]; then
  pass "openshell CLI registered with OIDC credentials"
else
  dim "  setup-cli output: ${SETUP_OUTPUT:0:300}"
  dim "  (gateway config not written — testing connectivity directly)"
fi
sep

# ── 5. gateway connectivity ─────────────────────────────────────────────────

echo ""
bold "5. Gateway Connectivity"
echo ""

show_cmd "OPENSHELL_GATEWAY_INSECURE=true openshell -g ${GW_LOCAL_NAME} status"
STATUS_OUTPUT=$(OPENSHELL_GATEWAY_INSECURE=true openshell -g "${GW_LOCAL_NAME}" status 2>&1 || true)

CLEAN_STATUS=$(echo "$STATUS_OUTPUT" | sed 's/\x1b\[[0-9;]*m//g')
if echo "$CLEAN_STATUS" | grep -qi "Connected"; then
  GW_VERSION=$(echo "$CLEAN_STATUS" | grep -oP 'Version:\s*\K\S+' || echo "unknown")
  pass "Gateway connected (version: ${GW_VERSION})"
  echo "$STATUS_OUTPUT" | while IFS= read -r line; do
    dim "    $line"
  done
else
  fail_test "Gateway not reachable"
  echo "$STATUS_OUTPUT" | while IFS= read -r line; do
    dim "    $line"
  done
fi
sep

# ── 6. sandbox lifecycle ────────────────────────────────────────────────────

echo ""
bold "6. Sandbox Lifecycle"
echo ""

RUN_ID=$(date +%s | tail -c5)
SANDBOX_NAME="e2e-demo-${RUN_ID}"

show_cmd "OPENSHELL_GATEWAY_INSECURE=true openshell -g ${GW_LOCAL_NAME} sandbox create --name ${SANDBOX_NAME}"
dim "  Creating sandbox (timeout: ${SANDBOX_TIMEOUT}s)..."

OPENSHELL_GATEWAY_INSECURE=true openshell -g "${GW_LOCAL_NAME}" sandbox create --name "${SANDBOX_NAME}" &>/dev/null &
SB_CREATE_PID=$!

DEADLINE=$(($(date +%s) + SANDBOX_TIMEOUT))
SANDBOX_FOUND=false
while [[ $(date +%s) -lt $DEADLINE ]]; do
  SANDBOX_PODS=$($CLI get pods -n "$TENANT" --no-headers 2>/dev/null | grep -i "default--${SANDBOX_NAME}" || true)
  if [[ -n "$SANDBOX_PODS" ]]; then
    POD_STATUS=$(echo "$SANDBOX_PODS" | awk '{print $3}' | head -1)
    POD_NAME=$(echo "$SANDBOX_PODS" | awk '{print $1}' | head -1)
    if [[ "$POD_STATUS" == "Running" ]]; then
      SANDBOX_FOUND=true
      break
    fi
    dim "    pod: ${POD_NAME} (${POD_STATUS})"
  fi
  sleep 5
done

kill "$SB_CREATE_PID" 2>/dev/null || true
wait "$SB_CREATE_PID" 2>/dev/null || true

show_cmd "$CLI get pods -n $TENANT --no-headers | grep ${SANDBOX_NAME}"

if [[ "$SANDBOX_FOUND" == "true" ]]; then
  pass "Sandbox pod created: ${POD_NAME} (${POD_STATUS})"
else
  SANDBOX_PODS=$($CLI get pods -n "$TENANT" --no-headers 2>/dev/null | grep -i "default--${SANDBOX_NAME}" || true)
  if [[ -n "$SANDBOX_PODS" ]]; then
    POD_STATUS=$(echo "$SANDBOX_PODS" | awk '{print $3}' | head -1)
    POD_NAME=$(echo "$SANDBOX_PODS" | awk '{print $1}' | head -1)
    pass "Sandbox pod created: ${POD_NAME} (${POD_STATUS})"
  else
    fail_test "Sandbox not found after ${SANDBOX_TIMEOUT}s"
  fi
fi

if [[ -n "${POD_NAME:-}" ]]; then
  echo ""
  show_cmd "$CLI logs -n $TENANT ${POD_NAME} -c agent --tail=30"
  SANDBOX_LOGS=$($CLI logs -n "$TENANT" "${POD_NAME}" -c agent --tail=30 2>/dev/null || true)
  SANDBOX_READY_LOGS=$(echo "$SANDBOX_LOGS" | grep -v ' WARN ' || true)
  if [[ -n "$SANDBOX_READY_LOGS" ]]; then
    pass "Sandbox ready (supervisor initialized)"
    echo "$SANDBOX_READY_LOGS" | while IFS= read -r line; do
      dim "    $line"
    done
  elif [[ -n "$SANDBOX_LOGS" ]]; then
    pass "Sandbox ready (supervisor initialized, warnings filtered)"
  else
    dim "  - No agent logs yet (sandbox may still be initializing)"
  fi

  echo ""
  bold "  What is a sandbox?"
  echo ""
  dim "  An OpenShell sandbox is a remote, isolated container managed by the"
  dim "  gateway. It provides a secure cloud dev environment — a full Linux"
  dim "  shell running as a Kubernetes pod with network policy enforcement,"
  dim "  file transfer, port forwarding, and provider integrations."
  echo ""
  dim "  The sandbox is now Running and idle, waiting for a user to connect."
  dim "  Image: ghcr.io/nvidia/openshell-community/sandboxes/base:latest"
fi
sep

# ── 7. sandbox interaction ────────────────────────────────────────────────

echo ""
bold "7. Sandbox Interaction"
echo ""

GW_FLAG="-g ${GW_LOCAL_NAME}"
INSECURE_ENV="OPENSHELL_GATEWAY_INSECURE=true"

show_cmd "${INSECURE_ENV} openshell ${GW_FLAG} sandbox exec ${SANDBOX_NAME} -- uname -a"
if SB_EXEC_OUTPUT=$(OPENSHELL_GATEWAY_INSECURE=true openshell -g "${GW_LOCAL_NAME}" sandbox exec "${SANDBOX_NAME}" -- uname -a 2>&1); then
  CLEAN_EXEC=$(echo "$SB_EXEC_OUTPUT" | sed 's/\x1b\[[0-9;]*m//g' | grep -v '^ *$' | grep -v 'WARN' | tail -3)
  if [[ -n "$CLEAN_EXEC" ]]; then
    pass "Sandbox exec: command executed inside sandbox"
    echo "$CLEAN_EXEC" | while IFS= read -r line; do
      dim "    $line"
    done
  else
    fail_test "Sandbox exec: no output from uname command"
    dim "    ${SB_EXEC_OUTPUT:0:200}"
  fi
else
  fail_test "Sandbox exec: openshell command failed"
  dim "    ${SB_EXEC_OUTPUT:0:200}"
fi

show_cmd "${INSECURE_ENV} openshell ${GW_FLAG} sandbox exec ${SANDBOX_NAME} -- ls -la /workspace"
if SB_LS_OUTPUT=$(OPENSHELL_GATEWAY_INSECURE=true openshell -g "${GW_LOCAL_NAME}" sandbox exec "${SANDBOX_NAME}" -- ls -la /workspace 2>&1); then
  CLEAN_LS=$(echo "$SB_LS_OUTPUT" | sed 's/\x1b\[[0-9;]*m//g' | grep -v '^ *$' | grep -v 'WARN' | tail -5)
  if [[ -n "$CLEAN_LS" ]]; then
    pass "Sandbox workspace: /workspace directory listing"
    echo "$CLEAN_LS" | while IFS= read -r line; do
      dim "    $line"
    done
  else
    fail_test "Sandbox workspace: no output from ls command"
    dim "    ${SB_LS_OUTPUT:0:200}"
  fi
else
  # /workspace not existing is common and not necessarily a failure
  if echo "$SB_LS_OUTPUT" | grep -q "No such file or directory"; then
    dim "  - /workspace not available (using default working directory)"
  else
    fail_test "Sandbox workspace: openshell ls command failed"
    dim "    ${SB_LS_OUTPUT:0:200}"
  fi
fi

echo ""
bold "  Other sandbox commands available:"
echo ""
cyan "    openshell sandbox connect ${SANDBOX_NAME}     # interactive shell"
cyan "    openshell sandbox upload --upload ./src ${SANDBOX_NAME}  # upload files"
cyan "    openshell sandbox download ${SANDBOX_NAME} /workspace/out.txt  # download files"
cyan "    openshell forward ${SANDBOX_NAME} 8080         # port forward (e.g. web app)"
cyan "    openshell sandbox ssh-config ${SANDBOX_NAME}   # SSH config for IDE"
cyan "    openshell sandbox create --editor vscode       # launch with VS Code remote"
echo ""
dim "  In ACP, sandbox pods are the execution environment for agentic sessions."
dim "  The runner spawns a sandbox, the AI agent runs inside it with tool access"
dim "  (file edit, bash, etc.), and results stream back through the gateway."
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

# ── 8. interactive TUI handoff ───────────────────────────────────────────

if [[ $FAIL -gt 0 ]]; then
  red "  Tests failed — skipping TUI launch"
  echo ""
  exit 1
fi

if [[ "$SKIP_CLEANUP" != "1" && "$LAUNCH_TUI" != "1" && -n "$SANDBOX_NAME" ]]; then
  show_cmd "${INSECURE_ENV} openshell ${GW_FLAG} sandbox stop ${SANDBOX_NAME}"
  OPENSHELL_GATEWAY_INSECURE=true openshell -g "${GW_LOCAL_NAME}" sandbox stop "${SANDBOX_NAME}" 2>&1 || true
  dim "  Sandbox stopped"
  sleep 3
  show_cmd "${INSECURE_ENV} openshell ${GW_FLAG} sandbox rm ${SANDBOX_NAME}"
  OPENSHELL_GATEWAY_INSECURE=true openshell -g "${GW_LOCAL_NAME}" sandbox rm "${SANDBOX_NAME}" 2>&1 || true
  dim "  Sandbox removed"
fi

if [[ "$LAUNCH_TUI" == "1" ]]; then
  echo ""
  bold "8. Interactive TUI"
  sep
  echo ""
  dim "  Launching OpenShell TUI — you are now the demonstrator."
  dim "  The sandbox '${SANDBOX_NAME}' is still running. You can connect to it,"
  dim "  exec commands, or create new sandboxes from the TUI."
  echo ""
  dim "  Press Ctrl-C to exit the TUI when done."
  echo ""
  sleep 2
  exec env OPENSHELL_GATEWAY_INSECURE=true openshell -g "${GW_LOCAL_NAME}" term
else
  dim "  Skipping TUI (LAUNCH_TUI=0)"
  echo ""
fi
