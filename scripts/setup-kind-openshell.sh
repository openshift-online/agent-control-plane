#!/usr/bin/env bash
# Install OpenShell gateway prerequisites into a Kind cluster.
# Called by `make kind-up OPENSHELL_USE_GATEWAY=true`.
#
# Installs:
#   1. Tenant namespace (OPENSHELL_TENANT_NAMESPACE)
#   2. Agent Sandbox CRD + controller (v0.4.6 for v1alpha1 compat)
#   3. OpenShell gateway Helm chart into the tenant namespace
#   4. Patches the control plane deployment with OPENSHELL_USE_GATEWAY=true

set -euo pipefail

NAMESPACE="${NAMESPACE:-ambient-code}"
OPENSHELL_TENANT_NAMESPACE="${OPENSHELL_TENANT_NAMESPACE:-tenant}"
AGENT_SANDBOX_VERSION="${AGENT_SANDBOX_VERSION:-v0.4.6}"
OPENSHELL_GATEWAY_CHART="${OPENSHELL_GATEWAY_CHART:-oci://ghcr.io/nvidia/openshell/helm-chart}"

echo "Setting up OpenShell gateway prerequisites..."

# 1. Create tenant namespace
if kubectl get namespace "$OPENSHELL_TENANT_NAMESPACE" >/dev/null 2>&1; then
  echo "  Namespace '$OPENSHELL_TENANT_NAMESPACE' already exists"
else
  kubectl create namespace "$OPENSHELL_TENANT_NAMESPACE"
  echo "  Created namespace '$OPENSHELL_TENANT_NAMESPACE'"
fi

# 2. Install Agent Sandbox CRD + controller
echo "  Installing agent-sandbox CRD ${AGENT_SANDBOX_VERSION}..."
kubectl apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/manifest.yaml"
echo "  Waiting for agent-sandbox controller..."
kubectl wait --for=condition=Available deployment/agent-sandbox-controller-manager \
  -n agent-sandbox-system --timeout=120s >/dev/null 2>&1

# 3. Install OpenShell gateway via Helm
if ! command -v helm >/dev/null 2>&1; then
  echo "Error: helm is required but not found in PATH"
  exit 1
fi

GATEWAY_DNS="${OPENSHELL_GATEWAY_CHART##*/}-gateway.${OPENSHELL_TENANT_NAMESPACE}.svc.cluster.local"
if helm status openshell-gateway -n "$OPENSHELL_TENANT_NAMESPACE" >/dev/null 2>&1; then
  echo "  Helm release 'openshell-gateway' already installed in '$OPENSHELL_TENANT_NAMESPACE'"
else
  helm install openshell-gateway "$OPENSHELL_GATEWAY_CHART" \
    --namespace "$OPENSHELL_TENANT_NAMESPACE" \
    --set "pkiInitJob.serverDnsNames={openshell-gateway.${OPENSHELL_TENANT_NAMESPACE}.svc.cluster.local}" \
    --wait --timeout 120s
  echo "  Installed OpenShell gateway"
fi

# 4. Patch control plane with gateway env vars
kubectl set env deployment/ambient-control-plane -n "$NAMESPACE" \
  OPENSHELL_USE_GATEWAY=true >/dev/null
echo "  Patched ambient-control-plane with OPENSHELL_USE_GATEWAY=true"

echo "OpenShell gateway setup complete."
