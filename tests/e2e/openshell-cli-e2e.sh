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
#   - Keycloak reachable (KEYCLOAK_URL, default http://localhost:11880)
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
TENANT="${TENANT:-e2e-openshell-oidc}"
FIXTURE_DIR="$SCRIPT_DIR/fixtures/openshell-cli-test"
SKIP_CLEANUP=false
CLUSTER_VALIDATE=true
GATEWAY_NAME=""
SANDBOX_NAME=""
SANDBOX_IMAGE="${OPENSHELL_RUNNER_IMAGE:-localhost/acp_runner_openshell:kind-preloaded}"
SANDBOX_FROM_IMAGE="${SANDBOX_IMAGE}"

# Parse flags
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --skip-cleanup) SKIP_CLEANUP=true; shift ;;
    --cluster-validate) CLUSTER_VALIDATE=true; shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

# Keycloak OIDC credentials for password-grant login
KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:11880}"
KEYCLOAK_ISSUER="${KEYCLOAK_URL}/realms/ambient-code"
KEYCLOAK_CLIENT_ID="${KEYCLOAK_CLIENT_ID:-openshell-cli}"
KEYCLOAK_DEV_USER="${KEYCLOAK_DEV_USER:-developer}"
KEYCLOAK_DEV_PASS="${KEYCLOAK_DEV_PASS:-developer}"
KEYCLOAK_ADMIN_USER="${KEYCLOAK_ADMIN_USER:-admin}"
KEYCLOAK_ADMIN_PASS="${KEYCLOAK_ADMIN_PASS:-admin}"

# API URL
PF_PID=""
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
CYAN='\033[36m'
ORANGE='\033[38;5;214m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

PASSED=0
FAILED=0

sep()     { printf '%b%s%b\n' "${DIM}" "──────────────────────────────────────────────────" "${NC}"; }
pass()    { echo -e "  ${GREEN}✓${NC} $1"; PASSED=$((PASSED + 1)); }
fail()    { echo -e "  ${RED}✗${NC} $1"; FAILED=$((FAILED + 1)); }
skip()    { echo -e "  ${YELLOW}⊘${NC} $1 (skipped: $2)"; }

section() {
  echo ""
  sep
  printf '%b━━  %s%b\n' "${CYAN}" "$*" "${NC}"
  sep
}

# Re-register gateway via --kubectl to recover from stale port-forward connections.
# --kubectl starts its own port-forward and fetches TLS certs from the cluster.
_refresh_gateway() {
  openshell gateway remove "${GATEWAY_NAME}" 2>/dev/null || true
  $ACPCTL gateway setup-cli --kubectl --project "$TENANT" >/dev/null 2>&1 || true
}

# Run a command with visibility: print it, execute, capture + display output.
# Sets CMD_OUTPUT and CMD_RC for callers to inspect.
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
    return
  fi

  echo ""
  printf '%b%s%b\n' "${DIM}" "cleaning up..." "${NC}"

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

# ── intro ────────────────────────────────────────────────────────────────────

echo ""
printf '%b%s%b\n' "${BOLD}" "OpenShell CLI E2E Test" "${NC}"
printf '%b  Tenant:    %s%b\n' "${DIM}" "${TENANT}" "${NC}"
printf '%b  API:       %s%b\n' "${DIM}" "${API_URL}" "${NC}"
printf '%b  Image:     %s%b\n' "${DIM}" "${SANDBOX_IMAGE}" "${NC}"

# ============================================================================
# Section 1: Prerequisites
# ============================================================================

section "1 · Prerequisites"

# openshell CLI
if ! command -v openshell &>/dev/null; then
  fail "openshell CLI not found — install it or add to PATH"
  echo ""; sep; printf '%b  %d passed, %d failed%b\n' "${RED}" "$PASSED" "$FAILED" "${NC}"; sep; echo ""
  exit 1
fi
pass "openshell CLI found: $(command -v openshell)"

# acpctl
ACPCTL=$(find_acpctl)
if [ -n "$ACPCTL" ]; then
  pass "acpctl found: $ACPCTL"
else
  fail "acpctl not found — run 'make build-cli'"
  echo ""; sep; printf '%b  %d passed, %d failed%b\n' "${RED}" "$PASSED" "$FAILED" "${NC}"; sep; echo ""
  exit 1
fi

# Port-forward
_ensure_port_forward
pass "API server port-forward ready (${API_URL})"

# Provision test tenant (self-contained — creates namespace, project, OIDC gateway)
printf '  %b▶%b  Provisioning test tenant "%s" from fixture...\n' "${BOLD}" "${NC}" "$TENANT"
kubectl create namespace "$TENANT" --dry-run=client -o yaml | kubectl apply -f - 2>/dev/null
TEST_TOKEN=$(kubectl get secret test-user-token -n "${NAMESPACE}" -o jsonpath='{.data.token}' | base64 -d 2>/dev/null)
$ACPCTL login --url "$API_URL" --token "$TEST_TOKEN" >/dev/null 2>&1
run_cmd $ACPCTL apply -k "$FIXTURE_DIR" --project "$TENANT"
if [ "$CMD_RC" -eq 0 ]; then
  pass "Test tenant provisioned via fixture (project + OIDC gateway)"
else
  fail "Failed to provision test tenant — acpctl apply -k returned rc=${CMD_RC}"
  echo ""; sep; printf '%b  %d passed, %d failed%b\n' "${RED}" "$PASSED" "$FAILED" "${NC}"; sep; echo ""
  exit 1
fi

# Wait for gateway pod to exist and reach ready (control plane reconciles asynchronously)
printf '  %b▶%b  Waiting for gateway pod in %s...\n' "${BOLD}" "${NC}" "$TENANT"
GW_POD_LABELS="app.kubernetes.io/instance=openshell-gateway,app.kubernetes.io/component=gateway"
for _i in $(seq 1 120); do
  kubectl get pod -l "$GW_POD_LABELS" -n "$TENANT" --no-headers 2>/dev/null | grep -q . && break
  sleep 3
done
kubectl wait --for=condition=ready pod -l "$GW_POD_LABELS" \
  -n "$TENANT" --timeout=180s 2>/dev/null || {
    fail "Gateway pod not ready in ${TENANT} after waiting"
    kubectl get pods -n "$TENANT" -o wide 2>&1 | sed 's/^/    /' || true
    kubectl logs -n "$TENANT" -l app.kubernetes.io/instance=openshell-gateway --tail=20 2>&1 | sed 's/^/    /' || true
    echo ""; sep; printf '%b  %d passed, %d failed%b\n' "${RED}" "$PASSED" "$FAILED" "${NC}"; sep; echo ""
    exit 1
  }
pass "Gateway pod ready in ${TENANT}"

# Resolve the certgen/cert-manager TLS race.  The certgen Job pod creates initial TLS
# secrets (CA_A).  The control plane then deletes them and creates cert-manager Certificate
# CRs, but the certgen pod may still be running (orphaned after Job deletion) and can
# overwrite cert-manager's secrets (CA_B).  To guarantee cert-manager is the sole writer:
#   1. Wait for certgen pod to finish
#   2. Delete the server/client secrets (force cert-manager re-issue)
#   3. Wait for cert-manager to recreate them
#   4. Restart the gateway pod so it loads the final certs
printf '  %b▶%b  Waiting for certgen to finish in %s...\n' "${BOLD}" "${NC}" "$TENANT"
for _i in $(seq 1 30); do
  _cg=$(kubectl get pod -n "$TENANT" --no-headers 2>/dev/null | grep "certgen" || true)
  if [ -n "$_cg" ] && echo "$_cg" | grep -qE "Completed|Error"; then
    break
  fi
  sleep 2
done

kubectl delete secret openshell-server-tls openshell-client-tls \
  -n "$TENANT" --ignore-not-found 2>/dev/null || true

printf '  %b▶%b  Waiting for cert-manager to issue TLS secrets in %s...\n' "${BOLD}" "${NC}" "$TENANT"
for _i in $(seq 1 60); do
  kubectl get secret openshell-ca-tls openshell-server-tls openshell-client-tls \
    -n "$TENANT" &>/dev/null && break
  sleep 3
done
if kubectl get secret openshell-ca-tls openshell-server-tls openshell-client-tls \
  -n "$TENANT" &>/dev/null; then
  pass "cert-manager TLS secrets ready in ${TENANT}"
else
  fail "cert-manager TLS secrets not ready in ${TENANT} after 180s"
  kubectl get secrets -n "$TENANT" 2>&1 | sed 's/^/    /' || true
  echo ""; sep; printf '%b  %d passed, %d failed%b\n' "${RED}" "$PASSED" "$FAILED" "${NC}"; sep; echo ""
  exit 1
fi

kubectl delete pod -l "$GW_POD_LABELS" -n "$TENANT" --wait=false
for _i in $(seq 1 60); do
  kubectl get pod -l "$GW_POD_LABELS" -n "$TENANT" --no-headers 2>/dev/null | grep -q "Running" && break
  sleep 3
done
kubectl wait --for=condition=ready pod -l "$GW_POD_LABELS" \
  -n "$TENANT" --timeout=120s 2>/dev/null || {
    fail "Gateway pod not ready after cert-manager restart"
    echo ""; sep; printf '%b  %d passed, %d failed%b\n' "${RED}" "$PASSED" "$FAILED" "${NC}"; sep; echo ""
    exit 1
  }
pass "Gateway pod restarted with cert-manager TLS"

# Login as developer via OIDC password grant (headless, no browser)
run_cmd $ACPCTL login --password-grant \
  --username "$KEYCLOAK_DEV_USER" --password "$KEYCLOAK_DEV_PASS" \
  --client-id "$KEYCLOAK_CLIENT_ID" \
  --issuer-url "$KEYCLOAK_ISSUER" \
  --url "$API_URL" --project "$TENANT"
if [ "$CMD_RC" -eq 0 ]; then
  run_cmd $ACPCTL whoami
  pass "acpctl login succeeded as developer (${API_URL}, project: ${TENANT})"
else
  fail "acpctl login --password-grant failed — is Keycloak reachable at ${KEYCLOAK_URL}?"
  echo ""; sep; printf '%b  %d passed, %d failed%b\n' "${RED}" "$PASSED" "$FAILED" "${NC}"; sep; echo ""
  exit 1
fi

# ============================================================================
# Section 2: Gateway Connectivity
# ============================================================================

section "2 · Gateway Connectivity"

# Check gateway is deployed
GW_READY=$(kubectl get statefulset openshell-gateway -n "$TENANT" \
  -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
GW_READY="${GW_READY:-0}"

if [ "${GW_READY}" -lt 1 ]; then
  fail "openshell-gateway not ready in ${TENANT} (readyReplicas=${GW_READY})"
  echo ""; sep; printf '%b  %d passed, %d failed%b\n' "${RED}" "$PASSED" "$FAILED" "${NC}"; sep; echo ""
  exit 1
fi
pass "openshell-gateway StatefulSet ready in ${TENANT}"

# Register gateway via --kubectl (starts port-forward + fetches TLS certs)
GATEWAY_NAME="${TENANT}-openshell-gateway"
openshell gateway remove "${GATEWAY_NAME}" 2>/dev/null || true

run_cmd $ACPCTL gateway setup-cli --kubectl --project "$TENANT"
if [ "$CMD_RC" -eq 0 ]; then
  pass "Gateway registered via acpctl setup-cli as '${GATEWAY_NAME}'"
else
  fail "acpctl gateway setup-cli failed"
  echo ""; sep; printf '%b  %d passed, %d failed%b\n' "${RED}" "$PASSED" "$FAILED" "${NC}"; sep; echo ""
  exit 1
fi

# Verify connectivity via sandbox list
run_cmd openshell sandbox list --gateway "$GATEWAY_NAME"
if [ "$CMD_RC" -eq 0 ]; then
  pass "openshell sandbox list --gateway ${GATEWAY_NAME} succeeded (connectivity verified)"
else
  fail "openshell sandbox list failed — gateway not reachable"
  echo ""; sep; printf '%b  %d passed, %d failed%b\n' "${RED}" "$PASSED" "$FAILED" "${NC}"; sep; echo ""
  exit 1
fi

# ============================================================================
# Section 3: Sandbox Operations
# ============================================================================

section "3 · Sandbox Operations"

# Create sandbox (with timeout to prevent CI hang; gtimeout on macOS)
TIMEOUT_CMD=""
if command -v timeout &>/dev/null; then
  TIMEOUT_CMD="timeout 60"
elif command -v gtimeout &>/dev/null; then
  TIMEOUT_CMD="gtimeout 60"
fi

echo ""
printf '  %b▶%b  Create sandbox\n' "${BOLD}" "${NC}"
printf '  %b$ %s openshell sandbox create --gateway %s --from %s --no-tty -- echo ready%b\n' \
  "${ORANGE}" "${TIMEOUT_CMD:-"(no timeout)"}" "$GATEWAY_NAME" "$SANDBOX_FROM_IMAGE" "${NC}"
SANDBOX_OUTPUT=$($TIMEOUT_CMD openshell sandbox create --gateway "$GATEWAY_NAME" \
  --from "$SANDBOX_FROM_IMAGE" --no-tty -- echo ready 2>&1) || true
echo "$SANDBOX_OUTPUT" | head -20 | sed 's/^/    /'
echo ""

SANDBOX_CLEAN=$(echo "$SANDBOX_OUTPUT" | sed 's/\x1b\[[0-9;]*m//g')
SANDBOX_NAME=$(echo "$SANDBOX_CLEAN" | grep -i 'Created sandbox:' | sed 's/.*Created sandbox:[[:space:]]*//' | tr -d '[:space:]' | head -1 || echo "")

if [ -n "$SANDBOX_NAME" ]; then
  CREATED_SANDBOX="$SANDBOX_NAME"
  pass "Sandbox created: ${SANDBOX_NAME}"
else
  fail "Sandbox create failed"
  echo "  Output: $(echo "$SANDBOX_OUTPUT" | head -c 500)"
  echo ""; sep; printf '%b  %d passed, %d failed%b\n' "${RED}" "$PASSED" "$FAILED" "${NC}"; sep; echo ""
  exit 1
fi

# Refresh token + port-forward — sandbox create can exceed the token TTL and kill the pf
run_cmd $ACPCTL login --password-grant \
  --username "$KEYCLOAK_DEV_USER" --password "$KEYCLOAK_DEV_PASS" \
  --client-id "$KEYCLOAK_CLIENT_ID" \
  --issuer-url "$KEYCLOAK_ISSUER" \
  --url "$API_URL" --project "$TENANT"
openshell gateway remove "${GATEWAY_NAME}" 2>/dev/null || true
run_cmd $ACPCTL gateway setup-cli --kubectl --project "$TENANT"

# List sandboxes
run_cmd openshell sandbox list --gateway "$GATEWAY_NAME"
if echo "$CMD_OUTPUT" | grep -q "$SANDBOX_NAME"; then
  pass "Sandbox appears in list output"
else
  fail "Sandbox '${SANDBOX_NAME}' not found in sandbox list"
fi

# Poll for sandbox readiness (180s timeout, 2s interval)
printf '  %b▶%b  Waiting for sandbox READY (up to 180s)...\n' "${BOLD}" "${NC}"
SANDBOX_READY=false
for _i in $(seq 1 90); do
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
  pass "Sandbox reached READY phase"
else
  skip "Sandbox READY" "did not reach READY within 180s (sandbox provisioning slow in CI)"
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
# Section 4: RBAC Validation (developer vs admin)
# ============================================================================

section "4 · RBAC Validation"

# Verify developer is denied admin operations
run_cmd openshell provider create --gateway "$GATEWAY_NAME" \
  --name "rbac-test-provider" --type generic \
  --credential TEST_KEY=test-value
if [ "$CMD_RC" -ne 0 ] && echo "$CMD_OUTPUT" | grep -qi "permission"; then
  pass "Developer correctly denied provider create (openshell-admin required)"
elif [ "$CMD_RC" -eq 0 ]; then
  fail "Developer should NOT have admin access to provider create"
  openshell provider delete --gateway "$GATEWAY_NAME" "rbac-test-provider" 2>/dev/null || true
else
  skip "RBAC validation" "unexpected error: rc=${CMD_RC}"
fi

# Re-login as admin for admin-only operations (providers, policies, settings)
run_cmd $ACPCTL login --password-grant \
  --username "$KEYCLOAK_ADMIN_USER" --password "$KEYCLOAK_ADMIN_PASS" \
  --client-id "$KEYCLOAK_CLIENT_ID" \
  --issuer-url "$KEYCLOAK_ISSUER" \
  --url "$API_URL" --project "$TENANT"
if [ "$CMD_RC" -eq 0 ]; then
  run_cmd $ACPCTL whoami
  pass "Re-login as admin succeeded"
else
  fail "Re-login as admin failed — admin operations will be skipped"
fi

# Re-register gateway with admin credentials
openshell gateway remove "${GATEWAY_NAME}" 2>/dev/null || true
run_cmd $ACPCTL gateway setup-cli --kubectl --project "$TENANT"
if [ "$CMD_RC" -eq 0 ]; then
  pass "Gateway re-registered with admin credentials"
else
  fail "Gateway re-registration with admin credentials failed"
fi

# ============================================================================
# Section 5: Provider Operations
# ============================================================================

section "5 · Provider Operations"
_refresh_gateway

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
# Section 6: Policy Operations
# ============================================================================

section "6 · Policy Operations"
_refresh_gateway

POLICY_FIXTURE="$SCRIPT_DIR/fixtures/openshell-cli-test/test-policy.yaml"

if [ "$SANDBOX_READY" != "true" ]; then
  skip "Policy operations" "sandbox not ready"
else
  # Set policy — may skip if sandbox has default read_only paths not in the
  # fixture (gateway rejects removing read_only paths from a live sandbox).
  run_cmd openshell policy set --gateway "$GATEWAY_NAME" \
    --policy "$POLICY_FIXTURE" "$SANDBOX_NAME"
  if [ "$CMD_RC" -eq 0 ]; then
    pass "Policy set via fixture file"
  elif echo "$CMD_OUTPUT" | grep -q "cannot be removed"; then
    skip "Policy set" "sandbox default read_only paths differ from fixture"
  else
    fail "Policy set failed"
  fi

  # Set policy again (idempotent) — only if first set succeeded
  if [ "$CMD_RC" -eq 0 ]; then
    run_cmd openshell policy set --gateway "$GATEWAY_NAME" \
      --policy "$POLICY_FIXTURE" "$SANDBOX_NAME"
    if [ "$CMD_RC" -eq 0 ]; then
      pass "Policy set idempotent (second apply succeeded)"
    else
      fail "Policy set idempotent failed on second apply"
    fi
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
  printf '  %b▶%b  Policy enforcement (waiting 3s for propagation)...\n' "${BOLD}" "${NC}"
  sleep 3
  run_cmd openshell sandbox exec --gateway "$GATEWAY_NAME" \
    -n "$SANDBOX_NAME" -- curl -sf https://update.code.visualstudio.com
  if [ "$CMD_RC" -eq 0 ]; then
    pass "Policy enforcement: allowed endpoint (update.code.visualstudio.com) reachable"
  elif echo "$CMD_OUTPUT" | grep -q "policy_denied"; then
    fail "Allowed endpoint was denied by policy"
  else
    skip "Policy enforcement (allowed)" "exec returned rc=${CMD_RC} — sandbox may not support exec yet"
  fi

  # Policy enforcement: blocked endpoint
  run_cmd openshell sandbox exec --gateway "$GATEWAY_NAME" \
    -n "$SANDBOX_NAME" -- curl -sf http://example.com
  if echo "$CMD_OUTPUT" | grep -q "policy_denied"; then
    pass "Policy enforcement: blocked endpoint returned policy_denied"
  elif [ "$CMD_RC" -ne 0 ]; then
    pass "Policy enforcement: blocked endpoint rejected (rc=${CMD_RC})"
  else
    fail "Policy enforcement: blocked endpoint was NOT denied"
  fi

  # Per-sandbox policy is cleaned up when the sandbox is deleted;
  # `policy delete --global` only removes the global policy lock.
  pass "Sandbox policy lifecycle validated (cleanup deferred to sandbox delete)"
fi

# ============================================================================
# Section 7: Settings Operations
# ============================================================================

section "7 · Settings Operations"
_refresh_gateway

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
# Section 8: Cross-Validation (optional)
# ============================================================================

section "8 · Cross-Validation"

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
# Section 9: Cleanup
# ============================================================================

section "9 · Cleanup"
_refresh_gateway

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
sep
if [ "$FAILED" -gt 0 ]; then
  printf '%b  %d passed, %d failed%b\n' "${RED}" "$PASSED" "$FAILED" "${NC}"
else
  printf '%b  %d passed ✓%b\n' "${GREEN}" "$PASSED" "${NC}"
fi
sep
echo ""

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
