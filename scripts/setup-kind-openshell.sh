#!/usr/bin/env bash
# Install OpenShell gateway prerequisites into a Kind cluster (dual-tenant mode).
# Called by `make kind-up OPENSHELL_USE_GATEWAY=true`.
#
# Provisions for each tenant in OPENSHELL_TENANTS (default: tenant-a tenant-b):
#   1. Agent Sandbox CRD + controller (once, cluster-scoped)
#   2. Tenant namespaces
#   3. ACP project via the API
#   4. Patches the control plane deployment with OPENSHELL_USE_GATEWAY=true
#
# The control plane reconciler handles gateway resource deployment via
# the platform-config ConfigMap — no Helm chart needed.

set -euo pipefail

NAMESPACE="${NAMESPACE:-ambient-code}"
AGENT_SANDBOX_VERSION="${AGENT_SANDBOX_VERSION:-v0.4.6}"
# Space-separated list of tenant namespaces to provision
IFS=' ' read -ra TENANTS <<< "${OPENSHELL_TENANTS:-tenant-a tenant-b}"

echo "Setting up OpenShell gateway prerequisites (tenants: ${TENANTS[*]})..."

# 0. Suppress IPv6 (AAAA) DNS for all external domains in CoreDNS.
#    Kind on Podman has no IPv6 connectivity. The OpenShell supervisor's DNS
#    resolver tries IPv6 first and fails without falling back to IPv4, causing
#    503 on inference calls (Vertex AI) and DENIED on api.anthropic.com, github.com, etc.
echo "  Patching CoreDNS to suppress AAAA records (IPv4-only)..."
kubectl get configmap coredns -n kube-system -o json \
  | python3 -c '
import json, sys, re
cm = json.load(sys.stdin)
corefile = cm["data"]["Corefile"]
if "template IN AAAA" not in corefile:
    corefile = re.sub(
        r"([ \t]+forward \. /etc/resolv\.conf)",
        "        template IN AAAA {\n"
        "            rcode NOERROR\n"
        "        }\n"
        r"\1",
        corefile,
    )
    cm["data"]["Corefile"] = corefile
json.dump(cm, sys.stdout)
' | kubectl apply -f - >/dev/null 2>&1
kubectl rollout restart deployment coredns -n kube-system >/dev/null 2>&1
kubectl rollout status deployment coredns -n kube-system --timeout=60s >/dev/null 2>&1
echo "  CoreDNS patched (IPv4-only for all external domains)"

# 1. Install Agent Sandbox CRD + controller (once, cluster-scoped)
echo "  Installing agent-sandbox CRD ${AGENT_SANDBOX_VERSION}..."
kubectl apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/manifest.yaml"
echo "  Waiting for agent-sandbox controller..."
kubectl wait --for=condition=Available deployment/agent-sandbox-controller \
  -n agent-sandbox-system --timeout=120s >/dev/null 2>&1

# 2. Create tenant namespaces (gateway resources deployed by control plane reconciler)
for TENANT in "${TENANTS[@]}"; do
  echo "  Provisioning tenant '$TENANT'..."

  if kubectl get namespace "$TENANT" >/dev/null 2>&1; then
    echo "    Namespace '$TENANT' already exists"
  else
    kubectl create namespace "$TENANT"
    echo "    Created namespace '$TENANT'"
  fi
done

# 3. Create ACP projects for each tenant via the API
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

# 4. Patch control plane with the gateway flag
kubectl set env deployment/ambient-control-plane -n "$NAMESPACE" \
  OPENSHELL_USE_GATEWAY=true >/dev/null
echo "  Patched ambient-control-plane with OPENSHELL_USE_GATEWAY=true"
echo "  Note: ambient-ui gateway mode is baked in at build time via --build-arg OPENSHELL_USE_GATEWAY=true"

echo "OpenShell gateway setup complete (${TENANTS[*]})."
