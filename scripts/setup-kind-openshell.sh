#!/usr/bin/env bash
# Install OpenShell gateway prerequisites into a Kind cluster (dual-tenant mode).
# Called by `make kind-up OPENSHELL_USE_GATEWAY=true`.
#
# Provisions for each tenant in OPENSHELL_TENANTS (default: tenant-a tenant-b):
#   1. Agent Sandbox CRD + controller (once, cluster-scoped)
#   2. Tenant namespaces
#   3. (reserved — ACP projects are created automatically by the control plane)
#   4. Patches the control plane deployment with OPENSHELL_USE_GATEWAY=true
#      and Vertex AI env vars (ANTHROPIC_VERTEX_PROJECT_ID, CLOUD_ML_REGION) if set
#
# Vertex AI credentials are configured separately by `make kind-setup-vertex`.
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
COREFILE=$(kubectl get configmap coredns -n kube-system -o jsonpath='{.data.Corefile}')
if echo "$COREFILE" | grep -q "template IN AAAA"; then
  echo "  CoreDNS already patched — skipping restart"
else
  kubectl get configmap coredns -n kube-system -o json \
    | python3 -c '
import json, sys, re
cm = json.load(sys.stdin)
corefile = cm["data"]["Corefile"]
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
fi

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

# 3. ACP projects are created automatically by the control plane when it
#    reads platform-config (after step 4 patches it with OPENSHELL_USE_GATEWAY=true).

# 4. Patch control plane with gateway flag and vertex env vars (idempotent)
#    TLS is left at its default (true) — certgen-job creates openshell-client-tls
#    and openshell-server-tls secrets so mTLS works out of the box in Kind.
CP_ENV_ARGS="OPENSHELL_USE_GATEWAY=true"
CP_NEEDS_PATCH=false

CURRENT_GW=$(kubectl get deployment ambient-control-plane -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="OPENSHELL_USE_GATEWAY")].value}' 2>/dev/null || echo "")
if [ "$CURRENT_GW" != "true" ]; then
  CP_NEEDS_PATCH=true
fi

if [ -n "${ANTHROPIC_VERTEX_PROJECT_ID:-}" ]; then
  CURRENT_PROJECT=$(kubectl get deployment ambient-control-plane -n "$NAMESPACE" \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="ANTHROPIC_VERTEX_PROJECT_ID")].value}' 2>/dev/null || echo "")
  if [ "$CURRENT_PROJECT" != "$ANTHROPIC_VERTEX_PROJECT_ID" ]; then
    CP_NEEDS_PATCH=true
  fi
  CP_ENV_ARGS="$CP_ENV_ARGS ANTHROPIC_VERTEX_PROJECT_ID=${ANTHROPIC_VERTEX_PROJECT_ID}"
fi

if [ -n "${CLOUD_ML_REGION:-}" ]; then
  CURRENT_REGION=$(kubectl get deployment ambient-control-plane -n "$NAMESPACE" \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="CLOUD_ML_REGION")].value}' 2>/dev/null || echo "")
  if [ "$CURRENT_REGION" != "$CLOUD_ML_REGION" ]; then
    CP_NEEDS_PATCH=true
  fi
  CP_ENV_ARGS="$CP_ENV_ARGS CLOUD_ML_REGION=${CLOUD_ML_REGION}"
fi

if [ "$CP_NEEDS_PATCH" = "true" ]; then
  # shellcheck disable=SC2086
  kubectl set env deployment/ambient-control-plane -n "$NAMESPACE" $CP_ENV_ARGS >/dev/null
  kubectl rollout status deployment/ambient-control-plane -n "$NAMESPACE" --timeout=60s >/dev/null 2>&1
  echo "  Patched ambient-control-plane with: $CP_ENV_ARGS"
else
  echo "  ambient-control-plane env already up to date — skipping"
fi
echo "  Note: ambient-ui gateway mode is baked in at build time via --build-arg OPENSHELL_USE_GATEWAY=true"

# Vertex credentials and tenant overlays (examples/overlays/<tenant>/) are
# applied by `make kind-up` after this script finishes — see the
# setup-vertex-provider.sh calls in the Makefile.

echo "OpenShell gateway setup complete (${TENANTS[*]})."
