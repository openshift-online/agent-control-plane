#!/bin/bash
#
# setup-vertex-provider.sh — Create provider declarations for Vertex AI in a
# tenant namespace. This configures the gateway-mode provider flow where
# credentials come from K8s Secrets referenced by provider declarations, not
# from ACP credential bindings.
#
# USAGE:
#   ./scripts/setup-vertex-provider.sh [NAMESPACE] [VERTEX_CRED]
#
#   NAMESPACE       Target tenant namespace (default: tenant-a)
#   VERTEX_CRED     Path to GCP service account JSON key (default: ./vertex.json)
#
# WHAT THIS DOES:
#   1. Creates a K8s Secret (vertex-sa-key) with the SA JSON under a "token" key
#   2. Applies the example declarations from examples/agent-sandbox-config.yaml
#      (provider, policy, and agent ConfigMaps) into the target namespace
#   3. The control plane's ConfigMap syncer picks these up and syncs them to the API
#   4. Sessions created with --agent <name> will use providers from that agent's declaration
#
# PREREQUISITES:
#   - kind cluster running with OPENSHELL_USE_GATEWAY=true
#   - operator-config ConfigMap with ANTHROPIC_VERTEX_PROJECT_ID and CLOUD_ML_REGION
#   - kubectl context set to the cluster
#   - For openshell CLI verification: ./scripts/setup-gateway-cli.sh <namespace>
#
# VERIFICATION:
#   After running, wait ~30s for the ConfigMap syncer, then:
#     acpctl create session --project-id tenant-a --agent-id <agent-id> \
#       --name test --prompt "say hello"
#     openshell sandbox list --gateway tenant-a
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXAMPLE_FILE="$REPO_ROOT/examples/agent-sandbox-config.yaml"

NAMESPACE="${1:-tenant-a}"
VERTEX_CRED="${2:-./vertex.json}"

echo "=== Vertex Provider Setup ==="
echo "  Namespace:  $NAMESPACE"
echo "  Key file:   $VERTEX_CRED"
echo "  Example:    $EXAMPLE_FILE"
echo ""

if [ ! -f "$VERTEX_CRED" ]; then
    echo "Error: Vertex key file not found: $VERTEX_CRED"
    exit 1
fi

if [ ! -f "$EXAMPLE_FILE" ]; then
    echo "Error: Example declarations not found: $EXAMPLE_FILE"
    exit 1
fi

if ! kubectl get namespace "$NAMESPACE" &>/dev/null; then
    echo "Error: Namespace '$NAMESPACE' does not exist"
    exit 1
fi

# Step 1: Store the GCP service account JSON key in a K8s Secret under a "token"
# key. The provider declaration ConfigMap references this Secret by name
# (vertex-sa-key). At sandbox provisioning time the control plane reads the
# token value, uses it to create an OpenShell provider on the gateway, and
# configures automatic credential refresh: the gateway extracts client_email
# and private_key from the SA JSON to mint short-lived access tokens via
# JWT → OAuth2 token exchange (Google SA keys don't work as raw bearer tokens).
echo "Step 1/2: Creating vertex-sa-key Secret..."
kubectl create secret generic vertex-sa-key \
  --from-literal=token="$(cat "$VERTEX_CRED")" \
  -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
echo "  Done"
echo ""

# Step 2: Apply the provider, policy, and agent declaration ConfigMaps from
# the example file. The ConfigMap syncer watches for the ambient.ai/kind label
# and syncs these to the ACP API server. The agent declaration's "providers"
# list determines which providers are created on the gateway at sandbox time.
echo "Step 2/2: Applying example declarations..."
kubectl apply -n "$NAMESPACE" -f "$EXAMPLE_FILE"
echo "  Done"
echo ""

echo "=== Setup Complete ==="
echo ""
echo "The ConfigMap syncer will pick up these declarations within ~30s."
echo "Check control plane logs for 'provider created from configmap' / 'agent created from configmap'."
echo ""
echo "Next steps:"
echo "  # Set up openshell CLI gateway connectivity (if not already done):"
echo "  make kind-setup-openshell-cli NAMESPACES=$NAMESPACE"
echo ""
echo "  # Create a session using an agent with vertex (agent names come from the ConfigMap, for example 'default'):"
echo "  acpctl create session --project-id $NAMESPACE --agent-id <agent-id> \\"
echo "    --name test --prompt 'say hello'"
echo ""
echo "  # Verify sandbox was created:"
echo "  openshell sandbox list --gateway ${NAMESPACE}"
