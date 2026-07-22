# OpenShell Gateway on ROSA: mTLS, OIDC, and External Connectivity

> **Working memory.** Canonical specifications live in `specs/platform/openshell-gateway*.spec.md`.

## Result

**Local openshell CLI successfully connected to the hosted OpenShell gateway on ROSA** via OIDC authentication, created a sandbox, and received a running pod. Full e2e demo: 11/11 pass.

```
openshell CLI (local) → NLB (L4) → HAProxy passthrough → gateway pod → sandbox pod
```

Demo script: `components/pr-test/e2e-openshell.sh`

## Architecture

### Cluster State (namespace: `acp-api-01` + `tenant-a`)

| Component | Image | Status |
|---|---|---|
| `ambient-control-plane` | `quay.io/ambient_code/acp_control_plane:gateway-oidc-mtls` | Running, reconciling |
| `ambient-api-server` | `quay.io/ambient_code/acp_api_server:gateway-postgres-fix` | Running |
| `openshell-gateway` | `ghcr.io/nvidia/openshell/gateway:0.0.88` | Running (Deployment) |
| `openshell-gateway-db` | `registry.redhat.io/rhel9/postgresql-16:latest` | Running (Deployment) |
| `demo-sandbox` | `ghcr.io/nvidia/openshell-community/sandboxes/base:latest` | Running |

### Gateway Configuration

```toml
[openshell.gateway.tls]
cert_path      = "/etc/openshell-tls/server/tls.crt"
key_path       = "/etc/openshell-tls/server/tls.key"
client_ca_path = "/etc/openshell-tls/client-ca/ca.crt"   # RETAINED with OIDC

[openshell.gateway.auth]
allow_unauthenticated_users = false

[openshell.gateway.oidc]
issuer      = "https://keycloak-acp-api-01.apps.rosa.vteam-stage.7fpc.p3.openshiftapps.com/realms/ambient-code"
audience    = "ambient-frontend"
roles_claim = "groups"
admin_role  = "ambient-admins"
user_role   = "ambient-users"
```

### TLS Mode: Optional mTLS (has_ca && has_oidc)

OpenShell's TLS modes are determined by `require_client_auth = has_client_ca && !has_oidc`:

| `client_ca_path` | OIDC configured | `require_client_auth` | Mode |
|---|---|---|---|
| set | no | **true** | Full mTLS — all clients must present certs |
| set | yes | **false** | Optional mTLS — certs validated when present, OIDC for others |
| unset | yes | false | HTTPS + OIDC only |
| unset | no | false | HTTPS only (allow_unauthenticated) |

We use **optional mTLS**: sandbox supervisors still authenticate via client certificates, while CLI users authenticate via OIDC Bearer tokens. HAProxy re-encrypt/passthrough works because client cert is not required.

## Networking

### The CloudFront Problem

ROSA's default ingress path: `Client → CloudFront (L7) → ALB → HAProxy → backend`

CloudFront breaks gRPC:
- Buffers HTTP/2 streams
- Enforces 30s idle timeout killing streaming connections
- Strips `te: trailers` headers
- Does not support bidirectional streaming

Both passthrough and re-encrypt Routes through the default ingress controller time out.

### The Solution: NLB-Backed IngressController

Created a secondary IngressController with an NLB (L4 TCP):

```yaml
apiVersion: operator.openshift.io/v1
kind: IngressController
metadata:
  name: grpc
  namespace: openshift-ingress-operator
spec:
  domain: grpc.vteam-stage.7fpc.p3.openshiftapps.com
  endpointPublishingStrategy:
    type: LoadBalancerService
    loadBalancer:
      providerParameters:
        type: AWS
        aws:
          type: NLB
      scope: External
  routeSelector:
    matchLabels:
      router: grpc
  replicas: 1
```

Passthrough Route labeled for the NLB router:

```yaml
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: openshell-gateway-grpc
  namespace: tenant-a
  labels:
    router: grpc
spec:
  host: openshell-gateway-tenant-a.grpc.vteam-stage.7fpc.p3.openshiftapps.com
  port:
    targetPort: grpc
  tls:
    termination: passthrough
  to:
    kind: Service
    name: openshell-gateway
```

NLB hostname: `af7661bc2f5404ef3b9307fb3ea670bf-86d9f83cd3c5ca72.elb.us-east-1.amazonaws.com`

### NetworkPolicy (Critical)

The reconciler creates `openshell-gateway-allow-sandbox` which only allows ingress from pods in the same namespace. Router pods in `openshift-ingress` are blocked. A separate NetworkPolicy is required:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: openshell-gateway-allow-router
  namespace: tenant-a
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/instance: openshell-gateway
      app.kubernetes.io/name: openshell
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: openshift-ingress
    ports:
    - port: 8080
      protocol: TCP
    - port: 8081
      protocol: TCP
```

Without this, the NLB passthrough silently fails — TLS handshake hangs with zero bytes read.

## Code Changes

### 1. `manifests.go` — Keep `client_ca_path` with OIDC (critical fix)

**File:** `components/ambient-control-plane/internal/gateway/manifests.go`

Removed the block at lines 154-163 that stripped `client_ca_path` from gateway.toml when OIDC was configured. OpenShell handles this correctly via `require_client_auth = has_ca && !has_oidc` — OIDC presence automatically switches from required to optional mTLS.

**Before:** OIDC + mTLS were mutually exclusive (code removed `client_ca_path`).
**After:** OIDC + mTLS are complementary (optional mTLS, OIDC for CLI users, mTLS for sandboxes).

### 2. `reconciler.go` — RHEL postgres image default

**File:** `components/ambient-control-plane/internal/gateway/reconciler.go`

Changed default postgres image from `postgres:16` (Docker Hub, rate-limited) to `registry.redhat.io/rhel9/postgresql-16:latest` (matches API server DB pattern). The RHEL image detection (`strings.Contains(pgImage, "rhel")`) correctly switches env vars to `POSTGRESQL_*` format.

### 3. `kustomize.go` — Database field in Resource struct

**File:** `components/ambient-sdk/go-sdk/kustomize/kustomize.go`

Added `Database map[string]any` field to the `Resource` struct. Without this, `acpctl apply` silently dropped the `database:` key from YAML manifests, causing gateways to revert to sqlite.

### 4. `apply/cmd.go` — Database wiring in acpctl apply

**File:** `components/ambient-cli/cmd/acpctl/apply/cmd.go`

Added `databaseFromResource()` helper and wired the `Database` field through both create (`applyGateway`) and patch (`buildGatewayPatch`) paths.

### 5. `manifests_test.go` — Updated test

**File:** `components/ambient-control-plane/internal/gateway/manifests_test.go`

Updated `TestApplyConfigOverrides_OIDCDisablesMTLS` to expect `client_ca_path` retained (not removed) when OIDC is enabled.

## Images

| Image | Tag | Registry |
|---|---|---|
| `acp_control_plane` | `gateway-oidc-mtls` | `quay.io/ambient_code/` |
| `acp_api_server` | `gateway-postgres-fix` | `quay.io/ambient_code/` |

## CLI Connection Flow

```bash
# 1. Login to acpctl (get OIDC token)
acpctl login --password-grant --username admin --password admin \
  --issuer-url https://keycloak-acp-api-01.apps.rosa.vteam-stage.7fpc.p3.openshiftapps.com/realms/ambient-code \
  --client-id ambient-frontend --client-secret "acp-ZaA3W6_uxDSwZDisz0Yz6A" \
  --url https://ambient-api-acp-api-01.apps.rosa.vteam-stage.7fpc.p3.openshiftapps.com

# 2. Port-forward to gateway (until DNS is configured for the NLB route)
oc port-forward -n tenant-a svc/openshell-gateway 7443:8080 &

# 3. Register gateway and inject OIDC token
acpctl gateway setup-cli --project tenant-a --gateway-url "https://localhost:7443"

# 4. Use openshell CLI
OPENSHELL_GATEWAY_INSECURE=true openshell -g tenant-a-openshell-gateway status
OPENSHELL_GATEWAY_INSECURE=true openshell -g tenant-a-openshell-gateway sandbox create --name demo
OPENSHELL_GATEWAY_INSECURE=true openshell -g tenant-a-openshell-gateway provider list
```

## Remaining Work

### DNS for NLB Route — RESOLVED

Fixed by using `dnsManagementPolicy: Managed` on the IngressController. OpenShift automatically creates Route53 records for the NLB. The managed hostname `openshell-gateway-tenant-a.grpc.apps.rosa.vteam-stage.7fpc.p3.openshiftapps.com` resolves to the NLB.

### Reconciler Improvements (Open)

1. **NetworkPolicy for router ingress**: The reconciler should create `openshell-gateway-allow-router` automatically on OpenShift. See `specs/platform/openshell-gateway-routing.spec.md`.

2. **Route management**: The reconciler should create/update passthrough Routes with `router: grpc` label. See `specs/platform/openshell-gateway-routing.spec.md`.

3. **Gateway restart on ConfigMap change**: Needs hash annotation on ConfigMap content.

4. **Keycloak token TTL**: 5-minute TTL causes frequent expiry. openshell CLI should auto-renew via refresh token.

5. **Control plane RBAC**: ClusterRole `ambient-control-plane` needs `configmaps`, `persistentvolumeclaims`, `deployments`, `networkpolicies` permissions. Currently patched manually; needs proper fix in `components/manifests/base/rbac/control-plane-clusterrole.yaml`.

### Commit Changes

Code changes committed in PR #415. Spec updates in `spec/openshell-gateway-subspecs` branch.

## Spec References

| Spec | Scope |
|---|---|
| `specs/platform/openshell-gateway.spec.md` | Core provisioning, reconciler, deployment resources |
| `specs/platform/openshell-gateway-tls.spec.md` | TLS, optional mTLS, cert-manager, SAN management |
| `specs/platform/openshell-gateway-oidc.spec.md` | OIDC authentication, role validation, Keycloak |
| `specs/platform/openshell-gateway-routing.spec.md` | Gateway API, NLB passthrough, NetworkPolicy |
| `specs/platform/openshell-gateway-database.spec.md` | PostgreSQL provisioning, workload switching |

## Debugging Reference

### Symptom → Root Cause Map

| Symptom | Root Cause |
|---|---|
| Route times out (all types) on ROSA | CloudFront L7 CDN in front of default ingress — use NLB |
| TLS handshake: 0 bytes read, immediate EOF | NetworkPolicy blocking router → gateway ingress |
| `DecryptError` in gateway logs | Stale client cert from sandbox after cert rotation |
| grpcurl hangs but openssl s_client works | grpcurl blocked by NetworkPolicy (different source namespace) |
| 503 Service Unavailable from route | SNI mismatch — HAProxy can't match passthrough route hostname |
| `role 'openshell-user' required` | OIDC `roles_claim` not configured — JWT has `groups` not `roles` |
| `invalid peer certificate: UnknownIssuer` | Self-signed CA — use `OPENSHELL_GATEWAY_INSECURE=true` or trust CA |
| `acpctl apply` silently reverts to sqlite | `kustomize.Resource` missing `Database` field |
| Docker Hub `toomanyrequests` for postgres | Changed default to `registry.redhat.io/rhel9/postgresql-16:latest` |
| Cert deletion loop (every 30s) | ConfigMap SANs don't match API SANs exactly |
| `GROUPS` variable returns `1000` | Bash builtin collision — use `USER_GROUPS` instead |
| `openshell gateway add` opens browser | No `--no-browser` flag — write metadata.json directly |
| `openshell sandbox create` hangs | Blocking interactive command — background and poll for pod status |
