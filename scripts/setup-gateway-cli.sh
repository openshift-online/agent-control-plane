#!/bin/bash
#
# setup-gateway-cli.sh — Configure openshell CLI connectivity to tenant
# gateways. Extracts mTLS certs from each namespace, registers the gateway,
# and starts a port-forward on a fixed local port (GATEWAY_BASE_PORT + index).
#
# Port-forwards run in the background with PIDs saved to $PF_DIR so they
# can be stopped later via `make kind-setup-openshell-cli-stop`.
#
# USAGE:
#   ./scripts/setup-gateway-cli.sh [NAMESPACE...]
#
#   Each namespace gets a gateway on a fixed port (GATEWAY_BASE_PORT + index).
#   With no arguments, defaults to tenant-a.
#
# ENVIRONMENT:
#   PF_DIR             — directory for PID/log files (default: /tmp/ambient-code)
#   GATEWAY_BASE_PORT  — first fixed local port for gateway port-forwards (default: 15080);
#                        each namespace gets base+index (e.g. 15080, 15081, 15082)
#
# EXAMPLES:
#   ./scripts/setup-gateway-cli.sh                    # tenant-a
#   ./scripts/setup-gateway-cli.sh tenant-a tenant-b  # both tenants
#
# AFTER RUNNING:
#   openshell sandbox list --gateway tenant-a
#   openshell sandbox list --gateway tenant-b
#

set -e

NAMESPACES=("${@:-tenant-a}")
CERT_BASE="$HOME/.config/openshell/gateways"
PF_DIR="${PF_DIR:-/tmp/ambient-code}"
GATEWAY_BASE_PORT="${GATEWAY_BASE_PORT:-15080}"
GW_PORTS=()
NS_INDEX=0

mkdir -p "$PF_DIR"

for NS in "${NAMESPACES[@]}"; do
  GW_NAME="$NS"

  echo "=== Setting up gateway: $GW_NAME (namespace: $NS) ==="

  if ! kubectl get namespace "$NS" &>/dev/null; then
    echo "  Error: Namespace '$NS' does not exist; skipping"
    echo ""
    continue
  fi

  if ! kubectl get secret openshell-server-tls -n "$NS" &>/dev/null; then
    echo "  Error: openshell-server-tls secret not found in '$NS'; skipping"
    echo ""
    continue
  fi

  CERT_DIR="$CERT_BASE/$GW_NAME/mtls"
  PID_FILE="$PF_DIR/kind-pf-openshell-${NS}.pid"
  LOG_FILE="$PF_DIR/kind-pf-openshell-${NS}.log"

  # Kill any existing port-forward for this namespace
  if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if ps -p "$OLD_PID" >/dev/null 2>&1; then
      kill "$OLD_PID" 2>/dev/null || true
      echo "  Stopped previous port-forward (PID $OLD_PID)"
    fi
    rm -f "$PID_FILE" "$LOG_FILE"
  fi

  # Assign a fixed local port: base + namespace index
  PORT=$(( GATEWAY_BASE_PORT + NS_INDEX ))
  NS_INDEX=$(( NS_INDEX + 1 ))

  kubectl port-forward -n "$NS" statefulset/openshell-gateway "$PORT:8080" \
    >"$LOG_FILE" 2>&1 &
  PF_PID=$!
  echo "$PF_PID" > "$PID_FILE"

  # Wait for port-forward to be ready
  for attempt in $(seq 1 30); do
    if [ -s "$LOG_FILE" ] && grep -q 'Forwarding from' "$LOG_FILE"; then
      break
    fi
    sleep 0.2
  done

  if ! ps -p "$PF_PID" >/dev/null 2>&1; then
    echo "  Error: Port-forward failed for '$NS' on port $PORT (port in use?); skipping"
    rm -f "$PID_FILE" "$LOG_FILE"
    echo ""
    continue
  fi

  GW_PORTS+=("$PORT")

  # Remove existing registration first (may also delete the cert dir).
  if openshell gateway list 2>/dev/null | grep -q "$GW_NAME"; then
    echo "  Removing existing gateway registration..."
    openshell gateway remove "$GW_NAME" 2>/dev/null || true
  fi

  # Detect OIDC authentication from the gateway ConfigMap
  OIDC_ISSUER=""
  OIDC_AUDIENCE=""
  GW_TOML=$(kubectl get configmap openshell-gateway-config -n "$NS" \
    -o jsonpath='{.data.gateway\.toml}' 2>/dev/null || true)
  if echo "$GW_TOML" | grep -q '\[openshell\.gateway\.oidc\]'; then
    OIDC_ISSUER=$(echo "$GW_TOML" | sed -n '/\[openshell\.gateway\.oidc\]/,/^\[/{ s/.*issuer *= *"\(.*\)"/\1/p; }')
    OIDC_AUDIENCE=$(echo "$GW_TOML" | sed -n '/\[openshell\.gateway\.oidc\]/,/^\[/{ s/.*audience *= *"\(.*\)"/\1/p; }')
    OIDC_AUDIENCE="${OIDC_AUDIENCE:-openshell-cli}"

    # The Keycloak service port (11880) matches the local port-forward, so
    # developers can reach the same issuer URL from the host via /etc/hosts:
    #   127.0.0.1 keycloak-service.ambient-code.svc.cluster.local
  fi

  if [ -n "$OIDC_ISSUER" ]; then
    # OIDC-authenticated gateway — extract the CA cert so the CLI can verify
    # TLS, then print the registration command for the user to run manually.
    # Running `gateway add` here triggers a browser-based OIDC login flow,
    # which is not suitable for automated setup.
    mkdir -p "$CERT_DIR"
    echo "  Extracting CA cert from openshell-server-tls..."
    kubectl get secret openshell-server-tls -n "$NS" \
      -o jsonpath='{.data.ca\.crt}' | base64 -d > "$CERT_DIR/ca.crt"

    echo "  OIDC gateway $GW_NAME -> https://localhost:$PORT"
    echo "    issuer:   $OIDC_ISSUER"
    echo "    audience: $OIDC_AUDIENCE"
    echo "    CA cert:  $CERT_DIR/ca.crt"
    echo ""
    echo "  To register this gateway, run:"
    echo "    openshell gateway add --name $GW_NAME \\"
    echo "      --oidc-issuer $OIDC_ISSUER \\"
    echo "      --oidc-client-id $OIDC_AUDIENCE \\"
    echo "      --oidc-audience $OIDC_AUDIENCE \\"
    echo "      --gateway-insecure \\"
    echo "      https://localhost:$PORT"
  else
    # mTLS-authenticated gateway — extract certs and print the registration
    # command for the user to run manually.
    mkdir -p "$CERT_DIR"
    echo "  Extracting mTLS certs from openshell-server-tls..."
    kubectl get secret openshell-server-tls -n "$NS" \
      -o jsonpath='{.data.ca\.crt}' | base64 -d > "$CERT_DIR/ca.crt"
    kubectl get secret openshell-server-tls -n "$NS" \
      -o jsonpath='{.data.tls\.crt}' | base64 -d > "$CERT_DIR/tls.crt"
    kubectl get secret openshell-server-tls -n "$NS" \
      -o jsonpath='{.data.tls\.key}' | base64 -d > "$CERT_DIR/tls.key"

    echo "  mTLS gateway $GW_NAME -> https://localhost:$PORT"
    echo "  Certs extracted to: $CERT_DIR"
    echo ""
    echo "  To register this gateway, run:"
    echo "    openshell gateway add --name $GW_NAME --local https://localhost:$PORT"
  fi

  # Verify the gateway port-forward is reachable (avoid openshell commands that
  # trigger OIDC browser login during automated setup).
  if curl -sk --max-time 3 "https://localhost:$PORT" >/dev/null 2>&1; then
    echo "  ✓ Gateway $GW_NAME is reachable on port $PORT"
  else
    echo "  ✗ Gateway $GW_NAME not reachable on port $PORT — check gateway pod logs:"
    echo "    kubectl logs -l app.kubernetes.io/instance=openshell-gateway -n $NS"
  fi

  echo ""
done

# Configure acpctl to point at the API server port-forward
API_NS="${ACP_NAMESPACE:-ambient-code}"
API_PORT=$(ps aux | grep -oE "port-forward.*svc/ambient-api-server [0-9]+:8000" | grep -oE ' [0-9]+:' | tr -d ' :' | head -1)
if [ -n "$API_PORT" ]; then
  TOKEN=$(kubectl get secret test-user-token -n "$API_NS" -o jsonpath='{.data.token}' 2>/dev/null | base64 -d 2>/dev/null)
  if [ -n "$TOKEN" ]; then
    acpctl login --url "http://localhost:$API_PORT" --token "$TOKEN" 2>/dev/null && \
      echo "acpctl configured: http://localhost:$API_PORT" || \
      echo "Warning: acpctl login failed — run 'make build-cli' or 'make kind-login'"
  else
    echo "Warning: test-user-token not found in $API_NS — acpctl not configured"
  fi
else
  echo "Warning: no API server port-forward detected — run 'make kind-login' first"
fi
echo ""

echo "=== Gateway CLI Setup Complete ==="
echo ""
echo "Gateways (port-forwards active, register manually with commands above):"
for i in "${!NAMESPACES[@]}"; do
  if [ "$i" -lt "${#GW_PORTS[@]}" ]; then
    echo "  ${NAMESPACES[$i]} -> localhost:${GW_PORTS[$i]}"
  fi
done
echo ""
echo "Usage:"
for NS in "${NAMESPACES[@]}"; do
  echo "  openshell sandbox list --gateway ${NS}"
done
echo ""
echo "Port-forwards are running in the background."
echo "Stop with: make kind-setup-openshell-cli-stop"
