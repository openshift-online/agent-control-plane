---
name: openshell-gateway
description: >
  Sets up and tests OpenShell gateway mode in a local kind cluster for the Ambient
  Code Platform. Use when working on gateway-provisioned session sandboxes, testing
  dual-tenant provisioning, or developing the OpenShell gRPC integration. Triggers
  on: "openshell gateway", "gateway mode", "OPENSHELL_USE_GATEWAY", "sandbox
  provisioning", "dual-tenant", "tenant-a", "tenant-b", "agent-sandbox",
  "test-openshell-dual-tenant".
---

# OpenShell Gateway Testing Skill

> **Multi-cluster support:** Each worktree/branch gets its own Kind cluster via `CLUSTER_SLUG`. Run `make kind-status` to see port assignments. Never hardcode cluster names or ports.

The control plane supports two sandbox provisioning backends:

- **Pod mode** (`OPENSHELL_USE_GATEWAY=false`, default): ACP creates a K8s namespace and spawns the runner as a Pod/Job directly.
- **Gateway mode** (`OPENSHELL_USE_GATEWAY=true`): ACP delegates sandbox lifecycle to an OpenShell gateway via gRPC. The gateway runs in a per-tenant namespace and manages `AgentSandbox` CRs.

## Prerequisites

- `helm` installed (for the OpenShell gateway Helm chart)
- Access to `oci://ghcr.io/nvidia/openshell/helm-chart`
- A working kind environment (see the `dev-cluster` skill for base setup)

```bash
helm version --short
```

## Bringing Up Kind with Gateway Mode

```bash
# Full cluster setup with dual-tenant OpenShell gateway (default: tenant-a, tenant-b)
make kind-up OPENSHELL_USE_GATEWAY=true

# Custom tenants
make kind-up OPENSHELL_USE_GATEWAY=true OPENSHELL_TENANTS="ns1 ns2 ns3"

# With local control plane image (for in-progress CP changes)
make kind-up LOCAL_IMAGES=true OPENSHELL_USE_GATEWAY=true
```

`make kind-up` calls `scripts/setup-kind-openshell.sh` when `OPENSHELL_USE_GATEWAY=true`, which:
1. Installs the `agent-sandbox` CRD and controller (cluster-scoped, once)
2. Creates each tenant namespace
3. Installs the OpenShell gateway Helm chart per tenant
4. Creates ACP projects for each tenant via the API (uses `test-user-token`)
5. Patches `ambient-control-plane` with `OPENSHELL_USE_GATEWAY=true`

**If setup fails partway through**, fix the root cause and re-run with `make kind-down && make kind-up OPENSHELL_USE_GATEWAY=true`. Do not replay individual steps manually.

## Verifying the Gateway Setup

```bash
# Gateway StatefulSets and pods in each tenant namespace
kubectl get statefulset,pods -n tenant-a
kubectl get statefulset,pods -n tenant-b

# agent-sandbox controller
kubectl get deployment agent-sandbox-controller -n agent-sandbox-system

# AgentSandbox CRD registered
kubectl get crd sandboxes.agents.x-k8s.io

# Confirm control plane has the gateway flag
kubectl get deployment ambient-control-plane -n ambient-code \
  -o jsonpath='{.spec.template.spec.containers[0].env}' \
  | jq '.[] | select(.name=="OPENSHELL_USE_GATEWAY")'

# Control plane logs — look for gateway client init
kubectl logs -l app=ambient-control-plane -n ambient-code --tail=50 \
  | grep -i "gateway\|openshell\|tenant"
```

## Running the Dual-Tenant E2E Test

```bash
# Requires: kind-up with OPENSHELL_USE_GATEWAY=true
make test-openshell-dual-tenant

# Or run directly
API_URL="http://localhost:$KIND_FWD_API_SERVER_PORT" ./tests/openshell-dual-tenant.sh
```

The test covers five sections:
1. **Gateway deployments** — `openshell-gateway` StatefulSet ready in each tenant namespace
2. **Sandbox CRD/controller** — `agent-sandbox` controller healthy, CRD exists
3. **ACP projects** — `tenant-a` and `tenant-b` projects exist in the API
4. **Concurrent session creation** — sessions created in both tenant projects simultaneously
5. **Concurrent sandbox provisioning** — `AgentSandbox` CRs appear after session start

## Reloading After Control Plane Changes

```bash
# Hot-deploy the control plane (env vars persist — OPENSHELL_USE_GATEWAY survives)
make kind-reload-ambient-control-plane

# Verify flag is still set
kubectl rollout status deployment/ambient-control-plane -n ambient-code
kubectl get deployment ambient-control-plane -n ambient-code \
  -o jsonpath='{.spec.template.spec.containers[0].env}' | jq '.[] | select(.name=="OPENSHELL_USE_GATEWAY")'
```

`kind-reload-*` generates a unique image tag (`git-short-epoch`) and uses `kubectl set image` — it does **not** reset env vars set by the setup script.

## Troubleshooting

### Gateway pod not starting

```bash
kubectl describe statefulset openshell-gateway -n tenant-a
kubectl logs -l app.kubernetes.io/name=openshell-gateway -n tenant-a --tail=50
# Check PKI init job (TLS cert generation runs before gateway starts)
kubectl get jobs -n tenant-a
```

### AgentSandbox CRs not appearing after session start

```bash
# Check control plane → gateway connectivity
kubectl logs -l app=ambient-control-plane -n ambient-code --tail=50 \
  | grep -i "sandbox\|gateway\|grpc\|error"

# Verify the gateway flag is set
kubectl get deployment ambient-control-plane -n ambient-code \
  -o jsonpath='{.spec.template.spec.containers[0].env}' | jq '.'
```

### Helm ClusterRole adoption conflict

Multiple gateway installs share cluster-scoped RBAC. Re-run the setup script — it handles adoption automatically:

```bash
OPENSHELL_TENANTS="tenant-a tenant-b" ./scripts/setup-kind-openshell.sh
```

### agent-sandbox controller not ready

```bash
kubectl get pods -n agent-sandbox-system
kubectl logs -l app=agent-sandbox-controller -n agent-sandbox-system --tail=50
grep AGENT_SANDBOX_VERSION scripts/setup-kind-openshell.sh  # check pinned version
```

### Adding a tenant to an existing cluster

```bash
# Idempotent for existing tenants
OPENSHELL_TENANTS="tenant-a tenant-b tenant-c" ./scripts/setup-kind-openshell.sh
```

### Switching between gateway mode and pod mode

```bash
# Enable gateway mode
kubectl set env deployment/ambient-control-plane -n ambient-code OPENSHELL_USE_GATEWAY=true
kubectl rollout restart deployment/ambient-control-plane -n ambient-code

# Revert to pod mode
kubectl set env deployment/ambient-control-plane -n ambient-code OPENSHELL_USE_GATEWAY=false
kubectl rollout restart deployment/ambient-control-plane -n ambient-code
```

## Reference

| Make Target | Description |
|-------------|-------------|
| `make kind-up OPENSHELL_USE_GATEWAY=true` | Full cluster with gateway setup |
| `make kind-up LOCAL_IMAGES=true OPENSHELL_USE_GATEWAY=true` | Local images + gateway |
| `make test-openshell-dual-tenant` | Run dual-tenant E2E test |
| `make kind-reload-ambient-control-plane` | Hot-deploy control plane after changes |
| `make vendor-openshell-proto REF=v0.0.71` | Update vendored OpenShell proto stubs |

Key files:

| File | Purpose |
|------|---------|
| `scripts/setup-kind-openshell.sh` | Gateway setup automation |
| `tests/openshell-dual-tenant.sh` | Dual-tenant E2E test |
| `components/ambient-control-plane/internal/reconciler/kube_reconciler.go` | `provisionSessionSandbox`, `cleanupSessionSandbox` |
| `components/ambient-control-plane/internal/openshell/` | Gateway gRPC client and generated stubs |
| `components/ambient-control-plane/proto/VENDOR.md` | Vendored proto update instructions |
