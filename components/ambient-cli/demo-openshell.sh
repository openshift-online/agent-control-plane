#!/usr/bin/env bash
# demo-openshell.sh — interactive tmux demo of OpenShell CLI operations
#
# Layout: left half = narrated demo, right half = sandbox watch panel.
# Walks through gateway setup, sandbox create, provider create, policy
# set + enforcement, settings set, and cleanup using the openshell CLI
# against an ACP-managed gateway.
#
# Usage:
#   ./demo-openshell.sh
#   PAUSE=3 ./demo-openshell.sh   # 3s delay between steps for live presentation
#
# Prerequisites:
#   - kind-up with OPENSHELL_USE_GATEWAY=true (default)
#   - acpctl built (make build-cli)
#   - openshell CLI installed and available in $PATH
#   - TEST_TOKEN set or tests/cypress/.env.test present
#
# Optional env:
#   NAMESPACE    — k8s namespace (default: ambient-code)
#   TENANT       — project/tenant namespace (default: tenant-a)
#   PAUSE        — seconds between demo steps (default: 0)
#   ACPCTL       — path to acpctl binary (default: from PATH or repo)
#   API_PORT     — local port for REST API (default: 18769)

set -euo pipefail

# ── tmux layout bootstrap ────────────────────────────────────────────────────

TMUX_SESSION="openshell-demo"
DEMO_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

if [[ -z "${TMUX:-}" ]]; then
    tmux new-session -d -s "$TMUX_SESSION" -x 220 -y 50

    # right column for sandbox watch
    tmux split-window -h -t "${TMUX_SESSION}:0" -p 40
    # split right into 2 panes (watch + exec)
    tmux split-window -v -t "${TMUX_SESSION}:0.1" -p 50

    tmux send-keys -t "${TMUX_SESSION}:0.1" "printf '\\033[2m[sandbox watch — waiting]\\033[0m\\n'" Enter
    tmux send-keys -t "${TMUX_SESSION}:0.2" "printf '\\033[2m[sandbox exec — waiting]\\033[0m\\n'" Enter

    # run this script in the left pane
    tmux send-keys -t "${TMUX_SESSION}:0.0" \
        "TMUX_SESSION=${TMUX_SESSION} INSIDE_DEMO_TMUX=1 bash ${DEMO_SCRIPT}" Enter

    tmux select-pane -t "${TMUX_SESSION}:0.0"
    tmux attach-session -t "$TMUX_SESSION"
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

NAMESPACE="${NAMESPACE:-ambient-code}"
TENANT="${TENANT:-tenant-a}"
PAUSE="${PAUSE:-0}"
API_PORT="${API_PORT:-18769}"
ACPCTL="${ACPCTL:-acpctl}"
SANDBOX_IMAGE="${OPENSHELL_RUNNER_IMAGE:-localhost/acp_runner_openshell:latest}"
SANDBOX_FROM_IMAGE="${SANDBOX_IMAGE}"

# ── helpers ──────────────────────────────────────────────────────────────────

bold()    { printf '\033[1m%s\033[0m\n' "$*"; }
dim()     { printf '\033[2m%s\033[0m\n' "$*"; }
cyan()    { printf '\033[36m%s\033[0m\n' "$*"; }
green()   { printf '\033[32m%s\033[0m\n' "$*"; }
yellow()  { printf '\033[33m%s\033[0m\n' "$*"; }
red()     { printf '\033[31m%s\033[0m\n' "$*"; }
sep()     { printf '\033[2m%s\033[0m\n' "──────────────────────────────────────────────────"; }

step() {
    local description="$1"
    shift
    echo
    sep
    bold "▶  $description"
    printf '\033[38;5;214m   $ %s\033[0m\n' "$*"
    sleep "$PAUSE"
    "$@"
    echo
}

announce() {
    echo
    sep
    cyan "━━  $*"
    sep
    sleep "$PAUSE"
}

# ── preflight ────────────────────────────────────────────────────────────────

if ! command -v kubectl &>/dev/null; then
    red "error: kubectl not found" >&2; exit 1
fi
if ! command -v openshell &>/dev/null; then
    red "error: openshell CLI not found. Install it or add to PATH." >&2; exit 1
fi

# Find acpctl
if ! command -v "$ACPCTL" &>/dev/null; then
    if [ -x "$REPO_ROOT/components/ambient-cli/acpctl" ]; then
        ACPCTL="$REPO_ROOT/components/ambient-cli/acpctl"
    elif [ -x "$REPO_ROOT/acpctl" ]; then
        ACPCTL="$REPO_ROOT/acpctl"
    else
        red "error: acpctl not found. Run 'make build-cli'." >&2; exit 1
    fi
fi

# ── resource tracking + cleanup ──────────────────────────────────────────────

PF_PIDS=()
GW_PF_PID=""
GATEWAY_NAME=""
SANDBOX_NAME=""
CREATED_PROVIDER=""
CREATED_SETTING=""

cleanup() {
    echo
    dim "cleaning up..."

    if [ -n "$CREATED_SETTING" ] && [ -n "$GATEWAY_NAME" ]; then
        openshell settings delete --gateway "$GATEWAY_NAME" --global --yes --key "$CREATED_SETTING" 2>/dev/null || true
    fi
    if [ -n "$CREATED_PROVIDER" ] && [ -n "$GATEWAY_NAME" ]; then
        openshell provider delete --gateway "$GATEWAY_NAME" "$CREATED_PROVIDER" 2>/dev/null || true
    fi
    if [ -n "$SANDBOX_NAME" ] && [ -n "$GATEWAY_NAME" ]; then
        openshell sandbox delete --gateway "$GATEWAY_NAME" "$SANDBOX_NAME" 2>/dev/null || true
    fi
    if [ -n "$GATEWAY_NAME" ]; then
        openshell gateway remove "$GATEWAY_NAME" 2>/dev/null || true
    fi
    for pid in "${PF_PIDS[@]:-}"; do
        kill "$pid" 2>/dev/null || true
    done
    kill "$GW_PF_PID" 2>/dev/null || true
}
trap cleanup EXIT

# ── port-forward ─────────────────────────────────────────────────────────────

start_port_forward() {
    local label="$1" svc="$2" local_port="$3" svc_port="$4"
    kubectl port-forward "svc/${svc}" "${local_port}:${svc_port}" \
        -n "${NAMESPACE}" >/dev/null 2>&1 &
    PF_PIDS+=($!)
    dim "   port-forward ${label}: localhost:${local_port} → ${svc}:${svc_port}"
}

wait_for_port() {
    local port="$1" label="$2" deadline=$(( $(date +%s) + 15 ))
    while ! bash -c "echo >/dev/tcp/localhost/${port}" 2>/dev/null; do
        if [[ $(date +%s) -ge $deadline ]]; then
            yellow "   ✗ timeout waiting for ${label} on :${port}"
            return 1
        fi
        sleep 0.3
    done
    green "   ✓ ${label} ready on localhost:${port}"
}

# ── token ────────────────────────────────────────────────────────────────────

if [ -z "${TEST_TOKEN:-}" ] && [ -f "$REPO_ROOT/tests/cypress/.env.test" ]; then
    # shellcheck disable=SC1091
    source "$REPO_ROOT/tests/cypress/.env.test"
fi
TOKEN="${TEST_TOKEN:-}"
if [ -z "$TOKEN" ]; then
    TOKEN=$(kubectl get secret test-user-token -n "${NAMESPACE}" \
        -o jsonpath='{.data.token}' 2>/dev/null | base64 -d || echo "")
fi
if [ -z "$TOKEN" ]; then
    red "error: no token available" >&2; exit 1
fi

API_URL="http://localhost:${API_PORT}"

# ── intro ────────────────────────────────────────────────────────────────────

echo
bold "OpenShell CLI Demo"
dim  "  Tenant:    ${TENANT}"
dim  "  API:       ${API_URL}"
dim  "  Image:     ${SANDBOX_IMAGE}"

echo
sep
bold "What this demo will do:"
echo
printf '  %s\n' "1. Connect to an ACP-managed OpenShell gateway"
printf '  %s\n' "2. Create a sandbox and wait for it to be READY"
printf '  %s\n' "3. Create a provider with test credentials"
printf '  %s\n' "4. Apply a network policy and verify enforcement"
printf '  %s\n' "5. Set and read gateway settings"
printf '  %s\n' "6. Clean up all resources"
echo
printf '  \033[38;5;214m%-38s\033[0m %s\n' "Orange text like this" "= a command being run"
echo
sep
if [[ "${PAUSE}" -gt 0 ]] 2>/dev/null; then
    bold "   Press Enter to begin..."
    read -r
fi

# ── 0: port-forwards + login ────────────────────────────────────────────────

announce "0 · Setup"

start_port_forward "REST API" ambient-api-server "${API_PORT}" 8000
sleep 1
wait_for_port "${API_PORT}" "REST API"

step "Log in to ACP" \
    "$ACPCTL" login --url "$API_URL" --token "$TOKEN" --project "$TENANT"

step "Show authenticated user" \
    "$ACPCTL" whoami

# ── 1: gateway setup ────────────────────────────────────────────────────────

announce "1 · Gateway Setup"

# Port-forward to gateway
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
    red "   ✗ could not port-forward to gateway"; exit 1
fi
green "   ✓ gateway port-forward on localhost:${gw_port}"

GW_URL="https://localhost:${gw_port}"

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

step "Register gateway" \
    openshell gateway add --name "${GATEWAY_NAME}" --local "$GW_URL"

# Re-extract certs after registration (gateway add may overwrite)
kubectl get secret openshell-server-tls -n "${TENANT}" \
    -o jsonpath='{.data.ca\.crt}' | base64 -d > "$cert_dir/ca.crt"
kubectl get secret openshell-server-tls -n "${TENANT}" \
    -o jsonpath='{.data.tls\.crt}' | base64 -d > "$cert_dir/tls.crt"
kubectl get secret openshell-server-tls -n "${TENANT}" \
    -o jsonpath='{.data.tls\.key}' | base64 -d > "$cert_dir/tls.key"

green "   ✓ gateway registered as '${GATEWAY_NAME}'"

step "Verify connectivity" \
    openshell sandbox list --gateway "$GATEWAY_NAME"

# ── 2: sandbox create ───────────────────────────────────────────────────────

announce "2 · Sandbox Create"

sep; bold "▶  Create sandbox"
printf '\033[38;5;214m   $ openshell sandbox create --gateway %s --from %s --no-tty -- echo ready\033[0m\n' "$GATEWAY_NAME" "$SANDBOX_FROM_IMAGE"
sleep "$PAUSE"
SANDBOX_OUTPUT=$(openshell sandbox create --gateway "$GATEWAY_NAME" \
    --from "$SANDBOX_FROM_IMAGE" --no-tty -- echo ready 2>&1 || echo "")
echo "$SANDBOX_OUTPUT"

SANDBOX_CLEAN=$(echo "$SANDBOX_OUTPUT" | sed 's/\x1b\[[0-9;]*m//g')
SANDBOX_NAME=$(echo "$SANDBOX_CLEAN" | grep -i 'Created sandbox:' | sed 's/.*Created sandbox:[[:space:]]*//' | tr -d '[:space:]' | head -1 || echo "")
if [ -z "$SANDBOX_NAME" ]; then
    SANDBOX_NAME=$(echo "$SANDBOX_CLEAN" | grep -oE '[a-z]+-[a-z]+' | head -1 || echo "")
fi

if [ -n "$SANDBOX_NAME" ]; then
    green "   ✓ sandbox created: ${SANDBOX_NAME}"

    # Start a watch in the right tmux pane
    if [[ -n "${TMUX_SESSION:-}" ]]; then
        tmux send-keys -t "${TMUX_SESSION}:0.1" \
            "watch -n2 'openshell sandbox get --gateway ${GATEWAY_NAME} ${SANDBOX_NAME} 2>/dev/null'" Enter
    fi
else
    red "   ✗ sandbox create failed"
    echo "$SANDBOX_OUTPUT"
    exit 1
fi

echo
bold "▶  Waiting for sandbox READY (up to 120s)..."
SANDBOX_READY=false
for _i in $(seq 1 60); do
    GET_OUT=$(openshell sandbox get --gateway "$GATEWAY_NAME" "$SANDBOX_NAME" 2>&1 || echo "")
    if echo "$GET_OUT" | grep -qi "READY"; then
        SANDBOX_READY=true
        break
    fi
    printf '.'
    sleep 2
done
echo

if [ "$SANDBOX_READY" = "true" ]; then
    green "   ✓ sandbox is READY"

    # Attach an exec shell in the right pane
    if [[ -n "${TMUX_SESSION:-}" ]]; then
        tmux send-keys -t "${TMUX_SESSION}:0.1" C-c
        sleep 0.5
        tmux send-keys -t "${TMUX_SESSION}:0.2" \
            "openshell sandbox exec --gateway ${GATEWAY_NAME} -n ${SANDBOX_NAME} -- sh" Enter
    fi
else
    yellow "   ✗ sandbox did not reach READY"
fi

step "Sandbox details" \
    openshell sandbox get --gateway "$GATEWAY_NAME" "$SANDBOX_NAME"

if [ "$SANDBOX_READY" = "true" ]; then
    step "Exec: echo hello" \
        openshell sandbox exec --gateway "$GATEWAY_NAME" -n "$SANDBOX_NAME" -- echo hello
fi

# ── 3: provider create ──────────────────────────────────────────────────────

announce "3 · Provider Create"

PROVIDER_NAME="demo-provider"

step "Create provider" \
    openshell provider create --gateway "$GATEWAY_NAME" \
        --name "$PROVIDER_NAME" --type generic \
        --credential DEMO_API_KEY=demo-secret-value
CREATED_PROVIDER="$PROVIDER_NAME"

step "List providers" \
    openshell provider list --gateway "$GATEWAY_NAME"

step "Get provider details" \
    openshell provider get --gateway "$GATEWAY_NAME" "$PROVIDER_NAME"

# ── 4: policy set + enforcement ─────────────────────────────────────────────

announce "4 · Policy Set + Enforcement"

POLICY_FIXTURE="$REPO_ROOT/tests/e2e/fixtures/openshell-cli-test/test-policy.yaml"

if [ "$SANDBOX_READY" = "true" ]; then
    step "Set policy from fixture" \
        openshell policy set --gateway "$GATEWAY_NAME" \
            --policy "$POLICY_FIXTURE" "$SANDBOX_NAME"

    step "Get policy" \
        openshell policy get --gateway "$GATEWAY_NAME" "$SANDBOX_NAME"

    sleep 3
    echo
    sep
    bold "▶  Policy enforcement: allowed endpoint"
    printf '\033[38;5;214m   $ openshell sandbox exec ... -- curl -sf https://update.code.visualstudio.com\033[0m\n'
    sleep "$PAUSE"
    openshell sandbox exec --gateway "$GATEWAY_NAME" -n "$SANDBOX_NAME" \
        -- curl -sf https://update.code.visualstudio.com 2>&1 | head -5 || true
    echo

    echo
    sep
    bold "▶  Policy enforcement: blocked endpoint"
    printf '\033[38;5;214m   $ openshell sandbox exec ... -- curl -sf http://example.com\033[0m\n'
    sleep "$PAUSE"
    BLOCKED=$(openshell sandbox exec --gateway "$GATEWAY_NAME" -n "$SANDBOX_NAME" \
        -- curl -sf http://example.com 2>&1 || echo "(no response)")
    echo "$BLOCKED" | head -5
    if echo "$BLOCKED" | grep -q "policy_denied"; then
        green "   ✓ policy denied the request"
    fi
    echo
else
    yellow "   sandbox not ready — skipping policy demo"
fi

# ── 5: settings ─────────────────────────────────────────────────────────────

announce "5 · Settings"

SETTING_KEY="providers_v2_enabled"
SETTING_VALUE="true"

step "Set global setting" \
    openshell settings set --gateway "$GATEWAY_NAME" --global --yes \
        --key "$SETTING_KEY" --value "$SETTING_VALUE"
CREATED_SETTING="$SETTING_KEY"

step "Get global settings" \
    openshell settings get --gateway "$GATEWAY_NAME" --global

# ── 6: cleanup ──────────────────────────────────────────────────────────────

announce "6 · Cleanup"

step "Delete provider" \
    openshell provider delete --gateway "$GATEWAY_NAME" "$PROVIDER_NAME"
CREATED_PROVIDER=""

step "Delete setting" \
    openshell settings delete --gateway "$GATEWAY_NAME" --global --yes --key "$SETTING_KEY"
CREATED_SETTING=""

if [ -n "$SANDBOX_NAME" ]; then
    step "Delete sandbox" \
        openshell sandbox delete --gateway "$GATEWAY_NAME" "$SANDBOX_NAME"
    SANDBOX_NAME=""
fi

step "Remove gateway registration" \
    openshell gateway remove "$GATEWAY_NAME"
GATEWAY_NAME=""

step "Confirm sandbox list is empty" \
    openshell sandbox list --gateway "$GATEWAY_NAME" 2>/dev/null || echo "(gateway removed)"

# ── done ─────────────────────────────────────────────────────────────────────

echo
sep
green "  Demo complete ✓"
sep
echo
