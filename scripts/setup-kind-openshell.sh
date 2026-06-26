#!/usr/bin/env bash
# Install OpenShell gateway prerequisites into a Kind cluster (dual-tenant mode).
# Called by `make kind-up OPENSHELL_USE_GATEWAY=true`.
#
# Provisions for each tenant in OPENSHELL_TENANTS (default: tenant-a tenant-b):
#   1. Agent Sandbox CRD + controller (once, cluster-scoped)
#   2. Tenant namespace + OpenShell gateway Helm chart
#   3. ACP project via the API
#   4. Patches the control plane deployment with OPENSHELL_USE_GATEWAY=true

set -euo pipefail

NAMESPACE="${NAMESPACE:-ambient-code}"
AGENT_SANDBOX_VERSION="${AGENT_SANDBOX_VERSION:-v0.4.6}"
OPENSHELL_GATEWAY_CHART="${OPENSHELL_GATEWAY_CHART:-oci://ghcr.io/nvidia/openshell/helm-chart}"
# Space-separated list of tenant namespaces to provision
IFS=' ' read -ra TENANTS <<< "${OPENSHELL_TENANTS:-tenant-a tenant-b}"

echo "Setting up OpenShell gateway prerequisites (tenants: ${TENANTS[*]})..."

# 1. Install Agent Sandbox CRD + controller (once, cluster-scoped)
echo "  Installing agent-sandbox CRD ${AGENT_SANDBOX_VERSION}..."
kubectl apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/manifest.yaml"
echo "  Waiting for agent-sandbox controller..."
kubectl wait --for=condition=Available deployment/agent-sandbox-controller \
  -n agent-sandbox-system --timeout=120s >/dev/null 2>&1

# 2. Verify helm is available
if ! command -v helm >/dev/null 2>&1; then
  echo "Error: helm is required but not found in PATH"
  exit 1
fi

# 3. Provision namespace + gateway for each tenant
for TENANT in "${TENANTS[@]}"; do
  echo "  Provisioning tenant '$TENANT'..."

  if kubectl get namespace "$TENANT" >/dev/null 2>&1; then
    echo "    Namespace '$TENANT' already exists"
  else
    kubectl create namespace "$TENANT"
    echo "    Created namespace '$TENANT'"
  fi

  if helm status openshell-gateway -n "$TENANT" >/dev/null 2>&1; then
    echo "    OpenShell gateway already installed in '$TENANT'"
  else
    # Re-annotate any cluster-scoped RBAC resources owned by a prior release in a
    # different namespace so Helm can take ownership for this tenant's install.
    # ClusterRoles/ClusterRoleBindings are cluster-scoped and conflict across installs
    # when multiple gateways share the same Helm release name.
    for RTYPE in clusterrole clusterrolebinding; do
      for RNAME in $(kubectl get "$RTYPE" \
          -l "app.kubernetes.io/instance=openshell-gateway" \
          -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
        OWNER_NS=$(kubectl get "$RTYPE" "$RNAME" \
          -o jsonpath='{.metadata.annotations.meta\.helm\.sh/release-namespace}' \
          2>/dev/null || echo "")
        if [ -n "$OWNER_NS" ] && [ "$OWNER_NS" != "$TENANT" ]; then
          echo "    Adopting $RTYPE/$RNAME (was owned by $OWNER_NS)..."
          kubectl annotate "$RTYPE" "$RNAME" \
            "meta.helm.sh/release-namespace=${TENANT}" --overwrite >/dev/null 2>&1 || true
        fi
      done
    done

    helm install openshell-gateway "$OPENSHELL_GATEWAY_CHART" \
      --namespace "$TENANT" \
      --set "pkiInitJob.serverDnsNames={openshell-gateway.${TENANT}.svc.cluster.local}" \
      --wait --timeout 120s
    echo "    Installed OpenShell gateway in '$TENANT'"
  fi
done

# 4. Create ACP projects for each tenant via the API
echo "  Creating ACP projects..."
TOKEN=$(kubectl get secret test-user-token -n "$NAMESPACE" \
  -o jsonpath='{.data.token}' 2>/dev/null | base64 -d 2>/dev/null || echo "")

if [ -z "$TOKEN" ]; then
  echo "  Warning: test-user-token not found; skipping ACP project creation"
else
  # Temporary port-forward to the API server
  PF_PORT=18765
  kubectl port-forward -n "$NAMESPACE" svc/ambient-api-server "${PF_PORT}:8000" \
    >/dev/null 2>&1 &
  PF_PID=$!
  # shellcheck disable=SC2064
  trap "kill ${PF_PID} 2>/dev/null || true" EXIT

  # Wait for port-forward to be ready (up to 15 s)
  API_READY=false
  for i in $(seq 1 15); do
    if curl -sf -H "Authorization: Bearer ${TOKEN}" \
        "http://localhost:${PF_PORT}/api/ambient/v1/projects" >/dev/null 2>&1; then
      API_READY=true
      break
    fi
    sleep 1
  done

  if [ "$API_READY" = "false" ]; then
    echo "  Warning: API server unreachable on port ${PF_PORT}; skipping ACP project creation"
  else
    for TENANT in "${TENANTS[@]}"; do
      # Check whether a project with this name already exists
      EXISTING=$(curl -sf \
        -H "Authorization: Bearer ${TOKEN}" \
        "http://localhost:${PF_PORT}/api/ambient/v1/projects?search=${TENANT}" 2>/dev/null || echo "")
      MATCH_COUNT=$(echo "$EXISTING" \
        | jq -r '[.items[] | select(.name == "'"${TENANT}"'")] | length' 2>/dev/null)
      MATCH_COUNT="${MATCH_COUNT:-0}"

      if [ "${MATCH_COUNT}" -gt 0 ]; then
        echo "    ACP project '${TENANT}' already exists"
      else
        curl -sf -X POST \
          -H "Authorization: Bearer ${TOKEN}" \
          -H "Content-Type: application/json" \
          -d "{\"name\": \"${TENANT}\"}" \
          "http://localhost:${PF_PORT}/api/ambient/v1/projects" >/dev/null
        echo "    Created ACP project '${TENANT}'"
      fi
    done
  fi

  kill "${PF_PID}" 2>/dev/null || true
fi

# 5. Patch control plane with the gateway flag
kubectl set env deployment/ambient-control-plane -n "$NAMESPACE" \
  OPENSHELL_USE_GATEWAY=true >/dev/null
echo "  Patched ambient-control-plane with OPENSHELL_USE_GATEWAY=true"

echo "OpenShell gateway setup complete (${TENANTS[*]})."
