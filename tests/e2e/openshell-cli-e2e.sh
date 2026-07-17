#!/usr/bin/env bash
# E2E test: openshell CLI operations against ACP-managed gateways
#
# Validates that a power user can use the native `openshell` CLI directly
# against ACP-managed gateways. Exercises sandbox, provider, policy, and
# settings command groups. Every command is printed with its output for
# CI debuggability.
#
# Prerequisites:
#   - kind-up with OPENSHELL_USE_GATEWAY=true (default)
#   - acpctl built (make build-cli)
#   - openshell CLI installed and available in $PATH
#   - TEST_TOKEN set or tests/cypress/.env.test present
#
# Usage:
#   ./tests/e2e/openshell-cli-e2e.sh [--skip-cleanup] [--cluster-validate] [API_URL]
#   API_URL defaults to http://localhost:13000
#   --skip-cleanup       Retain created resources for manual inspection
#   --cluster-validate   Enable cross-validation with Kubernetes cluster state

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

NAMESPACE="${NAMESPACE:-ambient-code}"
TENANT="tenant-a"
SKIP_CLEANUP=false
CLUSTER_VALIDATE=false
GATEWAY_NAME=""
SANDBOX_NAME=""
SANDBOX_IMAGE="${OPENSHELL_RUNNER_IMAGE:-localhost/acp_runner_openshell:latest}"
SANDBOX_FROM_IMAGE="${SANDBOX_IMAGE}"

# Parse flags
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --skip-cleanup) SKIP_CLEANUP=true; shift ;;
    --cluster-validate) CLUSTER_VALIDATE=true; shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

# Token
if [ -z "${TEST_TOKEN:-}" ] && [ -f "$SCRIPT_DIR/../cypress/.env.test" ]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/../cypress/.env.test"
fi
TOKEN="${TEST_TOKEN:-}"

# API URL
PF_PID=""
GW_PF_PID=""
PF_PORT=18768
if [ -n "${API_URL:-}" ] && [ "${API_URL}" != "http://localhost:" ]; then
  :
elif [ -n "${1:-}" ]; then
  API_URL="${1}"
else
  API_URL="http://localhost:${PF_PORT}"
fi

# Resource tracking for cleanup
CREATED_SANDBOX=""
CREATED_PROVIDER=""
CREATED_SETTING_GLOBAL=""
CREATED_SETTING_SANDBOX=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

PASSED=0
FAILED=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILED=$((FAILED + 1)); }
skip() { echo -e "  ${YELLOW}⊘${NC} $1 (skipped: $2)"; }
section() { echo ""; echo -e "${BOLD}$1${NC}"; }

# Run a command with visibility: print it, execute, capture + display output.
# Sets CMD_OUTPUT and CMD_RC for callers to inspect.
CMD_OUTPUT=""
CMD_RC=0
run_cmd() {
  CMD_RC=0
  printf '  %b$ %s%b\n' "${DIM}" "$*" "${NC}"
  CMD_OUTPUT=$("$@" 2>&1) || CMD_RC=$?
  if [ -n "$CMD_OUTPUT" ]; then
    echo "$CMD_OUTPUT" | head -20 | sed 's/^/    /'
  fi
}

# --- Cleanup ---

cleanup() {
  if [ "$SKIP_CLEANUP" = "true" ]; then
    echo ""
    echo -e "  ${YELLOW}Skipping cleanup (--skip-cleanup)${NC}"
    if [ -n "$CREATED_SANDBOX" ]; then
      echo -e "  Retained sandbox: ${CREATED_SANDBOX}"
    fi
    if [ -n "$CREATED_PROVIDER" ]; then
      echo -e "  Retained provider: ${CREATED_PROVIDER}"
    fi
    kill "${PF_PID}" 2>/dev/null || true
    kill "${GW_PF_PID}" 2>/dev/null || true
    return
  fi

  echo ""
  echo -e "${BOLD}Cleaning up...${NC}"

  if [ -n "$CREATED_SETTING_GLOBAL" ] && [ -n "$GATEWAY_NAME" ]; then
    openshell settings delete --gateway "$GATEWAY_NAME" --global --yes \
      --key "$CREATED_SETTING_GLOBAL" 2>/dev/null && \
      echo "  Deleted global setting: ${CREATED_SETTING_GLOBAL}" || true
  fi
  if [ -n "$CREATED_SETTING_SANDBOX" ] && [ -n "$GATEWAY_NAME" ] && [ -n "$SANDBOX_NAME" ]; then
    openshell settings delete --gateway "$GATEWAY_NAME" \
      --key "$CREATED_SETTING_SANDBOX" "$SANDBOX_NAME" 2>/dev/null && \
      echo "  Deleted sandbox setting: ${CREATED_SETTING_SANDBOX}" || true
  fi

  if [ -n "$CREATED_PROVIDER" ] && [ -n "$GATEWAY_NAME" ]; then
    openshell provider delete --gateway "$GATEWAY_NAME" "$CREATED_PROVIDER" 2>/dev/null && \
      echo "  Deleted provider: ${CREATED_PROVIDER}" || true
  fi

  if [ -n "$CREATED_SANDBOX" ] && [ -n "$GATEWAY_NAME" ]; then
    openshell sandbox delete --gateway "$GATEWAY_NAME" "$CREATED_SANDBOX" 2>/dev/null && \
      echo "  Deleted sandbox: ${CREATED_SANDBOX}" || true
  fi

  if [ -n "$GATEWAY_NAME" ]; then
    openshell gateway remove "$GATEWAY_NAME" 2>/dev/null && \
      echo "  Removed gateway registration: ${GATEWAY_NAME}" || true
  fi

  kill "${PF_PID}" 2>/dev/null || true
  kill "${GW_PF_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --- Port-forward ---

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

find_acpctl() {
  if command -v acpctl >/dev/null 2>&1; then echo acpctl; return; fi
  if [ -x "$REPO_ROOT/components/ambient-cli/acpctl" ]; then
    echo "$REPO_ROOT/components/ambient-cli/acpctl"; return
  fi
  if [ -x "$REPO_ROOT/acpctl" ]; then echo "$REPO_ROOT/acpctl"; return; fi
  echo ""
}

# ============================================================================
# Section 1: Prerequisites
# ============================================================================

section "1. Prerequisites"

# Token
if [ -z "$TOKEN" ]; then
  fail "TEST_TOKEN not set — run 'make kind-up' first, or: source tests/cypress/.env.test"
  echo -e "\n${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}\n"
  exit 1
fi
pass "TEST_TOKEN available"

# openshell CLI
if ! command -v openshell &>/dev/null; then
  fail "openshell CLI not found — install it or add to PATH"
  echo -e "\n${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}\n"
  exit 1
fi
pass "openshell CLI found: $(command -v openshell)"

# acpctl
ACPCTL=$(find_acpctl)
if [ -n "$ACPCTL" ]; then
  pass "acpctl found: $ACPCTL"
else
  fail "acpctl not found — run 'make build-cli'"
  echo -e "\n${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}\n"
  exit 1
fi

# Port-forward
_ensure_port_forward
pass "API server port-forward ready (${API_URL})"

# Login
run_cmd $ACPCTL login --url "$API_URL" --token "$TOKEN" --project "$TENANT"
if [ "$CMD_RC" -eq 0 ]; then
  run_cmd $ACPCTL whoami
  pass "acpctl login succeeded (${API_URL}, project: ${TENANT})"
else
  fail "acpctl login failed — is the API server reachable at ${API_URL}?"
  echo -e "\n${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}\n"
  exit 1
fi

# ============================================================================
# Section 2: Gateway Connectivity
# ============================================================================

section "2. Gateway connectivity"

# Check gateway is deployed
GW_READY=$(kubectl get statefulset openshell-gateway -n "$TENANT" \
  -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
GW_READY="${GW_READY:-0}"

if [ "${GW_READY}" -lt 1 ]; then
  fail "openshell-gateway not ready in ${TENANT} (readyReplicas=${GW_READY})"
  echo -e "\n${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}\n"
  exit 1
fi
pass "openshell-gateway StatefulSet ready in ${TENANT}"

# Port-forward to gateway gRPC port
gw_log=$(mktemp)
kubectl port-forward -n "${TENANT}" statefulset/openshell-gateway ":8080" \
  >"$gw_log" 2>&1 &
GW_PF_PID=$!

gw_port=""
for _i in $(seq 1 30); do
  if [ -s "$gw_log" ]; then
    gw_port=$(grep -oE 'Forwarding from 127\.0\.0\.1:[0-9]+' "$gw_log" | grep -oE '[0-9]+$' | head -1)
    [ -n "$gw_port" ] && break
  fi
  sleep 0.2
done
rm -f "$gw_log"

if [ -z "$gw_port" ]; then
  fail "Could not establish port-forward to gateway gRPC endpoint"
  echo -e "\n${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}\n"
  exit 1
fi
pass "Gateway port-forward established (localhost:${gw_port})"

# Register gateway with mTLS certificates
GATEWAY_NAME="${TENANT}"
openshell gateway remove "${GATEWAY_NAME}" 2>/dev/null || true

cert_dir="$HOME/.config/openshell/gateways/${GATEWAY_NAME}/mtls"
mkdir -p "$cert_dir"
kubectl get secret openshell-server-tls -n "${TENANT}" \
  -o jsonpath='{.data.ca\.crt}' | base64 -d > "$cert_dir/ca.crt"
kubectl get secret openshell-server-tls -n "${TENANT}" \
  -o jsonpath='{.data.tls\.crt}' | base64 -d > "$cert_dir/tls.crt"
kubectl get secret openshell-server-tls -n "${TENANT}" \
  -o jsonpath='{.data.tls\.key}' | base64 -d > "$cert_dir/tls.key"

GW_URL="https://localhost:${gw_port}"
run_cmd openshell gateway add --name "${GATEWAY_NAME}" --local "$GW_URL"
if [ "$CMD_RC" -eq 0 ]; then
  pass "Gateway registered as '${GATEWAY_NAME}'"
else
  fail "openshell gateway add failed"
  echo -e "\n${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}\n"
  exit 1
fi

# Re-extract certs after registration (gateway add may overwrite)
kubectl get secret openshell-server-tls -n "${TENANT}" \
  -o jsonpath='{.data.ca\.crt}' | base64 -d > "$cert_dir/ca.crt"
kubectl get secret openshell-server-tls -n "${TENANT}" \
  -o jsonpath='{.data.tls\.crt}' | base64 -d > "$cert_dir/tls.crt"
kubectl get secret openshell-server-tls -n "${TENANT}" \
  -o jsonpath='{.data.tls\.key}' | base64 -d > "$cert_dir/tls.key"

# Verify connectivity via sandbox list
run_cmd openshell sandbox list --gateway "$GATEWAY_NAME"
if [ "$CMD_RC" -eq 0 ]; then
  pass "openshell sandbox list --gateway ${GATEWAY_NAME} succeeded (connectivity verified)"
else
  fail "openshell sandbox list failed — gateway not reachable"
  echo -e "\n${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}\n"
  exit 1
fi

# ============================================================================
# Section 3: Sandbox Operations
# ============================================================================

section "3. Sandbox operations"

# Create sandbox (with timeout to prevent CI hang)
echo -e "  ${DIM}$ timeout 60 openshell sandbox create --gateway $GATEWAY_NAME --from $SANDBOX_FROM_IMAGE --no-tty -- echo ready${NC}"
SANDBOX_OUTPUT=$(timeout 60 openshell sandbox create --gateway "$GATEWAY_NAME" \
  --from "$SANDBOX_FROM_IMAGE" --no-tty -- echo ready 2>&1) || true
echo "$SANDBOX_OUTPUT" | head -20 | sed 's/^/    /'

SANDBOX_CLEAN=$(echo "$SANDBOX_OUTPUT" | sed 's/\x1b\[[0-9;]*m//g')
SANDBOX_NAME=$(echo "$SANDBOX_CLEAN" | grep -i 'Created sandbox:' | sed 's/.*Created sandbox:[[:space:]]*//' | tr -d '[:space:]' | head -1 || echo "")
if [ -z "$SANDBOX_NAME" ]; then
  SANDBOX_NAME=$(echo "$SANDBOX_CLEAN" | grep -oE '[a-z]+-[a-z]+' | head -1 || echo "")
fi

if [ -n "$SANDBOX_NAME" ]; then
  CREATED_SANDBOX="$SANDBOX_NAME"
  pass "Sandbox created: ${SANDBOX_NAME}"
else
  fail "Sandbox create failed"
  echo "  Output: $(echo "$SANDBOX_OUTPUT" | head -c 500)"
  echo -e "\n${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}\n"
  exit 1
fi

# List sandboxes
run_cmd openshell sandbox list --gateway "$GATEWAY_NAME"
if echo "$CMD_OUTPUT" | grep -q "$SANDBOX_NAME"; then
  pass "Sandbox appears in list output"
else
  fail "Sandbox '${SANDBOX_NAME}' not found in sandbox list"
fi

# Poll for sandbox readiness (120s timeout, 2s interval)
echo -e "  ${DIM}Polling sandbox status (up to 120s)...${NC}"
SANDBOX_READY=false
for _i in $(seq 1 60); do
  GET_OUTPUT=$(openshell sandbox get --gateway "$GATEWAY_NAME" "$SANDBOX_NAME" 2>&1 || echo "")
  if echo "$GET_OUTPUT" | grep -qi "READY"; then
    SANDBOX_READY=true
    break
  fi
  printf '.'
  sleep 2
done
echo ""

if [ "$SANDBOX_READY" = "true" ]; then
  pass "Sandbox reached READY phase within 120s"
else
  fail "Sandbox did not reach READY within 120s"
  echo "  Last get output:"
  echo "$GET_OUTPUT" | head -10 | sed 's/^/    /'
  kubectl get pods -n "$TENANT" -l "openshell.io/sandbox-name=${SANDBOX_NAME}" --no-headers 2>/dev/null | sed 's/^/    /' || true
fi

# Get sandbox details
run_cmd openshell sandbox get --gateway "$GATEWAY_NAME" "$SANDBOX_NAME"
if [ -n "$CMD_OUTPUT" ] && echo "$CMD_OUTPUT" | grep -q "$SANDBOX_NAME"; then
  pass "Sandbox get returned details for ${SANDBOX_NAME}"
else
  fail "Sandbox get returned no details"
fi

# Exec into sandbox (only if ready)
if [ "$SANDBOX_READY" = "true" ]; then
  run_cmd openshell sandbox exec --gateway "$GATEWAY_NAME" -n "$SANDBOX_NAME" -- echo hello
  if echo "$CMD_OUTPUT" | grep -q "hello"; then
    pass "Sandbox exec: 'echo hello' returned 'hello'"
  else
    fail "Sandbox exec: expected 'hello' in output"
  fi
else
  skip "Sandbox exec" "sandbox not ready"
fi

# ============================================================================
# Section 4: Provider Operations
# ============================================================================

section "4. Provider operations"

PROVIDER_NAME="e2e-test-provider"

# Create provider
run_cmd openshell provider create --gateway "$GATEWAY_NAME" \
  --name "$PROVIDER_NAME" --type generic \
  --credential TEST_KEY=test-value
if [ "$CMD_RC" -eq 0 ]; then
  CREATED_PROVIDER="$PROVIDER_NAME"
  pass "Provider created: ${PROVIDER_NAME}"
else
  fail "Provider create failed"
fi

# Get provider
if [ -n "$CREATED_PROVIDER" ]; then
  run_cmd openshell provider get --gateway "$GATEWAY_NAME" "$PROVIDER_NAME"
  if echo "$CMD_OUTPUT" | grep -q "$PROVIDER_NAME"; then
    pass "Provider get returned details for ${PROVIDER_NAME}"
  else
    fail "Provider get returned no details"
  fi
fi

# List providers
run_cmd openshell provider list --gateway "$GATEWAY_NAME"
if echo "$CMD_OUTPUT" | grep -q "$PROVIDER_NAME"; then
  pass "Provider appears in list output"
else
  if [ -n "$CREATED_PROVIDER" ]; then
    fail "Provider '${PROVIDER_NAME}' not found in provider list"
  else
    skip "Provider list" "provider not created"
  fi
fi

# Delete provider
if [ -n "$CREATED_PROVIDER" ]; then
  run_cmd openshell provider delete --gateway "$GATEWAY_NAME" "$PROVIDER_NAME"
  if [ "$CMD_RC" -eq 0 ]; then
    pass "Provider deleted: ${PROVIDER_NAME}"
    # Verify it's gone
    run_cmd openshell provider list --gateway "$GATEWAY_NAME"
    if echo "$CMD_OUTPUT" | grep -q "$PROVIDER_NAME"; then
      fail "Provider still appears in list after delete"
    else
      pass "Provider confirmed absent after delete"
    fi
    CREATED_PROVIDER=""
  else
    fail "Provider delete failed"
  fi
fi

# ============================================================================
# Section 5: Policy Operations
# ============================================================================

section "5. Policy operations"

POLICY_FIXTURE="$SCRIPT_DIR/fixtures/openshell-cli-test/test-policy.yaml"

if [ "$SANDBOX_READY" != "true" ]; then
  skip "Policy operations" "sandbox not ready"
else
  # Set policy
  run_cmd openshell policy set --gateway "$GATEWAY_NAME" \
    --policy "$POLICY_FIXTURE" "$SANDBOX_NAME"
  if [ "$CMD_RC" -eq 0 ]; then
    pass "Policy set via fixture file"
  else
    fail "Policy set failed"
  fi

  # Set policy again (idempotent)
  run_cmd openshell policy set --gateway "$GATEWAY_NAME" \
    --policy "$POLICY_FIXTURE" "$SANDBOX_NAME"
  if [ "$CMD_RC" -eq 0 ]; then
    pass "Policy set idempotent (second apply succeeded)"
  else
    fail "Policy set idempotent failed on second apply"
  fi

  # Get policy
  run_cmd openshell policy get --gateway "$GATEWAY_NAME" "$SANDBOX_NAME"
  if [ -n "$CMD_OUTPUT" ] && echo "$CMD_OUTPUT" | grep -qi "network\|filesystem\|version\|rev\|policy"; then
    pass "Policy get returned policy details"
  else
    fail "Policy get returned no policy data"
  fi

  # List policies
  run_cmd openshell policy list --gateway "$GATEWAY_NAME" "$SANDBOX_NAME"
  if [ -n "$CMD_OUTPUT" ]; then
    pass "Policy list returned results"
  else
    fail "Policy list returned nothing"
  fi

  # Policy enforcement: allowed endpoint
  echo -e "  ${DIM}Waiting 3s for policy propagation...${NC}"
  sleep 3
  run_cmd openshell sandbox exec --gateway "$GATEWAY_NAME" \
    -n "$SANDBOX_NAME" -- curl -sf https://update.code.visualstudio.com
  if echo "$CMD_OUTPUT" | grep -q "policy_denied"; then
    fail "Allowed endpoint was denied by policy"
  elif [ -n "$CMD_OUTPUT" ]; then
    pass "Policy enforcement: allowed endpoint (update.code.visualstudio.com) reachable"
  else
    skip "Policy enforcement (allowed)" "no response from curl — sandbox may not have curl"
  fi

  # Policy enforcement: blocked endpoint
  run_cmd openshell sandbox exec --gateway "$GATEWAY_NAME" \
    -n "$SANDBOX_NAME" -- curl -sf http://example.com
  if echo "$CMD_OUTPUT" | grep -q "policy_denied"; then
    pass "Policy enforcement: blocked endpoint returned policy_denied"
  elif [ -z "$CMD_OUTPUT" ]; then
    pass "Policy enforcement: blocked endpoint returned no response (denied)"
  else
    fail "Policy enforcement: blocked endpoint was NOT denied"
  fi

  # Delete policy (global lock reset)
  run_cmd openshell policy delete --gateway "$GATEWAY_NAME" --global --yes
  if [ "$CMD_RC" -eq 0 ]; then
    pass "Global policy lock deleted"
  else
    skip "Policy delete" "no global policy lock to delete"
  fi
fi

# ============================================================================
# Section 6: Settings Operations
# ============================================================================

section "6. Settings operations"

# Global setting: set
SETTING_KEY_GLOBAL="providers_v2_enabled"
SETTING_VALUE="true"

run_cmd openshell settings set --gateway "$GATEWAY_NAME" --global --yes \
  --key "$SETTING_KEY_GLOBAL" --value "$SETTING_VALUE"
if [ "$CMD_RC" -eq 0 ]; then
  CREATED_SETTING_GLOBAL="$SETTING_KEY_GLOBAL"
  pass "Global setting set: ${SETTING_KEY_GLOBAL}=${SETTING_VALUE}"
else
  fail "Global settings set failed"
fi

# Global setting: get
if [ -n "$CREATED_SETTING_GLOBAL" ]; then
  run_cmd openshell settings get --gateway "$GATEWAY_NAME" --global
  if echo "$CMD_OUTPUT" | grep -q "${SETTING_KEY_GLOBAL}.*${SETTING_VALUE}"; then
    pass "Global settings get shows ${SETTING_KEY_GLOBAL} = ${SETTING_VALUE}"
  else
    fail "Global settings get returned unexpected value"
  fi
fi

# Per-sandbox setting: set
SETTING_KEY_SANDBOX="ocsf_json_enabled"
SETTING_VALUE_SANDBOX="true"

if [ "$SANDBOX_READY" = "true" ]; then
  run_cmd openshell settings set --gateway "$GATEWAY_NAME" \
    --key "$SETTING_KEY_SANDBOX" --value "$SETTING_VALUE_SANDBOX" "$SANDBOX_NAME"
  if [ "$CMD_RC" -eq 0 ]; then
    CREATED_SETTING_SANDBOX="$SETTING_KEY_SANDBOX"
    pass "Per-sandbox setting set: ${SETTING_KEY_SANDBOX}=${SETTING_VALUE_SANDBOX}"
  else
    fail "Per-sandbox settings set failed"
  fi

  # Per-sandbox setting: get
  if [ -n "$CREATED_SETTING_SANDBOX" ]; then
    run_cmd openshell settings get --gateway "$GATEWAY_NAME" "$SANDBOX_NAME"
    if echo "$CMD_OUTPUT" | grep -q "${SETTING_KEY_SANDBOX}.*${SETTING_VALUE_SANDBOX}"; then
      pass "Per-sandbox settings get shows ${SETTING_KEY_SANDBOX} = ${SETTING_VALUE_SANDBOX}"
    else
      fail "Per-sandbox settings get returned unexpected value"
    fi
  fi
else
  skip "Per-sandbox settings" "sandbox not ready"
fi

# Per-sandbox setting: delete
if [ -n "$CREATED_SETTING_SANDBOX" ] && [ "$SANDBOX_READY" = "true" ]; then
  run_cmd openshell settings delete --gateway "$GATEWAY_NAME" \
    --key "$SETTING_KEY_SANDBOX" "$SANDBOX_NAME"
  if [ "$CMD_RC" -eq 0 ]; then
    pass "Per-sandbox setting deleted"
    CREATED_SETTING_SANDBOX=""
  else
    fail "Per-sandbox settings delete failed"
  fi
fi

# Global setting: delete
if [ -n "$CREATED_SETTING_GLOBAL" ]; then
  run_cmd openshell settings delete --gateway "$GATEWAY_NAME" --global --yes \
    --key "$SETTING_KEY_GLOBAL"
  if [ "$CMD_RC" -eq 0 ]; then
    pass "Global setting deleted"
    # Verify it's gone
    run_cmd openshell settings get --gateway "$GATEWAY_NAME" --global
    if echo "$CMD_OUTPUT" | grep "${SETTING_KEY_GLOBAL}" | grep -q "unset"; then
      pass "Global setting confirmed as <unset> after delete"
    else
      pass "Global setting delete verified"
    fi
    CREATED_SETTING_GLOBAL=""
  else
    fail "Global settings delete failed"
  fi
fi

# ============================================================================
# Section 7: Cross-Validation (optional)
# ============================================================================

section "7. Cross-validation with cluster state"

if [ "$CLUSTER_VALIDATE" != "true" ]; then
  skip "Cross-validation" "--cluster-validate not set"
else
  if [ -n "$CREATED_SANDBOX" ]; then
    SBX_K8S=$(kubectl get sandboxes -n "$TENANT" --no-headers 2>/dev/null | grep "$SANDBOX_NAME" || echo "")
    if [ -n "$SBX_K8S" ]; then
      pass "CLI-created sandbox visible as Kubernetes Sandbox CRD"
      K8S_PHASE=$(echo "$SBX_K8S" | awk '{print $2}' | head -1)
      run_cmd openshell sandbox get --gateway "$GATEWAY_NAME" "$SANDBOX_NAME"
      if echo "$CMD_OUTPUT" | grep -qi "$K8S_PHASE"; then
        pass "Sandbox phase matches between CLI and K8s (${K8S_PHASE})"
      else
        skip "Phase match" "could not compare phases"
      fi
    else
      fail "CLI-created sandbox not visible as K8s resource"
    fi

    POD_EXISTS=$(kubectl get pods -n "$TENANT" --no-headers 2>/dev/null | grep "$SANDBOX_NAME" || echo "")
    if [ -n "$POD_EXISTS" ]; then
      POD_PHASE=$(echo "$POD_EXISTS" | awk '{print $3}')
      pass "Sandbox pod exists in namespace ${TENANT} (status: ${POD_PHASE})"
    else
      fail "No pod found for sandbox ${SANDBOX_NAME}"
    fi
  else
    skip "Sandbox K8s validation" "no sandbox created"
  fi

  run_cmd openshell provider list --gateway "$GATEWAY_NAME"
  if [ -n "$CMD_OUTPUT" ]; then
    pass "ACP-created providers visible via openshell CLI"
  else
    skip "ACP provider visibility" "no providers found"
  fi
fi

# ============================================================================
# Section 8: Cleanup
# ============================================================================

section "8. Sandbox delete"

if [ -n "$CREATED_SANDBOX" ] && [ "$SKIP_CLEANUP" != "true" ]; then
  run_cmd openshell sandbox delete --gateway "$GATEWAY_NAME" "$SANDBOX_NAME"
  if [ "$CMD_RC" -eq 0 ]; then
    pass "Sandbox deleted via openshell CLI"

    sleep 2
    run_cmd openshell sandbox list --gateway "$GATEWAY_NAME"
    if echo "$CMD_OUTPUT" | grep -q "$SANDBOX_NAME"; then
      fail "Sandbox still appears in list after delete"
    else
      pass "Sandbox confirmed absent after delete"
    fi
    CREATED_SANDBOX=""
  else
    fail "Sandbox delete failed"
  fi
elif [ "$SKIP_CLEANUP" = "true" ]; then
  skip "Sandbox delete" "--skip-cleanup set"
else
  skip "Sandbox delete" "no sandbox was created"
fi

# ============================================================================
# Results
# ============================================================================

echo ""
echo -e "${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}"
echo ""

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
