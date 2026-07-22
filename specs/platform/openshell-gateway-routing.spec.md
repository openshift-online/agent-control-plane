# OpenShell Gateway Routing Specification

**Date:** 2026-07-22
**Status:** Implementation-Verified
**Parent:** `openshell-gateway.spec.md` — core gateway provisioning
**Related:** `openshell-gateway-tls.spec.md` — TLS modes; `cli/gateway-cli.spec.md` — CLI route address display
**Verified by:** Working ROSA deployment (PR #415), e2e-openshell.sh (11/11 pass)

---

## Purpose

This specification defines how OpenShell gateways are exposed to external clients. Two routing strategies are supported: **Gateway API** (GRPCRoute + BackendTLSPolicy for clusters with Gateway API support) and **NLB passthrough** (for ROSA/AWS clusters where CloudFront breaks gRPC). The control plane auto-detects the available strategy. A NetworkPolicy for external router ingress is required for both strategies.

---

## Architecture

### Strategy 1: Gateway API (Preferred)

```
External Client (openshell CLI)
    │  TLS/HTTP2 (ALPN-negotiated)
    ▼
Networking Gateway (OpenShift gateway controller / Envoy)
    │  Terminates external TLS, negotiates HTTP/2 via ALPN
    │  GRPCRoute matches on hostname, forwards to backendRef
    │  BackendTLSPolicy: re-encrypts to pod, verifies cert via CA
    ▼
openshell-gateway Service (ClusterIP :8080)
    ▼
openshell-gateway Pod
```

Requires:
- OpenShift 4.22+ (GatewayClass `openshift-default`)
- Networking Gateway `acpgw` in `openshift-ingress`
- Wildcard TLS certificate for `*.acpgw.<base-domain>`

### Strategy 2: NLB Passthrough (ROSA/AWS)

```
External Client (openshell CLI)
    │  TLS (end-to-end, no termination)
    ▼
NLB (AWS Network Load Balancer, L4 TCP)
    │  Pure TCP passthrough — no HTTP inspection
    ▼
HAProxy (secondary IngressController router pod)
    │  SNI-based routing, TLS passthrough
    ▼
openshell-gateway Service (ClusterIP :8080)
    ▼
openshell-gateway Pod (terminates TLS with self-signed cert)
```

Required because ROSA's default ingress path includes CloudFront (L7 CDN):

```
Client → CloudFront (L7) → ALB → HAProxy → backend
```

CloudFront breaks gRPC:
- Buffers HTTP/2 streams (kills bidirectional streaming)
- Enforces 30s idle timeout (kills long-running sandbox sessions)
- Strips `te: trailers` headers (required by gRPC)
- Does not support bidirectional streaming

The NLB bypasses CloudFront entirely with L4 TCP passthrough.

---

## Requirements

### Requirement: NLB-Backed IngressController (ROSA/AWS)

On ROSA/AWS clusters, a secondary IngressController with NLB backing SHALL be created to provide L4 TCP ingress for gRPC traffic. This is a cluster-level prerequisite, NOT managed by the control plane reconciler.

#### IngressController Definition

```yaml
apiVersion: operator.openshift.io/v1
kind: IngressController
metadata:
  name: grpc
  namespace: openshift-ingress-operator
spec:
  domain: grpc.apps.rosa.<cluster>.<id>.p3.openshiftapps.com
  endpointPublishingStrategy:
    type: LoadBalancerService
    loadBalancer:
      providerParameters:
        type: AWS
        aws:
          type: NLB
      scope: External
      dnsManagementPolicy: Managed
  routeSelector:
    matchLabels:
      router: grpc
  replicas: 1
```

Key fields:
- `dnsManagementPolicy: Managed` — OpenShift automatically creates Route53 DNS records for the NLB. Without this, DNS must be manually configured.
- `routeSelector.matchLabels.router: grpc` — only Routes with `router: grpc` label are served by this IngressController, isolating gRPC traffic from default HTTP ingress.
- `aws.type: NLB` — Network Load Balancer provides L4 TCP, bypassing CloudFront.

#### Passthrough Route

```yaml
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: openshell-gateway-grpc
  namespace: <tenant-namespace>
  labels:
    router: grpc
spec:
  host: openshell-gateway-<namespace>.grpc.apps.rosa.<cluster>.<id>.p3.openshiftapps.com
  port:
    targetPort: grpc
  tls:
    termination: passthrough
  to:
    kind: Service
    name: openshell-gateway
```

The Route hostname must be included in the gateway's `serverDnsNames` so the certgen job generates a certificate with the correct SAN.

> **Implementation note (verified):** On ROSA `vteam-stage`, the NLB IngressController with `dnsManagementPolicy: Managed` creates a Route53 CNAME automatically. The managed hostname `openshell-gateway-tenant-a.grpc.apps.rosa.vteam-stage.7fpc.p3.openshiftapps.com` resolves to the NLB. The e2e script discovers this route dynamically by filtering for passthrough routes with `router: grpc*` labels, preferring hostnames containing `.apps.rosa.`.

---

### Requirement: NetworkPolicy for External Router Ingress

The GatewayReconciler creates `openshell-gateway-allow-sandbox` which allows ingress only from pods in the same namespace. Router pods in `openshift-ingress` are blocked by this policy. A separate NetworkPolicy SHALL be required for external route connectivity.

#### Scenario: Router NetworkPolicy required for NLB passthrough

- GIVEN an OpenShell gateway exposed via NLB passthrough Route
- AND the gateway namespace has NetworkPolicies applied
- WHEN an external client connects via the NLB
- THEN HAProxy router pods in `openshift-ingress` namespace must reach the gateway pod on port 8080
- AND without the router NetworkPolicy, the TLS handshake hangs with zero bytes read

#### NetworkPolicy Definition

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: openshell-gateway-allow-router
  namespace: <tenant-namespace>
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

> **Implementation note:** The reconciler SHOULD create this NetworkPolicy automatically when it detects OpenShift (`isOpenShift=true`). This is a known gap — currently it must be created manually. See "Reconciler Improvements" below.

---

### Requirement: Gateway API Detection

The control plane SHALL detect at startup whether a compatible networking Gateway is available for GRPCRoute provisioning.

#### Scenario: Networking Gateway available

- GIVEN the `gateway.networking.k8s.io` API group is available (GRPCRoute CRD exists)
- AND a Gateway resource named `acpgw` exists in `openshift-ingress`
- AND the Gateway's `.status.conditions` includes `Accepted: True`
- THEN the control plane SHALL enable GRPCRoute provisioning

#### Scenario: GRPCRoute CRD not available

- GIVEN the `gateway.networking.k8s.io` API group does NOT include `grpcroutes`
- THEN the control plane SHALL disable GRPCRoute provisioning
- AND no warning SHALL be logged (normal operation)

---

### Requirement: Gateway Route Configuration

The Gateway resource SHALL support an optional `route` field that declares external exposure via GRPCRoute.

#### Scenario: Gateway with auto-assigned route host

- GIVEN a Gateway with `route: {}`
- THEN the GRPCRoute hostname SHALL be `openshell-gateway-<namespace>.acpgw.<base-domain>`

#### Scenario: Gateway without route configuration

- GIVEN a Gateway with no `route` field
- THEN no GRPCRoute SHALL be created
- AND the gateway SHALL be accessible only via cluster-internal DNS and `kubectl port-forward`

---

### Requirement: GRPCRoute Resource Specification

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: openshell-gateway
  namespace: <project-namespace>
  labels:
    app.kubernetes.io/name: openshell
    app.kubernetes.io/component: gateway
    app.kubernetes.io/managed-by: agent-control-plane
  ownerReferences:
  - apiVersion: apps/v1
    kind: StatefulSet
    name: openshell-gateway
    controller: true
    blockOwnerDeletion: true
spec:
  parentRefs:
  - name: <networking-gateway-name>
    namespace: <networking-gateway-namespace>
  hostnames:
  - <derived-or-explicit-hostname>
  rules:
  - backendRefs:
    - name: openshell-gateway
      port: 8080
```

---

### Requirement: BackendTLSPolicy for Re-encrypt

The control plane SHALL create a BackendTLSPolicy to enable TLS verification from the networking Gateway to the gateway pod.

- Read `ca.crt` from `openshell-server-tls` Secret
- Create ConfigMap `openshell-backend-ca` with the CA certificate
- Create BackendTLSPolicy targeting `openshell-gateway` Service
- Validation hostname: `openshell-gateway.<namespace>.svc.cluster.local`

---

### Requirement: Route Address Discovery

The GatewayReconciler SHALL derive the external route address from the GRPCRoute hostname and PATCH it into the Gateway's `routeAddress` field via the API server.

- Format: `grpcs://<hostname>:443`
- Stored in the Gateway API resource for CLI consumption
- `acpctl get gateways` displays the routeAddress

---

### Requirement: Gateway API Configuration

| Variable | Default | Description |
|---|---|---|
| `GATEWAY_API_GATEWAY_NAME` | `acpgw` | Name of the networking Gateway resource |
| `GATEWAY_API_GATEWAY_NAMESPACE` | `openshift-ingress` | Namespace of the networking Gateway |
| `GATEWAY_API_BASE_DOMAIN` | auto-detected | Cluster base domain for hostname generation |

---

### Requirement: RBAC for Routing Resources

```yaml
- apiGroups: ["gateway.networking.k8s.io"]
  resources: ["grpcroutes", "backendtlspolicies"]
  verbs: ["get", "list", "create", "update", "patch", "delete"]

- apiGroups: ["gateway.networking.k8s.io"]
  resources: ["gateways"]
  verbs: ["get", "list"]

- apiGroups: ["networking.k8s.io"]
  resources: ["networkpolicies"]
  verbs: ["create", "get", "update", "patch", "delete"]
```

---

## Reconciler Improvements (Planned)

1. **NetworkPolicy for router ingress**: The reconciler SHOULD create `openshell-gateway-allow-router` automatically when a Route is configured on an OpenShift cluster.

2. **Route management**: The reconciler SHOULD create/update the passthrough Route with the `router: grpc` label for NLB-backed ingress, as an alternative to Gateway API GRPCRoutes.

3. **Gateway restart on ConfigMap change**: The gateway workload needs a hash annotation on the ConfigMap content so it automatically restarts when the TOML changes.

---

## Debugging Reference

| Symptom | Root Cause | Fix |
|---|---|---|
| Route times out on ROSA (all types via default ingress) | CloudFront L7 CDN buffering/killing gRPC | Use NLB IngressController |
| TLS handshake: 0 bytes read, immediate EOF | NetworkPolicy blocking router → gateway | Create `openshell-gateway-allow-router` |
| 503 Service Unavailable from route | SNI mismatch — HAProxy can't match hostname | Ensure Route hostname matches cert SAN |
| grpcurl hangs but openssl s_client works | grpcurl blocked by NetworkPolicy | Check source namespace |
| `acpctl apply` creates gateway but no external access | No `route` field on Gateway resource | Add `route: {}` or create NLB Route manually |

---

## References

- [NVIDIA OpenShell Kubernetes Ingress Guide](https://docs.nvidia.com/openshell/kubernetes/ingress)
- [BackendTLSPolicy on OpenShift](https://www.redhat.com/en/blog/backendtlspolicy-expands-gateway-api-transport-security)
- [BackendTLSPolicy API Reference](https://gateway-api.sigs.k8s.io/reference/api-types/policy/backendtlspolicy/)
- [Gateway API TLS Guide](https://gateway-api.sigs.k8s.io/guides/tls/)
- [OpenShift IngressController API](https://docs.openshift.com/container-platform/4.17/networking/configuring_ingress_cluster_traffic/configuring-ingress-cluster-traffic-load-balancer.html)
