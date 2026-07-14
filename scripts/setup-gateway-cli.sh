#!/bin/bash
#
# setup-gateway-cli.sh — Configure openshell CLI connectivity to tenant
# gateways. Extracts mTLS certs from each namespace, registers the gateway,
# and starts a port-forward on a random local port.
#
# Port-forwards run in the background with PIDs saved to $PF_DIR so they
# can be stopped later via `make kind-setup-openshell-cli-stop`.
#
# USAGE:
#   ./scripts/setup-gateway-cli.sh [NAMESPACE...]
#
#   Each namespace gets a gateway registered as "<namespace>" on a random port.
#   With no arguments, defaults to tenant-a.
#
# ENVIRONMENT:
#   PF_DIR  — directory for PID/log files (default: /tmp/ambient-code)
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
GW_PORTS=()

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

  # Start port-forward on :0 (kernel picks a free port), capture the assigned port
  kubectl port-forward -n "$NS" statefulset/openshell-gateway ":8080" \
    >"$LOG_FILE" 2>&1 &
  PF_PID=$!
  echo "$PF_PID" > "$PID_FILE"

  # Wait for kubectl to print the assigned port
  PORT=""
  for attempt in $(seq 1 30); do
    if [ -s "$LOG_FILE" ]; then
      PORT=$(grep -oE 'Forwarding from 127\.0\.0\.1:[0-9]+' "$LOG_FILE" | grep -oE '[0-9]+$' | head -1)
      if [ -n "$PORT" ]; then
        break
      fi
    fi
    sleep 0.2
  done

  if [ -z "$PORT" ]; then
    echo "  Error: Failed to determine port-forward port for '$NS'; skipping"
    kill "$PF_PID" 2>/dev/null || true
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

  # Extract mTLS certs BEFORE registering — the openshell CLI expects client
  # TLS material to exist at registration time.
  mkdir -p "$CERT_DIR"
  echo "  Extracting mTLS certs from openshell-server-tls..."
  kubectl get secret openshell-server-tls -n "$NS" \
    -o jsonpath='{.data.ca\.crt}' | base64 -d > "$CERT_DIR/ca.crt"
  kubectl get secret openshell-server-tls -n "$NS" \
    -o jsonpath='{.data.tls\.crt}' | base64 -d > "$CERT_DIR/tls.crt"
  kubectl get secret openshell-server-tls -n "$NS" \
    -o jsonpath='{.data.tls\.key}' | base64 -d > "$CERT_DIR/tls.key"

  echo "  Registering gateway $GW_NAME -> https://localhost:$PORT..."
  openshell gateway add --name "$GW_NAME" --local "https://localhost:$PORT"

  # Re-extract certs after registering — `gateway add --local` may generate
  # self-signed certs that don't match the gateway's PKI.  Overwriting them
  # with the real cluster certs fixes BadSignature / DecryptError TLS failures.
  kubectl get secret openshell-server-tls -n "$NS" \
    -o jsonpath='{.data.ca\.crt}' | base64 -d > "$CERT_DIR/ca.crt"
  kubectl get secret openshell-server-tls -n "$NS" \
    -o jsonpath='{.data.tls\.crt}' | base64 -d > "$CERT_DIR/tls.crt"
  kubectl get secret openshell-server-tls -n "$NS" \
    -o jsonpath='{.data.tls\.key}' | base64 -d > "$CERT_DIR/tls.key"

  # Verify mTLS connectivity
  if openshell provider list --gateway "$GW_NAME" &>/dev/null; then
    echo "  ✓ Gateway $GW_NAME connected successfully"
  else
    echo "  ✗ Gateway $GW_NAME connectivity check failed — check gateway pod logs:"
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
echo "Registered gateways:"
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
