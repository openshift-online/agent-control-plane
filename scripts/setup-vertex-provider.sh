#!/bin/bash
#
# setup-vertex-provider.sh — Apply tenant fleet definitions with Vertex AI
# credentials via acpctl apply -k.
#
# USAGE:
#   ./scripts/setup-vertex-provider.sh [NAMESPACE] [VERTEX_CRED]
#
#   NAMESPACE       Target tenant namespace (default: tenant-a)
#   VERTEX_CRED     Path to GCP service account JSON key (default: ./vertex.json)
#
# WHAT THIS DOES:
#   1. Reads the GCP SA JSON key into VERTEX_SA_KEY env var
#   2. Runs acpctl apply -k on the tenant overlay (examples/overlays/<namespace>/)
#   3. The Credential kind in the overlay uses $VERTEX_SA_KEY for token expansion
#
# PREREQUISITES:
#   - kind cluster running with OPENSHELL_USE_GATEWAY=true
#   - acpctl built and logged in (make build-cli && make kind-acpctl-login)
#   - kubectl context set to the cluster
#
# VERIFICATION:
#   acpctl get agents --project-id <namespace>
#   acpctl get credentials
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OVERLAY_DIR="$REPO_ROOT/examples/overlays"

NAMESPACE="${1:-tenant-a}"
VERTEX_CRED="${2:-./vertex.json}"

echo "▶ Setting up vertex provider in $NAMESPACE..."
echo "=== Vertex Provider Setup ==="
echo "  Namespace:  $NAMESPACE"
echo "  Key file:   $VERTEX_CRED"
echo "  Overlay:    $OVERLAY_DIR/$NAMESPACE"
echo ""

if [ ! -f "$VERTEX_CRED" ]; then
    echo "Error: Vertex key file not found: $VERTEX_CRED"
    exit 1
fi

if [ ! -d "$OVERLAY_DIR/$NAMESPACE" ]; then
    echo "Error: Overlay not found: $OVERLAY_DIR/$NAMESPACE"
    exit 1
fi

ACPCTL=""
if command -v acpctl >/dev/null 2>&1; then
    ACPCTL=acpctl
elif [ -x "$REPO_ROOT/components/ambient-cli/acpctl" ]; then
    ACPCTL="$REPO_ROOT/components/ambient-cli/acpctl"
elif [ -x "$REPO_ROOT/acpctl" ]; then
    ACPCTL="$REPO_ROOT/acpctl"
fi

if [ -z "$ACPCTL" ]; then
    echo "Error: acpctl not found — run 'make build-cli' first"
    exit 1
fi

export VERTEX_SA_KEY
VERTEX_SA_KEY="$(cat "$VERTEX_CRED")"

echo "Creating K8s Secret vertex-sa-key in $NAMESPACE..."
kubectl create secret generic vertex-sa-key \
    --namespace="$NAMESPACE" \
    "--from-literal=token=${VERTEX_SA_KEY}" \
    --dry-run=client -o yaml | kubectl apply -f - 2>/dev/null
echo "  Done"

echo "Applying tenant fleet definitions..."
$ACPCTL apply -k "$OVERLAY_DIR/$NAMESPACE/" --project "$NAMESPACE"
echo "  Done"
echo ""

echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  acpctl get agents --project-id $NAMESPACE"
echo "  acpctl get credentials"
echo ""
echo "  # Create a session:"
echo "  acpctl start <agent-name> --project-id $NAMESPACE --prompt 'say hello'"
