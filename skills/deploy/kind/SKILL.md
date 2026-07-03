---
name: kind
description: >
  Deploy a Kind cluster with OpenShell gateway mode, apply tenant fleet
  definitions via acpctl apply -k, set up Vertex/Google credentials, spin up
  sandbox sessions, and configure local openshell CLI connectivity. Use this
  skill whenever the user wants to test gateway-provisioned sandboxes, create
  credentials in tenants, debug sandbox provisioning, connect the openshell CLI
  to a gateway, or run dual-tenant tests. You SHOULD reach for this skill on:
  "kind-up", "kind cluster", "openshell gateway", "gateway mode",
  "OPENSHELL_USE_GATEWAY", "sandbox provisioning", "dual-tenant", "tenant-a",
  "tenant-b", "vertex credential", "spin up a sandbox", "credential in tenant",
  "openshell sandbox list", "gateway connectivity", "connect to the gateway",
  "mtls", "port-forward gateway", "acpctl apply -k", "local development".
---

# Kind Local Development Skill

Gateway mode (`OPENSHELL_USE_GATEWAY=true`) delegates sandbox lifecycle to an
OpenShell gateway via gRPC. The gateway runs per-tenant and manages `Sandbox`
CRs. Gateway resources (StatefulSet, certgen Job, TLS secrets) are deployed by
the **control plane reconciler** from the `platform-config` ConfigMap — no Helm
chart is involved.

## Full Workflow: Cluster → Credential → Sandbox

### Step 1 — Deploy the Kind Cluster (REQUIRED)

```bash
make kind-up OPENSHELL_USE_GATEWAY=true
```

Then in a **separate terminal**:

```bash
make kind-port-forward
```

Check ports with `make kind-status`.

#### Handle the Gateway Race Condition

There is a known race: the control plane gateway reconciler runs at startup
before `setup-kind-openshell.sh` creates tenant namespaces. The reconciler logs
"namespace not found, skipping" and does not retry autonomously.

After `kind-up` completes, check whether the gateway deployed:

```bash
kubectl get statefulset -n tenant-a
```

If empty, force re-reconciliation:

```bash
kubectl annotate configmap platform-config -n ambient-code \
  reconcile-trigger="$(date +%s)" --overwrite
```

Wait for gateway + certgen:

```bash
sleep 10
kubectl get pods -n tenant-a
# Expect: openshell-gateway-0 Running, openshell-gateway-certgen Completed
kubectl get secrets -n tenant-a | grep openshell
# Expect: openshell-client-tls, openshell-server-tls, openshell-gateway-jwt-keys
```

This is the most common failure when `kind-up` appears to succeed but sessions
fail with `openshell-client-tls not found`. Always check and fix before
proceeding.

### Step 2 — Login with acpctl (REQUIRED)

The `acpctl` binary lives at `components/ambient-cli/acpctl` (prebuilt).

```bash
TOKEN=$(kubectl get secret test-user-token -n ambient-code \
  -o jsonpath='{.data.token}' | base64 -d)
components/ambient-cli/acpctl login --url http://localhost:$API_PORT --token "$TOKEN"
```

Get `$API_PORT` from `make kind-status` (the "backend" port, typically 12856 on
the main branch).

### Step 3 - Apply Tenant Fleet Definitions (REQUIRED)

The declarative approach uses `acpctl apply -k` to provision projects, agents,
providers, and credentials from kustomize overlays in `examples/`.

```bash
make kind-setup-vertex   # configures Vertex AI env vars and K8s secrets
acpctl apply -k examples/overlays/tenant-a/
acpctl apply -k examples/overlays/tenant-b/
```

This creates:
- **Projects** (tenant-a, tenant-b)
- **Agents** with provider declarations (e.g., `providers: ["vertex"]`)
- **Providers** (type: `vertex`, referencing K8s secrets with OAuth2 refresh tokens)
- **K8s Secrets** with Vertex AI credentials in each tenant namespace

> **Prerequisite:** `make kind-setup-vertex` must run first to set
> `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, and create K8s secrets with
> Vertex AI service account credentials in tenant namespaces.


### Step 4 — Start a Session (This Creates the Sandbox) (REQUIRED)

Sandboxes are created **through the control plane** by creating a session. The
control plane reconciler watches for new sessions and provisions sandboxes via
the gateway automatically. **Do NOT use `openshell sandbox create`** — that
bypasses the platform and creates an unmanaged sandbox.

```bash
AGENT_ID=$(acpctl get agents 2>/dev/null | awk '/hello-world/{print $1}')
acpctl start $AGENT_ID --project-id tenant-a --prompt "Say hello world"
```

The control plane will:
1. Detect the new session
2. Call the gateway's gRPC API to create a `Sandbox` CR in the tenant namespace
3. Copy the vertex credential secret into the tenant namespace
4. Configure inference routing on the gateway

### Step 5 — Verify Sandbox Reaches Ready

```bash
kubectl get sandboxes -n tenant-a
SANDBOX=$(kubectl get sandboxes -n tenant-a -o jsonpath='{.items[-1].metadata.name}')

# Wait for ready (image pull is ~1.7 GB on first run, allow 2-3 min)
kubectl wait --for=jsonpath='{.status.conditions[0].status}'=True \
  sandbox/$SANDBOX -n tenant-a --timeout=300s

kubectl get sandbox $SANDBOX -n tenant-a \
  -o jsonpath='{.status.conditions}' | python3 -m json.tool
# Expect: reason=DependenciesReady, status=True, message="Pod is Ready"
```

## Local Gateway Connectivity (openshell CLI)

This section configures the `openshell` CLI to connect to a tenant's gateway
via mTLS so you can run commands like `openshell sandbox list` from your
workstation.

### mTLS Certs — Use `openshell-server-tls` for ALL Three Files

The gateway's `tls-client-ca` volume mounts `openshell-server-tls`, so only
certs signed by that CA are trusted. A separate `openshell-client-tls` secret
exists but uses a **different CA** (same CN, different key pair). Using
`openshell-client-tls` for `ca.crt` causes `BadSignature`; using it for
`tls.crt`/`tls.key` causes `DecryptError`.

```bash
GATEWAY_NAME=tenant-a-gw
mkdir -p ~/.config/openshell/gateways/${GATEWAY_NAME}/mtls

# ALL three from openshell-server-tls
kubectl get secret openshell-server-tls -n tenant-a \
  -o jsonpath='{.data.ca\.crt}' | base64 -d \
  > ~/.config/openshell/gateways/${GATEWAY_NAME}/mtls/ca.crt

kubectl get secret openshell-server-tls -n tenant-a \
  -o jsonpath='{.data.tls\.crt}' | base64 -d \
  > ~/.config/openshell/gateways/${GATEWAY_NAME}/mtls/tls.crt

kubectl get secret openshell-server-tls -n tenant-a \
  -o jsonpath='{.data.tls\.key}' | base64 -d \
  > ~/.config/openshell/gateways/${GATEWAY_NAME}/mtls/tls.key
```

### Register the Gateway

If the gateway name doesn't exist yet in `openshell gateway list`:

```bash
openshell gateway add --name ${GATEWAY_NAME} --local https://localhost:8080
```

If it already exists and needs updating, remove and re-add:

```bash
openshell gateway remove ${GATEWAY_NAME}
openshell gateway add --name ${GATEWAY_NAME} --local https://localhost:8080
```

### Port-Forward and Test

The gateway listens on gRPC port 8080. Port forwards drop after idle — restart
as needed.

```bash
kubectl port-forward -n tenant-a statefulset/openshell-gateway 8080:8080 &
```

Verify connectivity:

```bash
openshell sandbox list --gateway ${GATEWAY_NAME}
```

If the gateway is already set as active (`*` in `openshell gateway list`),
the `--gateway` flag can be omitted:

```bash
openshell sandbox list
```

### Connecting to a Different Tenant

Repeat the same steps with the other tenant's namespace and a different
gateway name/port:

```bash
GATEWAY_NAME=tenant-b-gw
# Extract certs from tenant-b's openshell-server-tls (same process)
# Register with a different local port to avoid collisions:
openshell gateway add --name ${GATEWAY_NAME} --local https://localhost:8081
kubectl port-forward -n tenant-b statefulset/openshell-gateway 8081:8080 &
openshell sandbox list --gateway ${GATEWAY_NAME}
```

## Troubleshooting

**Gateway not deployed after kind-up** — Race condition. See Step 1 above.
Annotate `platform-config` to trigger re-reconciliation.

**`openshell-client-tls` not found** — Gateway certgen hasn't run. Ensure the
gateway StatefulSet and certgen Job completed in the tenant namespace first.

**`credential bind` returns 403** — CLI bug, use the direct API workaround in
Step 3 above.

**Sandbox pod stuck in `Init:0/1`** — The init container pulls
`quay.io/ambient_code/acp_runner_openshell:latest` (~1.7 GB). Check events:
`kubectl describe pod <pod> -n tenant-a | tail -20`

**Session marked Failed** — Likely the first session hit max retries while the
gateway was still deploying. Create a new session after confirming the gateway
and TLS secrets are in place.

**`BadSignature` or `DecryptError` from openshell CLI** — You used
`openshell-client-tls` instead of `openshell-server-tls` for the mTLS certs.
Re-extract all three files from `openshell-server-tls` (see the mTLS section).

**`openshell sandbox list` hangs or connection refused** — Port forward
dropped. Restart it: `kubectl port-forward -n tenant-a statefulset/openshell-gateway 8080:8080 &`

**`inference.local:443 NET:FAIL` in sandbox logs** — The OpenShell supervisor uses
musl libc which handles DNS differently from glibc. The control plane patches
Sandbox CRs with `ndots:1` in dnsConfig and recreates the pod. If you see this
error, check that the sandbox pod has `ndots:1` in `/etc/resolv.conf`:
`kubectl exec <pod> -n tenant-a -- cat /etc/resolv.conf`

**`Name does not resolve` for K8s service URLs** — With ndots:1, musl treats
hostnames with >1 dot as absolute and does NOT fall back to search domains.
All service URLs in `ambient-control-plane-service.yml` and Kind overlays must
use FQDNs ending in `.cluster.local` (e.g.,
`ambient-api-server.ambient-code.svc.cluster.local:8000`).

**Runner image `localhost/...` not found in Kind** — The Kind overlay sets
`OPENSHELL_RUNNER_IMAGE=localhost/acp_runner_openshell:latest` but this image
may not exist on the Kind node. Fix:
`kubectl set env deployment/ambient-control-plane -n ambient-code OPENSHELL_RUNNER_IMAGE=quay.io/ambient_code/acp_runner_openshell:latest`

**Switching between gateway and pod mode:**

```bash
kubectl set env deployment/ambient-control-plane -n ambient-code \
  OPENSHELL_USE_GATEWAY=true   # or false
kubectl rollout restart deployment/ambient-control-plane -n ambient-code
```

## Running the Dual-Tenant E2E Test

```bash
make test-openshell-dual-tenant
```

## Key Files

| File | Purpose |
|------|---------|
| `scripts/setup-kind-openshell.sh` | Gateway prerequisites (CRD, namespaces, projects) |
| `components/ambient-control-plane/internal/gateway/reconciler.go` | Gateway manifest deployment from platform-config |
| `components/ambient-control-plane/internal/reconciler/kube_reconciler.go` | Session → sandbox provisioning |
| `components/ambient-control-plane/internal/openshell/tls_resolver.go` | mTLS credential resolution |
| `components/manifests/base/platform-config.yaml` | Namespace/gateway configuration |
