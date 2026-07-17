#!/bin/bash
set -euo pipefail

SESSION="demo"
CHAR_DELAY=0.03
PLATFORM=0
ENDUSER=1

BOLD='\033[1m'
DIM='\033[2m'
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
RESET='\033[0m'

type_text() {
    local pane=$1
    local text=$2

    for ((i = 0; i < ${#text}; i++)); do
        tmux send-keys -t "$SESSION:0.$pane" -l "${text:$i:1}"
        sleep "$CHAR_DELAY"
    done
}

type_and_run() {
    local pane=$1
    local comment=$2
    local cmd=$3

    if [[ -n "$comment" ]]; then
        type_text "$pane" "# $comment"
        tmux send-keys -t "$SESSION:0.$pane" Enter
        sleep 0.3
    fi

    type_text "$pane" "$cmd"
    sleep 0.4
    tmux send-keys -t "$SESSION:0.$pane" Enter
}

step() {
    local pane=$1
    local label=$2
    local description=$3
    local cmd=$4
    local wait_secs=${5:-2}

    if [[ "$pane" == "$PLATFORM" ]]; then
        echo -e "  ${CYAN}[platform]${RESET} ${BOLD}$description${RESET}"
    else
        echo -e "  ${GREEN}[user]${RESET} ${BOLD}$description${RESET}"
    fi
    echo -e "  ${DIM}❯ $cmd${RESET}"
    echo ""
    read -rsn1 -p "  Press any key to run..."
    echo ""

    type_and_run "$pane" "$description" "$cmd"
    sleep "$wait_secs"
}

# ── Create tmux session ─────────────────────────────────────────────
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -n main
tmux split-window -v -t "$SESSION:0"
tmux select-pane -t "$SESSION:0.0" -T 'Platform Perspective'
tmux select-pane -t "$SESSION:0.1" -T 'User Perspective'
tmux set-option -t "$SESSION" pane-border-status top
tmux set-option -t "$SESSION" pane-border-format ' #{pane_title} '
tmux set-option -t "$SESSION" pane-border-style 'fg=cyan'
tmux set-option -t "$SESSION" pane-active-border-style 'fg=cyan'

echo ""
echo -e "${BOLD}Gateway Route Exposure Demo${RESET}"
echo -e "${DIM}──────────────────────────────────────${RESET}"
echo ""
echo -e "  Attach in another terminal:  ${YELLOW}tmux attach -t $SESSION${RESET}"
echo ""
read -rsn1 -p "  Press any key to begin setup..."
echo ""

# ── Initial pane context ────────────────────────────────────────────
echo -e "  ${CYAN}[platform]${RESET} ${BOLD}Intro message${RESET}"
read -rsn1 -p "  Press any key to run..."
echo ""
type_text $PLATFORM "# This is the platform perspective: not seen by end-users"
tmux send-keys -t "$SESSION:0.$PLATFORM" Enter
sleep 0.5

echo -e "  ${GREEN}[user]${RESET} ${BOLD}Intro message${RESET}"
read -rsn1 -p "  Press any key to run..."
echo ""
type_text $ENDUSER "# This is the user perspective: how they interact with ACP and OpenShell"
tmux send-keys -t "$SESSION:0.$ENDUSER" Enter
sleep 0.5

# ── Setup (cleanup previous run) ────────────────────────────────────
echo -e "\n${DIM}  Running setup cleanup...${RESET}"
openshell gateway remove tenant-c-openshell-gateway 2>/dev/null || true
echo ""

# ── Demo steps ──────────────────────────────────────────────────────

step $PLATFORM 1 \
    "Infrastructure admins create namespace where gateway(s) live" \
    "oc new-project tenant-c"

step $PLATFORM 2 \
    "OpenShift cluster infrastructure has Gateway API configured" \
    "oc get gateway -n openshift-ingress"

step $ENDUSER 3 \
    "Create a project in ACP" \
    "acpctl create project --name tenant-c"

step $ENDUSER 4 \
    "Request a gateway in ACP" \
    "acpctl create gateway --project tenant-c"

step $PLATFORM 5 \
    "Gateway is provisioned by control plane in OpenShift" \
    "oc get pod -n tenant-c -w" 3

step $PLATFORM 6 \
    "Cert-manager configurations created by control plane for gateway TLS..." \
    "oc get certificate -n tenant-c"

step $PLATFORM 7 \
    "GRPCRoute is created by control plane, with BackendTLSPolicy" \
    "oc get grpcroute -n tenant-c"

step $PLATFORM 8 \
    "Route is using BackendTLSPolicy for E2E TLS" \
    "oc get backendtlspolicy -n tenant-c"

step $ENDUSER 9 \
    "Get gateway information" \
    "acpctl get gateway --project tenant-c"

step $ENDUSER 10 \
    "CLI helper provides command to run 'openshell gateway add'" \
    "acpctl gateway setup-cli --project tenant-c --print"

step $ENDUSER 11 \
    "Execute the given command... OIDC login occurs" \
    "openshell gateway add --name tenant-c-openshell-gateway --oidc-issuer https://keycloak-ambient-code.apps-crc.testing/" 5

step $ENDUSER 12 \
    "List sandboxes" \
    "openshell sandbox list" 3

step $ENDUSER 13 \
    "Create a sandbox" \
    "openshell sandbox create" 5

step $PLATFORM 14 \
    "Sandbox is running in namespace on OpenShift" \
    "oc get pod -n tenant-c -w" 3

echo ""
echo -e "${BOLD}Demo complete.${RESET}"
echo -e "${DIM}Run 'tmux kill-session -t $SESSION' to clean up.${RESET}"
