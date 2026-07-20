# OpenShell Gateway Specification

**Date:** 2026-07-17
**Status:** Design
**Supersedes:** Previous ConfigMap-based `platform-config` gateway provisioning design; individual `gateway-provisioning.spec.md`, `gateway-oidc.spec.md`, `gateway-route-exposure.spec.md`, `gateway-db-provisioning.spec.md` specs (now consolidated here)
**Related:** `openshell-sandbox-provisioning.spec.md` — gateway mode usage; `control-plane.spec.md` — CP reconciliation patterns; `data-model.spec.md` — Gateway kind definition; `security/gateway-rbac-policy.spec.md` — gateway RBAC; `e2e-test-tooling.spec.md` — mock LLM and self-contained testing; `cli/gateway-cli.spec.md` — CLI gateway commands
**Skill:** `skills/build/full-stack-pipeline/` — wave-based implementation pipeline
**Upstream:** [OpenShell Helm Chart](https://github.com/NVIDIA/OpenShell/tree/main/deploy/helm/openshell) — gateway Helm chart, `server.externalDbSecret` pattern; [OpenShell OIDC User Authentication](https://docs.nvidia.com/openshell/latest/kubernetes/access-control#oidc-user-authentication)

---

## Purpose

The control plane SHALL provision and reconcile OpenShell gateway deployments in project namespaces through a fully API-driven model. Gateway configuration is expressed as a first-class ACP resource (`kind: Gateway`), applied via `acpctl apply -k` alongside Project, Agent, Credential, and RoleBinding resources. The API server persists Gateway resources in PostgreSQL. The control plane discovers Gateway resources via the same gRPC watch stream used for all other resources and reconciles them into Kubernetes gateway deployments.

This replaces the previous ConfigMap-based `platform-config` approach. The ConfigMap, its watcher (`internal/gateway/config.go`), and the `initGatewayProvisioning()` startup path are eliminated.

This specification covers the full gateway lifecycle:

- **Core Provisioning** — Gateway as API resource, GatewayReconciler, shared kustomize library, manifest templating, config validation, kustomize overlays, ConfigMap elimination, SSH payload delivery, gateway deployment resources, failure handling
- **OIDC Authentication** — Optional per-gateway OIDC configuration, role validation, gateway.toml injection, mTLS interaction, change detection
- **Route Exposure** — GRPCRoute via Kubernetes Gateway API, BackendTLSPolicy for TLS re-encryption, route address discovery, CLI integration
- **Database Provisioning** — Optional PostgreSQL database alongside gateways, workload switching (StatefulSet vs Deployment), credential security, type transitions
- **OpenShift-Specific** — SCC bindings, security context adjustments, cert-manager integration, trusted CA bundle injection
- **Cross-Cluster** — Gateway deployment on dedicated gateway clusters, external endpoint exposure

---

## Architecture

### Flow

```
acpctl apply -k overlays/tenant-a/
    │  renders kustomization.yaml (Project + Gateway + Agents + Credentials)
    │  POST/PATCH each resource to API server
    ▼
API Server (PostgreSQL)
    │  persists Gateway resource
    │  emits gRPC watch event
    ▼
Control Plane — GatewayReconciler (internal/reconciler/)
    │  receives Gateway ADDED/MODIFIED event
    │  validates image, DNS names, TOML config
    │  applies gateway K8s manifests to the project namespace
    ▼
Kubernetes (StatefulSet/Deployment, Service, RBAC, certgen Job, NetworkPolicy)
```

### Relationship to Projects

**Project = Namespace.** The ProjectReconciler already creates a Kubernetes namespace for each Project via `ensureNamespace()`. A Gateway resource references a Project by name. When the GatewayReconciler processes a Gateway event, the target namespace already exists because the ProjectReconciler runs first in the reconciler chain.

### Relationship to Clusters (Multi-Cluster)

A Gateway resource carries an optional `cluster_id` FK that targets a specific registered Cluster. When `cluster_id` is null, the gateway is deployed on the local cluster (backward compatible). When set, the GatewayReconciler obtains the target cluster's `KubeClient` from the `ClusterClientPool` and deploys gateway K8s resources on that cluster.

This enables dedicated gateway clusters — clusters with `role=gateway` that host nothing but OpenShell gateways, while session workloads run on separate `role=workload` clusters. The GatewayReconciler is responsible for:

1. Deploying gateway K8s resources (StatefulSet, Service, RBAC, certgen Job) on the target cluster
2. Creating an externally reachable endpoint (LoadBalancer Service or Ingress/Route) when the gateway serves workloads on a different cluster
3. Storing the external endpoint URL in the Gateway's `annotations` (`ambient-code.io/gateway-external-url`) for cross-cluster discovery by the `GatewayClient`

### Relationship to ApplicationReconciler

The ApplicationReconciler performs GitOps continuous sync from git repositories. It uses the shared kustomize library to render manifests, which may include `kind: Gateway` documents. The sync engine applies Gateway resources to the API server just like any other kind. The GatewayReconciler then reconciles them into Kubernetes.

### Route Exposure Data Flow

```
External Client (openshell CLI)
    │  TLS/HTTP2 (ALPN-negotiated)
    ▼
LoadBalancer (production) or passthrough Route (CRC)
    │  L4 TCP — no TLS termination
    ▼
Networking Gateway (OpenShift gateway controller / Envoy)
    │  Terminates TLS, negotiates HTTP/2 via ALPN
    │  GRPCRoute matches on hostname, forwards to backendRef
    │  BackendTLSPolicy: re-encrypts to pod, verifies cert via CA
    ▼
openshell-gateway Service (ClusterIP :8080)
    │  gRPC/TLS (self-signed cert from openshell-server-tls Secret)
    ▼
openshell-gateway Pod
```

### Route Cluster Prerequisites

The networking Gateway is cluster-level infrastructure, installed once per cluster (typically by `make crc-up` or a cluster administrator). It is NOT managed by the control plane reconciler.

1. **GatewayClass** — `openshift-default` with controller `openshift.io/gateway-controller/v1`. Built-in on OpenShift 4.22+; no installation required.

2. **Networking Gateway** — Named `acpgw` in the `openshift-ingress` namespace. Provides a shared HTTPS ingress point for all tenant GRPCRoutes:
   ```yaml
   apiVersion: gateway.networking.k8s.io/v1
   kind: Gateway
   metadata:
     name: acpgw
     namespace: openshift-ingress
   spec:
     gatewayClassName: openshift-default
     listeners:
     - name: grpc
       hostname: "*.acpgw.<base-domain>"
       port: 443
       protocol: HTTPS
       tls:
         mode: Terminate
         certificateRefs:
         - name: acpgw-tls
           kind: Secret
       allowedRoutes:
         namespaces:
           from: All
   ```
   The `<base-domain>` is read from `ingresses.config.openshift.io/cluster` `.spec.domain` (e.g., `apps-crc.testing`). The `allowedRoutes.namespaces.from: All` permits GRPCRoutes from any tenant namespace. The `acpgw-tls` Secret contains a wildcard certificate for `*.acpgw.<base-domain>` — generated by `setup-gateway-api.sh` on CRC or provisioned by cert-manager in production.

### Per-Tenant Route Resources (Managed by Control Plane)

For each gateway with `route` configuration, the control plane creates:

1. **GRPCRoute** — In the tenant namespace, referencing the networking Gateway:
   ```yaml
   apiVersion: gateway.networking.k8s.io/v1
   kind: GRPCRoute
   metadata:
     name: openshell-gateway
     namespace: <tenant-namespace>
   spec:
     parentRefs:
     - name: acpgw
       namespace: openshift-ingress
     hostnames:
     - <gateway-name>-<namespace>.acpgw.<base-domain>
     rules:
     - backendRefs:
       - name: openshell-gateway
         port: 8080
   ```

2. **BackendTLSPolicy** — Enables TLS verification from the networking Gateway to the pod:
   ```yaml
   apiVersion: gateway.networking.k8s.io/v1
   kind: BackendTLSPolicy
   metadata:
     name: openshell-gateway
     namespace: <tenant-namespace>
   spec:
     targetRefs:
     - group: ""
       kind: Service
       name: openshell-gateway
     validation:
       caCertificateRefs:
       - group: ""
         kind: ConfigMap
         name: openshell-backend-ca
       hostname: openshell-gateway.<namespace>.svc.cluster.local
   ```

3. **CA ConfigMap** — Contains the gateway pod's CA certificate for BackendTLSPolicy:
   ```yaml
   apiVersion: v1
   kind: ConfigMap
   metadata:
     name: openshell-backend-ca
     namespace: <tenant-namespace>
   data:
     ca.crt: |
       <contents of openshell-server-tls Secret ca.crt>
   ```

### Route TLS Strategy

The Gateway API approach uses HTTPS on the listener and BackendTLSPolicy for re-encryption:

1. **Client to Gateway.** The networking Gateway listener uses HTTPS (port 443) with a wildcard TLS certificate. Clients connect via `https://` and HTTP/2 is negotiated through ALPN during the TLS handshake. On CRC, a passthrough OpenShift Route bridges the default router (HAProxy) to the Gateway API pod, simulating the L4 TCP LoadBalancer that a production cluster would provide.
2. **Gateway to Pod.** BackendTLSPolicy instructs the Gateway to establish a TLS connection to the backend pod, verifying the pod's certificate against the CA in the `openshell-backend-ca` ConfigMap. The pod's TLS remains enabled (no `disableTls` needed). BackendTLSPolicy requires OpenShift 4.22+.
3. **Fallback.** If BackendTLSPolicy is not supported by the cluster's gateway controller, the control plane SHALL skip BackendTLSPolicy creation and log a warning. The gateway pod's TLS configuration would need to be disabled manually in this case.

### Route Hostname Convention

GRPCRoute hostnames follow the pattern: `<gateway-name>-<namespace>.acpgw.<base-domain>`

Examples:
- `openshell-gateway-tenant-a.acpgw.apps-crc.testing`
- `openshell-gateway-tenant-b.acpgw.apps.cluster.example.com`

The `acpgw.` subdomain segment distinguishes Gateway API routes from traditional OpenShift Routes (`*.apps-crc.testing`). On CRC, dnsmasq resolves all subdomains of `apps-crc.testing` (including `*.acpgw.apps-crc.testing`) to the CRC VM IP.

---

## Requirements

### Requirement: Gateway as API Resource

Gateway SHALL be a first-class ACP resource kind, persisted in PostgreSQL and exposed via the REST API under the project scope. The Gateway resource declares that a project namespace should have an OpenShell gateway deployed with specific configuration.

#### Scenario: Create a Gateway via acpctl apply

- GIVEN a kustomize overlay containing a `gateway.yaml`:
  ```yaml
  kind: Gateway
  name: openshell-gateway
  project: tenant-a
  cluster: us-east-gw-1
  image: ghcr.io/nvidia/openshell:v0.0.70
  serverDnsNames:
    - openshell-gateway.tenant-a.svc.cluster.local
  config: |
    [openshell.gateway]
    bind_address = "0.0.0.0:8080"
  ```
- WHEN a user runs `acpctl apply -k overlays/tenant-a/`
- THEN the CLI SHALL render the kustomization and POST the Gateway resource to the API server
- AND the API server SHALL persist the Gateway in PostgreSQL
- AND the API server SHALL emit a gRPC watch event for the new Gateway
- AND the GatewayReconciler SHALL receive the event and deploy gateway K8s resources to the `tenant-a` namespace

#### Scenario: Update a Gateway via overlay patch

- GIVEN a Gateway already exists for `tenant-a` with image `v0.0.70`
- AND a kustomize patch changes the image to `v0.0.71`
- WHEN a user runs `acpctl apply -k overlays/tenant-a/`
- THEN the CLI SHALL PATCH the existing Gateway resource
- AND the GatewayReconciler SHALL detect the change and update the gateway Deployment

#### Scenario: Gateway without a corresponding Project

- GIVEN a Gateway resource references project `nonexistent`
- AND no Project named `nonexistent` exists
- WHEN the Gateway is applied
- THEN the API server SHALL accept and persist the Gateway (eventual consistency)
- AND the GatewayReconciler SHALL log a warning and skip reconciliation until the Project (and namespace) exists

---

### Requirement: Shared Kustomize Library

The kustomize rendering engine SHALL be extracted from `acpctl apply/cmd.go` into a shared library package. This library SHALL be consumed by both the CLI (`acpctl apply`) and the ApplicationReconciler.

#### Scenario: Library extraction

- GIVEN the kustomize engine currently lives in `components/ambient-cli/cmd/acpctl/apply/cmd.go`
- WHEN the shared library is created
- THEN it SHALL be placed in a package accessible to both the CLI and the control plane (e.g., `components/ambient-sdk/go-sdk/kustomize/`)
- AND it SHALL expose functions for: loading a kustomization directory, resolving bases, merging resources, applying strategic-merge patches, and producing a flat manifest stream
- AND the existing `acpctl apply` command SHALL be refactored to use the shared library
- AND the ApplicationReconciler SHALL be updated to use the shared library for rendering

#### Scenario: Supported kinds

- GIVEN the shared kustomize library renders manifests
- THEN it SHALL support the following ACP resource kinds:
  - `Project`
  - `Agent`
  - `Credential`
  - `RoleBinding`
  - `Gateway` *(new)*
  - `Policy` *(new — project-scoped sandbox policy containing upstream OpenShell `SandboxPolicy` JSON)*
- AND documents with unrecognized `kind` values SHALL be skipped with a warning

#### Scenario: Unit testability

- GIVEN the shared kustomize library
- THEN it SHALL be fully unit-testable without a running cluster or API server
- AND tests SHALL cover: base resolution, resource merging, strategic-merge patch semantics (scalar overwrite, map merge, sequence replace), `--dry-run` output, multi-document YAML, kind filtering, and error cases (missing bases, invalid YAML, circular references)

---

### Requirement: GatewayReconciler

The control plane SHALL include a GatewayReconciler in `internal/reconciler/` that watches Gateway resource events via the gRPC informer and reconciles them into Kubernetes gateway deployments. This replaces the `internal/gateway/` package and the ConfigMap watcher.

#### Scenario: Gateway ADDED event

- GIVEN the GatewayReconciler receives a Gateway ADDED event
- AND the target namespace exists (created by ProjectReconciler)
- WHEN the reconciler processes the event
- THEN it SHALL validate the Gateway configuration (image reference, DNS names, TOML config)
- AND it SHALL apply gateway K8s manifests to the namespace: StatefulSet, Service, ServiceAccount, RBAC, certgen Job, ConfigMap, NetworkPolicy
- AND all resources SHALL carry the label `ambient-code.io/managed-by=ambient-control-plane`
- AND the reconciler SHALL use update-or-create semantics (SSA or equivalent)

#### Scenario: Gateway MODIFIED event

- GIVEN the GatewayReconciler receives a Gateway MODIFIED event
- WHEN the reconciler processes the event
- THEN it SHALL detect changes (image version, config, DNS names)
- AND it SHALL update the affected K8s resources
- AND the update SHALL be a rolling update for StatefulSets (zero downtime)

#### Scenario: Gateway DELETED event

- GIVEN the GatewayReconciler receives a Gateway DELETED event
- WHEN the reconciler processes the event
- THEN it SHALL delete gateway K8s resources from the namespace
- AND it SHALL NOT delete the namespace itself (namespace lifecycle is owned by ProjectReconciler)

#### Scenario: Validation failure

- GIVEN a Gateway resource with an invalid image reference or malformed TOML config
- WHEN the GatewayReconciler processes the event
- THEN it SHALL log a validation error with the Gateway name and project
- AND it SHALL NOT apply any K8s resources
- AND it SHALL retry on the next reconciliation cycle

#### Scenario: Namespace not yet ready

- GIVEN the GatewayReconciler receives a Gateway event
- AND the target namespace does not exist yet (ProjectReconciler hasn't processed the Project)
- WHEN the reconciler processes the event
- THEN it SHALL log a warning and skip reconciliation
- AND it SHALL retry when the namespace becomes available

---

### Requirement: Gateway Manifest Templating

The GatewayReconciler SHALL load gateway resource manifests from the container filesystem and apply namespace-specific substitutions. This reuses the existing manifest loading and templating logic from the `internal/gateway/manifests.go` module.

#### Scenario: Load gateway manifests from filesystem

- GIVEN the ACP container includes gateway manifests at `/manifests/gateway/`
- WHEN the GatewayReconciler loads manifests
- THEN it SHALL read all YAML files from the manifests directory
- AND it SHALL parse each file into Kubernetes resource objects
- AND it SHALL substitute `NAMESPACE_PLACEHOLDER` with the target namespace name
- AND it SHALL substitute `IMAGE_PLACEHOLDER` with the Gateway resource's `image` field

#### Scenario: Required manifest files missing

- GIVEN the `/manifests/gateway/` directory is missing or empty
- WHEN the GatewayReconciler attempts to load manifests
- THEN it SHALL log an error and fail gracefully
- AND it SHALL NOT crash the control plane

---

### Requirement: TLS Certificate Management via cert-manager

The GatewayReconciler SHALL support two certificate generation strategies: the default `pkiInitJob` (a one-shot Job using the gateway image's `generate-certs` command) and `certManager` (delegating to the [cert-manager](https://cert-manager.io/) operator). When cert-manager is available on the cluster, it SHALL be the preferred strategy. This follows the [NVIDIA OpenShell Managing Certificates guide](https://docs.nvidia.com/openshell/kubernetes/managing-certificates).

**Why cert-manager over pkiInitJob:** The pkiInitJob generates certificates once as a Kubernetes Job. If certificates expire, a manual re-run is required. cert-manager automates certificate lifecycle — issuance, renewal before expiry, and secret rotation — without operator intervention. cert-manager also integrates with external CAs (ACME, Vault, etc.) for production deployments.

**Cluster prerequisite:** cert-manager (v1.20+ recommended) must be installed cluster-wide by an administrator before gateways can use it. This is analogous to the agent-sandbox controller — a cluster-level prerequisite, not something ACP installs per-gateway. In test environments (Kind, CRC), cert-manager SHALL be installed during `make kind-up` and `make crc-up` at the same time as the agent-sandbox controller.

#### Scenario: cert-manager installed during test environment setup

- GIVEN a developer runs `make kind-up` or `make crc-up`
- WHEN the setup script installs cluster prerequisites
- THEN it SHALL install cert-manager (via `kubectl apply -f` from the cert-manager release manifests, with CRDs enabled)
- AND it SHALL wait for the cert-manager controller deployment to reach ready state (analogous to waiting for the agent-sandbox controller)
- AND cert-manager SHALL be installed in the `cert-manager` namespace
- AND this installation SHALL occur alongside the agent-sandbox controller installation (both are cluster-scoped prerequisites)

#### Scenario: Gateway configured to use cert-manager

- GIVEN cert-manager is installed on the cluster (Certificate, Issuer CRDs are available)
- AND the GatewayReconciler detects cert-manager availability (via API discovery for `cert-manager.io` API group)
- WHEN the reconciler provisions a gateway
- THEN it SHALL create cert-manager resources for TLS certificate lifecycle:
  - A self-signed `Issuer` (`openshell-selfsigned`) in the project namespace to bootstrap the CA
  - A `Certificate` for the CA (`openshell-ca`, ECDSA P256, creates `openshell-ca-tls` Secret)
  - A CA-backed `Issuer` (`openshell-ca-issuer`) that uses the CA certificate
  - A server `Certificate` (`openshell-server`, creates `openshell-server-tls` Secret with `ca.crt`, `tls.crt`, `tls.key`, with DNS SANs from `serverDnsNames`)
  - A client `Certificate` (`openshell-client`, creates `openshell-client-tls` Secret)
- AND server and client Certificates SHALL set `privateKey.rotationPolicy: Always` so cert-manager can regenerate keys when taking over secrets previously created by the certgen job
- AND cert-manager SHALL handle automatic renewal before certificate expiry

**Coexistence with certgen job:** cert-manager handles TLS certificate lifecycle (issuance, renewal, rotation). The certgen job handles JWT key generation (`signing.pem`, `public.pem`, `kid` in the `openshell-gateway-jwt-keys` Secret). Both run: cert-manager creates TLS secrets, then certgen checks if they exist (skipping TLS) and only creates JWT keys. The certgen job remains in the deploy order for all gateways regardless of cert-manager availability.

#### Scenario: Fallback to pkiInitJob when cert-manager is not available

- GIVEN cert-manager is NOT installed on the cluster
- WHEN the GatewayReconciler provisions a gateway
- THEN the certgen job SHALL handle both TLS certificate generation AND JWT key generation (existing behavior)
- AND this SHALL be backward compatible with all existing deployments

#### Scenario: cert-manager detection

- GIVEN the GatewayReconciler initializes
- WHEN it checks for cert-manager availability
- THEN it SHALL use API discovery to check for the `cert-manager.io` API group
- AND detection SHALL occur once at startup (alongside OpenShift detection), not per-reconciliation
- AND the result SHALL be stored as a `hasCertManager bool` field on the reconciler

#### Scenario: cert-manager resources built inline

- GIVEN the GatewayReconciler uses cert-manager
- WHEN it applies certificate resources
- THEN the cert-manager Issuer and Certificate resources SHALL be constructed as inline unstructured objects in the reconciler code (matching the Route creation pattern), not loaded from YAML manifest templates
- AND they SHALL include appropriate SANs derived from the gateway's `serverDnsNames`
- AND the certgen job manifests SHALL remain at `manifests/gateway/certgen-job.yaml` and continue to run (for JWT key generation)

#### Scenario: RBAC for cert-manager resources

- GIVEN the control plane needs to create and manage cert-manager resources
- THEN the ClusterRole SHALL include:
  ```yaml
  - apiGroups: ["cert-manager.io"]
    resources: ["issuers", "certificates"]
    verbs: ["get", "list", "create", "update", "patch", "delete"]
  ```

---

### Requirement: Trusted CA Bundle Injection

Gateways with OIDC enabled need to reach the identity provider's OIDC discovery endpoint over HTTPS. In environments where the IdP is exposed through an ingress controller with a non-public CA certificate (e.g., OpenShift CRC, private PKI), the gateway pod's default trust store will not include the required CA and OIDC initialization will fail.

The control plane SHALL support an optional `gateway-trusted-ca` ConfigMap in the ACP namespace. When present, it is copied to each tenant namespace and mounted into the gateway StatefulSet so that the gateway process trusts the additional CA certificates.

#### Scenario: Trusted CA ConfigMap present in ACP namespace

- GIVEN a ConfigMap named `gateway-trusted-ca` exists in the ACP namespace (e.g., `ambient-code`)
- AND the ConfigMap has a `ca-bundle.crt` key containing one or more PEM-encoded CA certificates
- WHEN the GatewayReconciler reconciles a gateway in a tenant namespace
- THEN it SHALL copy the `gateway-trusted-ca` ConfigMap to the tenant namespace (create-or-update pattern)
- AND it SHALL add a volume to the gateway StatefulSet mounting the `ca-bundle.crt` key at `/etc/pki/tls/certs/ca-bundle.crt` (read-only, using `subPath`)
- AND it SHALL add an `SSL_CERT_FILE` environment variable set to `/etc/pki/tls/certs/ca-bundle.crt` on the gateway container
- AND the mounted CA bundle SHALL be used by the gateway's TLS client for OIDC discovery and JWKS fetching

#### Scenario: Trusted CA ConfigMap absent

- GIVEN no ConfigMap named `gateway-trusted-ca` exists in the ACP namespace
- WHEN the GatewayReconciler reconciles a gateway
- THEN it SHALL NOT add any CA volume or `SSL_CERT_FILE` env var to the gateway StatefulSet
- AND the gateway SHALL use its built-in trust store (default behavior)
- AND this SHALL be the default for environments with publicly-trusted IdP certificates (e.g., production with a public CA)

#### Scenario: Trusted CA ConfigMap updated

- GIVEN a `gateway-trusted-ca` ConfigMap exists and has been updated (new certificates added or removed)
- WHEN the GatewayReconciler runs its next reconciliation cycle
- THEN it SHALL update the copy in the tenant namespace
- AND the gateway pod SHALL pick up the new CA bundle on its next restart

#### Scenario: CRC test environment setup

- GIVEN a CRC (OpenShift Local) cluster where Keycloak is exposed via an OpenShift Route with a self-signed ingress CA
- WHEN a developer runs the CRC setup automation
- THEN the setup script SHALL extract the CRC ingress CA from the `router-ca` Secret in `openshift-ingress-operator` namespace
- AND it SHALL combine the ingress CA with the system CA bundle (from an OpenShift-injected ConfigMap with `config.openshift.io/inject-trusted-cabundle` annotation)
- AND it SHALL create the `gateway-trusted-ca` ConfigMap in the ACP namespace with the combined bundle
- AND subsequent gateway reconciliation SHALL automatically inject the CA into gateway pods

**Design rationale:** The OIDC issuer URL must be identical inside and outside the cluster (OpenShell requirement — see [Gateway Auth: OIDC](https://docs.nvidia.com/openshell/reference/gateway-auth#oidc)). On CRC, the external Keycloak Route uses HTTPS with the CRC ingress controller's self-signed CA. The gateway must reach this same URL, so it needs the ingress CA in its trust store. Using an in-cluster HTTP URL is not viable because the issuer returned in OIDC discovery would not match. This approach generalizes to any environment where the IdP uses a private CA.

---

### Requirement: Gateway Configuration Validation

The GatewayReconciler SHALL validate Gateway resource fields before applying K8s manifests. Validation logic is reused from `internal/gateway/validation.go`.

#### Scenario: Valid Gateway configuration

- GIVEN a Gateway with a valid image reference, RFC-1123-compliant DNS names, and valid TOML config
- WHEN the GatewayReconciler validates the configuration
- THEN validation SHALL pass and reconciliation SHALL proceed

#### Scenario: Invalid image reference

- GIVEN a Gateway with an image reference containing invalid characters
- WHEN the GatewayReconciler validates the configuration
- THEN validation SHALL fail with a descriptive error
- AND the Gateway SHALL not be reconciled until the configuration is corrected

#### Scenario: Invalid DNS name

- GIVEN a Gateway with a `serverDnsNames` entry that violates RFC 1123
- WHEN the GatewayReconciler validates the configuration
- THEN validation SHALL fail with a descriptive error listing the invalid DNS name

---

### Requirement: Kustomize Overlay Structure for Gateways

Gateway resources SHALL be expressible in the existing `examples/` kustomize overlay structure alongside Project, Agent, and Credential resources.

#### Scenario: Gateway in a tenant overlay

- GIVEN the directory `examples/overlays/tenant-a/`:
  ```
  kustomization.yaml
  project.yaml          # kind: Project
  gateway.yaml          # kind: Gateway
  providers/
    github.yaml         # kind: Credential
  ```
- AND `kustomization.yaml` references all resources:
  ```yaml
  kind: Kustomization
  bases:
    - ../../base
  resources:
    - project.yaml
    - gateway.yaml
  ```
- WHEN a user runs `acpctl apply -k examples/overlays/tenant-a/`
- THEN the Project, Gateway, Agents (from base), and Credentials SHALL all be applied in order
- AND the ProjectReconciler SHALL create the namespace
- AND the GatewayReconciler SHALL deploy the gateway into that namespace

#### Scenario: Gateway base with per-tenant patches

- GIVEN a base gateway configuration in `examples/base/gateway.yaml`:
  ```yaml
  kind: Gateway
  name: openshell-gateway
  image: ghcr.io/nvidia/openshell:v0.0.70
  serverDnsNames: []
  ```
- AND a tenant overlay patches the DNS names:
  ```yaml
  kind: Gateway
  name: openshell-gateway
  project: tenant-a
  serverDnsNames:
    - openshell-gateway.tenant-a.svc.cluster.local
  ```
- WHEN the kustomize engine resolves the overlay
- THEN the merged Gateway SHALL have the base image and the overlay's DNS names and project

---

### Requirement: Elimination of ConfigMap-Based Provisioning

The ConfigMap-based `platform-config` gateway provisioning path SHALL be removed.

#### Scenario: Removed components

- WHEN the migration is complete
- THEN the following SHALL be deleted:
  - `internal/gateway/config.go` — ConfigMap schema, loader, watcher
  - `internal/gateway/reconciler.go` — ConfigMap-driven gateway reconciler (logic moves to GatewayReconciler)
  - `initGatewayProvisioning()` in `main.go` — ConfigMap watcher startup
  - `components/manifests/overlays/kind/platform-config.yaml` — ConfigMap overlay
- AND the following SHALL be preserved and reused by the GatewayReconciler:
  - `internal/gateway/manifests.go` — manifest loading and templating
  - `internal/gateway/validation.go` — configuration validation

#### Scenario: No ConfigMap required for gateway mode

- GIVEN `OPENSHELL_USE_GATEWAY=true`
- WHEN the control plane starts
- THEN it SHALL NOT look for a `platform-config` ConfigMap
- AND gateway provisioning SHALL be driven entirely by Gateway API resources received via gRPC watch events

---

### Requirement: Payload Delivery via SSH-over-gRPC

When the control plane needs to write payload files (`.mcp.json`, `CLAUDE.md`, credential configs) into a running sandbox, it SHALL use the OpenShell SSH-over-gRPC mechanism rather than `ExecSandbox`. Sandbox containers use a read-only root filesystem, so `ExecSandbox`-based writes (which run as the sandbox user) fail with "Permission denied". The SSH path routes through the supervisor's embedded SSH server (russh), which runs as root and can write to any path.

**Data path:**
```
Control Plane
  → gRPC: CreateSshSession(sandbox_id) → authorization token
  → gRPC: ForwardTcp (bidirectional stream)
      → TcpForwardInit: sandbox_id, service_id, SshRelayTarget, token
      → SSH handshake over the gRPC stream (net.Conn adapter)
      → Validate sandbox_path against allowlist regex (reject shell metacharacters, traversal)
      → SSH session: "mkdir -p '<dir>' && cat > '<path>'" with content piped to stdin
  → Repeat for each payload file over the same SSH connection
```

This follows the same pattern used by the OpenShell CLI for file uploads (`ssh_tar_upload` in `openshell-cli`). A single SSH connection is established per upload batch — individual payloads each open an SSH session (channel) within that connection.

**Path validation:** Before constructing the shell command, each `sandbox_path` is validated against the regex `^/[a-zA-Z0-9/_.\\-]+$` and checked for `..` traversal segments. Paths that fail validation are rejected before any SSH session is opened. This prevents shell injection via crafted payload paths in agent ConfigMaps. The path constraint is defined in `agent-sandbox-config.spec.md` § Payloads.

**SSH security model:** The SSH connection uses `InsecureIgnoreHostKey()` (no host key verification) and `ssh.Password("")` (no-credential auth). This matches the OpenShell upstream pattern:
- The sandbox SSH server (`openshell-supervisor-process/src/ssh.rs`) generates ephemeral Ed25519 host keys on each boot — there is no stable identity to verify
- The server unconditionally accepts all auth (`auth_none` and `auth_publickey` both return `Auth::Accept`)
- The OpenShell CLI uses the equivalent: `StrictHostKeyChecking=no` + `UserKnownHostsFile=/dev/null` (`openshell-cli/src/ssh.rs`)
- The OpenShell server-side `russh` client uses `authenticate_none("sandbox")` (`openshell-server/src/grpc/sandbox.rs`)

Security is enforced at layers below SSH:
1. **Unix socket permissions** (0600, root-only) on the supervisor's SSH listener — the sandbox user cannot connect directly
2. **gRPC session tokens** — time-limited UUIDs validated by `ForwardTcp` before relay streams are opened
3. **mTLS** on the gRPC transport between control plane and gateway

**Implementation:** `internal/openshell/ssh_upload.go` — `GatewayClient.UploadPayloads()`

#### Scenario: Upload payloads to a running sandbox

- GIVEN a sandbox is in `SANDBOX_PHASE_READY` state
- AND the session has one or more payload files to inject
- WHEN the control plane delivers payloads
- THEN it SHALL call `CreateSshSession` on the gateway to obtain an authorization token
- AND it SHALL open a `ForwardTcp` bidirectional gRPC stream
- AND it SHALL send a `TcpForwardInit` frame with `SshRelayTarget` and the authorization token
- AND it SHALL perform an SSH handshake over the gRPC stream using `golang.org/x/crypto/ssh`
- AND it SHALL validate each `sandbox_path` against the path allowlist (`^/[a-zA-Z0-9/_.\\-]+$`, no `..` traversal) before constructing any shell command
- AND it SHALL write each payload by executing `mkdir -p '<dir>' && cat > '<path>'` via an SSH session with the file content piped to stdin
- AND it SHALL reuse the same SSH connection for all payloads in the batch

#### Scenario: SSH session creation fails

- GIVEN the control plane calls `CreateSshSession` for a sandbox
- AND the gateway returns an error (e.g., sandbox not found, gateway unavailable)
- WHEN the control plane handles the error
- THEN the control plane SHALL fail the session with a descriptive error message
- AND the control plane SHALL evict the cached gRPC connection if the error indicates the gateway is unavailable

#### Scenario: Payload write fails mid-batch

- GIVEN the control plane is writing payloads via SSH
- AND a write fails (SSH session error, command non-zero exit)
- WHEN the control plane handles the error
- THEN the control plane SHALL fail the session immediately
- AND the control plane SHALL NOT continue writing remaining payloads
- AND the error message SHALL include the file path that failed

---

### Requirement: Gateway Deployment Resources

For each Gateway resource, the GatewayReconciler SHALL deploy the following Kubernetes resources into the project namespace:

All gateway resources SHALL use fixed names:
- StatefulSet: `openshell-gateway`
- Service: `openshell-gateway`
- ServiceAccount: `openshell-gateway`
- Role: `openshell-gateway`
- RoleBinding: `openshell-gateway`

All gateway resources SHALL carry the following labels:
- `app.kubernetes.io/name=openshell`
- `app.kubernetes.io/component=gateway`
- `app.kubernetes.io/managed-by=agent-control-plane`
- `ambient-code.io/managed=true`

The gateway StatefulSet SHALL specify:
- **SecurityContext:** `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, capabilities `drop: [ALL]`, `seccompProfile.type: RuntimeDefault`
- **Resource requests:** `cpu: 100m`, `memory: 256Mi`
- **Resource limits:** `cpu: 500m`, `memory: 512Mi`

#### Scenario: Deploy gateway to project namespace

- GIVEN a Gateway resource exists for project `tenant-a`
- AND the namespace `tenant-a` exists (created by ProjectReconciler)
- WHEN the GatewayReconciler reconciles
- THEN it SHALL apply all gateway manifests with namespace set to `tenant-a`
- AND it SHALL use update-or-create semantics (never create-and-ignore-AlreadyExists)

#### Scenario: Gateway already exists (idempotency)

- GIVEN `tenant-a` has an OpenShell gateway already deployed
- WHEN the GatewayReconciler reconciles again
- THEN it SHALL apply the latest configuration using SSA or equivalent
- AND it SHALL NOT create duplicate resources

---

### Requirement: OpenShift-Specific Gateway Provisioning

When the control plane detects that it is running on an OpenShift cluster (the `route.openshift.io` API group is available), the GatewayReconciler SHALL adjust the gateway deployment to conform to OpenShift's SecurityContextConstraints (SCC) and PodSecurity admission requirements. These adjustments follow the [NVIDIA OpenShell OpenShift deployment guide](https://docs.nvidia.com/openshell/kubernetes/openshift).

**Key difference from vanilla Kubernetes:** OpenShift enforces the `restricted` PodSecurity standard by default. The OpenShell Helm chart's hardcoded `fsGroup` and `runAsUser` values conflict with OpenShift's SCC admission controller, which assigns UIDs and GIDs from the namespace's allocated ranges. Additionally, sandbox pods require the `privileged` SCC to function correctly.

**TLS is NOT disabled.** The NVIDIA docs show `--set server.disableTls=true` for evaluation scenarios. ACP does NOT use this setting because BackendTLSPolicy re-encrypts traffic from the networking Gateway to the pod, which requires the gateway to serve TLS. The gateway's self-signed certificate (generated by the certgen Job or cert-manager) is used for the backend TLS segment.

#### Scenario: SCC binding for sandbox service account

- GIVEN the GatewayReconciler is deploying a gateway to an OpenShift cluster
- AND the target namespace exists
- WHEN the reconciler applies gateway manifests
- THEN it SHALL ensure that the `privileged` SCC is bound to the `openshell-sandbox` ServiceAccount in the target namespace
- AND this binding SHALL be applied BEFORE the StatefulSet is created (so sandbox pods can schedule)
- AND the binding SHALL be equivalent to: `oc adm policy add-scc-to-user privileged -z openshell-sandbox -n <namespace>`
- AND the reconciler SHALL use update-or-create semantics for the SCC binding (idempotent)

#### Scenario: Pod security context adjustments for OpenShift

- GIVEN the GatewayReconciler is deploying a gateway to an OpenShift cluster
- WHEN the reconciler applies gateway manifests
- THEN it SHALL clear the `podSecurityContext.fsGroup` field (set to null/omit) so that OpenShift's SCC admission controller assigns the fsGroup from the namespace's allocated UID range
- AND it SHALL clear the `securityContext.runAsUser` field (set to null/omit) so that OpenShift's SCC admission controller assigns the UID from the namespace's allocated range
- AND all gateway containers SHALL set `securityContext.seccompProfile.type` to `RuntimeDefault` to satisfy the `restricted:latest` PodSecurity standard

#### Scenario: seccompProfile on all gateway containers

- GIVEN the GatewayReconciler deploys a gateway (on any cluster, not just OpenShift)
- WHEN the reconciler constructs the StatefulSet pod spec
- THEN ALL containers SHALL include `securityContext.seccompProfile.type: RuntimeDefault`
- AND this satisfies both OpenShift's `restricted:latest` PodSecurity standard and Kubernetes PodSecurity Standards (PSS) best practices

#### Scenario: Gateway deployment on vanilla Kubernetes (unchanged)

- GIVEN the GatewayReconciler is deploying a gateway to a non-OpenShift cluster (e.g., Kind, EKS, GKE)
- WHEN the reconciler applies gateway manifests
- THEN it SHALL NOT modify `podSecurityContext.fsGroup` or `securityContext.runAsUser` (the chart defaults are correct for non-OpenShift)
- AND it SHALL NOT create SCC bindings (SCC is an OpenShift-only concept)
- AND the `seccompProfile.type: RuntimeDefault` SHALL still be set (it is valid on all Kubernetes clusters)

#### Scenario: Platform detection reuse

- GIVEN the GatewayReconciler already detects OpenShift for SCC/security adjustments
- AND the GatewayReconciler detects Gateway API availability for GRPCRoute provisioning
- WHEN the reconciler initializes
- THEN it SHALL reuse the same `isOpenShift` detection result for SCC/security adjustments
- AND it SHALL reuse the same `hasGatewayAPI` detection result for GRPCRoute provisioning
- AND both detections SHALL occur once at startup, not per-reconciliation

---

### Requirement: Cross-Cluster Gateway Exposure

When a Gateway is deployed on a cluster different from where sessions run, the GatewayReconciler SHALL create an externally reachable Service to enable cross-cluster gRPC connectivity.

#### Scenario: Gateway on dedicated gateway cluster

- GIVEN a Gateway resource with `cluster_id` set to a `role=gateway` cluster
- AND sessions will run on `role=workload` clusters
- WHEN the GatewayReconciler reconciles the Gateway
- THEN it SHALL deploy gateway K8s resources on the target cluster using the `ClusterClientPool`
- AND it SHALL create a `LoadBalancer` Service (or Ingress/Route, depending on cluster capabilities) exposing the gateway's gRPC port externally
- AND it SHALL store the external endpoint URL in the Gateway's `annotations` as `ambient-code.io/gateway-external-url`
- AND the annotation SHALL be written to the API server (PostgreSQL), not just to the Kubernetes resource

#### Scenario: Gateway on local cluster (backward compatible)

- GIVEN a Gateway resource with `cluster_id` null
- WHEN the GatewayReconciler reconciles the Gateway
- THEN it SHALL deploy gateway K8s resources on the local cluster
- AND it SHALL NOT create an external Service (intra-cluster DNS is sufficient)
- AND the `ambient-code.io/gateway-external-url` annotation SHALL NOT be set

#### Scenario: Namespace provisioning on remote cluster

- GIVEN a Gateway targets a remote cluster via `cluster_id`
- AND the project namespace does not yet exist on that cluster
- WHEN the GatewayReconciler processes the Gateway event
- THEN it SHALL create the namespace on the remote cluster using the `ClusterClientPool`
- AND it SHALL apply the same managed labels as the local ProjectReconciler (`ambient-code.io/managed=true`, etc.)

---

### Requirement: Gateway Deployment Failure Handling

When gateway deployment fails (e.g., ImagePullBackOff, insufficient permissions), the GatewayReconciler SHALL log the error and retry on subsequent reconcile cycles without crashing.

#### Scenario: Image pull failure

- GIVEN a Gateway resource specifies an image that does not exist
- WHEN Kubernetes attempts to pull the image
- THEN the StatefulSet SHALL enter ImagePullBackOff state
- AND the GatewayReconciler SHALL log an error with the Gateway name, project, and failure reason
- AND the GatewayReconciler SHALL retry on the next reconcile cycle

#### Scenario: Insufficient RBAC permissions

- GIVEN the CP ServiceAccount does NOT have permission to create StatefulSets in a namespace
- WHEN the GatewayReconciler attempts to apply gateway manifests
- THEN the Kubernetes API SHALL return a Forbidden error
- AND the GatewayReconciler SHALL log an error and continue processing other Gateway resources

---

### Requirement: Separation from Agent Configuration

Gateway provisioning SHALL be independent of agent definitions. Agent-specific configuration (schedules, prompts, policies) is out of scope for this specification.

---

### Requirement: Gateway OIDC API Fields

The Gateway API resource SHALL accept an optional `oidc` object containing OIDC configuration fields. These fields map directly to the upstream OpenShell `server.oidc.*` helm values. When `oidc` is absent or `oidc.issuer` is empty, OIDC is disabled.

**Fields:**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `oidc.issuer` | string | Yes (to enable OIDC) | `""` | OIDC issuer URL; empty disables OIDC |
| `oidc.audience` | string | No | `"openshell-cli"` | Expected `aud` claim value in JWT |
| `oidc.jwks_ttl` | integer | No | `3600` | JWKS key cache retention in seconds |
| `oidc.roles_claim` | string | No | `""` | Dot-delimited path to roles array in JWT claims |
| `oidc.admin_role` | string | No | `""` | Role name conferring admin access |
| `oidc.user_role` | string | No | `""` | Role name conferring standard user access |
| `oidc.scopes_claim` | string | No | `""` | Dot-delimited path to scopes array in JWT claims |

#### Scenario: Gateway with OIDC enabled via kustomize

- GIVEN a Gateway resource in a kustomize overlay:
  ```yaml
  kind: Gateway
  name: openshell-gateway
  project: tenant-a
  image: ghcr.io/nvidia/openshell/gateway:0.0.80
  server_dns_names:
    - openshell-gateway.tenant-a.svc.cluster.local
  oidc:
    issuer: https://keycloak.example.com/realms/ambient-code
    audience: openshell-cli
    roles_claim: realm_access.roles
    admin_role: openshell-admin
    user_role: openshell-user
  ```
- WHEN the user runs `acpctl apply -k`
- THEN the API server SHALL persist the Gateway with OIDC configuration
- AND the GatewayReconciler SHALL generate a `gateway.toml` containing the `[openshell.gateway.oidc]` section

#### Scenario: Gateway without OIDC (default)

- GIVEN a Gateway resource with no `oidc` field
- WHEN the GatewayReconciler reconciles
- THEN the `gateway.toml` SHALL NOT contain an `[openshell.gateway.oidc]` section
- AND `allow_unauthenticated_users` SHALL remain `true`
- AND gateway behavior SHALL be identical to the current unauthenticated mode

#### Scenario: Patch OIDC configuration on existing gateway

- GIVEN a Gateway resource with OIDC disabled
- WHEN the user patches the Gateway with OIDC fields:
  ```json
  {"oidc": {"issuer": "https://idp.example.com/realms/openshell"}}
  ```
- THEN the API server SHALL update the Gateway's OIDC configuration
- AND the GatewayReconciler SHALL detect the change and update the `gateway.toml`
- AND the gateway StatefulSet SHALL restart to pick up the new configuration

#### Scenario: Disable OIDC by clearing issuer

- GIVEN a Gateway resource with OIDC enabled
- WHEN the user patches the Gateway with `{"oidc": {"issuer": ""}}`
- THEN the GatewayReconciler SHALL remove the `[openshell.gateway.oidc]` section from `gateway.toml`
- AND `allow_unauthenticated_users` SHALL be set back to `true`

---

### Requirement: OIDC Role Validation

When OIDC role-based access control is configured, both `admin_role` and `user_role` MUST be set, or both MUST be empty. Setting only one is not supported per the upstream OpenShell constraint.

#### Scenario: Valid RBAC configuration

- GIVEN a Gateway with `oidc.admin_role = "openshell-admin"` and `oidc.user_role = "openshell-user"`
- WHEN the GatewayReconciler validates the configuration
- THEN validation SHALL pass

#### Scenario: Valid auth-only configuration (no RBAC)

- GIVEN a Gateway with `oidc.issuer` set and both `oidc.admin_role` and `oidc.user_role` empty
- WHEN the GatewayReconciler validates the configuration
- THEN validation SHALL pass
- AND any valid JWT from the configured issuer SHALL be accepted with no role-based distinctions

#### Scenario: Invalid partial RBAC configuration

- GIVEN a Gateway with `oidc.admin_role = "openshell-admin"` and `oidc.user_role = ""`
- WHEN the GatewayReconciler validates the configuration
- THEN validation SHALL fail with a descriptive error: both `admin_role` and `user_role` must be set, or both must be empty
- AND the Gateway SHALL NOT be reconciled until corrected

---

### Requirement: OIDC Configuration in gateway.toml

When a Gateway has OIDC enabled (non-empty `oidc.issuer`), the GatewayReconciler SHALL inject the OIDC configuration into the `gateway.toml` ConfigMap. This applies whether the user provides a custom `config` field or uses the default template.

#### Scenario: OIDC section injected into default gateway.toml

- GIVEN a Gateway with OIDC enabled and no custom `config` field
- WHEN the GatewayReconciler generates the ConfigMap
- THEN `gateway.toml` SHALL contain:
  ```toml
  [openshell.gateway.auth]
  allow_unauthenticated_users = false

  [openshell.gateway.oidc]
  issuer       = "https://keycloak.example.com/realms/ambient-code"
  audience     = "openshell-cli"
  jwks_ttl     = 3600
  roles_claim  = "realm_access.roles"
  admin_role   = "openshell-admin"
  user_role    = "openshell-user"
  scopes_claim = ""
  ```
- AND `allow_unauthenticated_users` SHALL be `false` (overriding the default `true`)

#### Scenario: Custom config overrides bypass OIDC injection

- GIVEN a Gateway with OIDC enabled AND a custom `config` field (raw TOML)
- WHEN the GatewayReconciler generates the ConfigMap
- THEN the custom `config` SHALL be used verbatim as the `gateway.toml`
- AND the GatewayReconciler SHALL NOT inject the `[openshell.gateway.oidc]` section
- AND the user is responsible for including OIDC settings directly in the custom TOML

#### Scenario: Only non-empty OIDC fields written to TOML

- GIVEN a Gateway with only `oidc.issuer` set (all other fields at zero values)
- WHEN the GatewayReconciler generates the ConfigMap
- THEN `gateway.toml` SHALL contain the OIDC section with only non-empty/non-zero fields:
  - `issuer` = the configured value (always present when OIDC is enabled)
  - Other fields (audience, jwks_ttl, roles_claim, etc.) are omitted when empty/zero
- AND the upstream OpenShell gateway SHALL apply its own defaults for omitted fields

---

### Requirement: mTLS Disabled for OIDC Gateways

When OIDC is enabled on a gateway, mTLS (client certificate verification) SHALL be disabled. OIDC clients authenticate via Bearer tokens in the `Authorization` header — requiring client certificates is incompatible with OIDC authentication flows (CLI users, browser-based flows, and external service accounts do not possess gateway client certificates).

The GatewayReconciler SHALL remove the `client_ca_path` setting from the `[openshell.gateway.tls]` section when OIDC is enabled. Server-side TLS (`cert_path`, `key_path`) SHALL remain active for transport encryption.

#### Scenario: OIDC gateway has mTLS disabled

- GIVEN a Gateway with OIDC enabled (non-empty `oidc.issuer`)
- WHEN the GatewayReconciler generates the ConfigMap
- THEN `gateway.toml` SHALL NOT contain a `client_ca_path` setting in the `[openshell.gateway.tls]` section
- AND `cert_path` and `key_path` SHALL remain present (server TLS preserved)
- AND the gateway SHALL accept clients authenticating via Bearer tokens without requiring a client certificate

#### Scenario: Non-OIDC gateway retains mTLS

- GIVEN a Gateway with no OIDC configuration (or `oidc.issuer` is empty)
- WHEN the GatewayReconciler generates the ConfigMap
- THEN `gateway.toml` SHALL retain the `client_ca_path` setting in the `[openshell.gateway.tls]` section
- AND mTLS behavior SHALL be unchanged from the current default

---

### Requirement: OIDC Change Detection

The GatewayReconciler SHALL detect changes to OIDC configuration and trigger a gateway restart when OIDC settings change. OIDC changes are treated the same as TOML config changes.

#### Scenario: OIDC configuration changed

- GIVEN a running gateway with OIDC configured for issuer `https://old-idp.example.com`
- WHEN the Gateway is patched to use issuer `https://new-idp.example.com`
- THEN the GatewayReconciler SHALL update the ConfigMap with the new OIDC settings
- AND the StatefulSet SHALL receive a restart annotation to pick up the new config
- AND the gateway pods SHALL be recreated via rolling update

#### Scenario: OIDC enabled on previously unauthenticated gateway

- GIVEN a running gateway with no OIDC configuration
- WHEN the Gateway is patched to add OIDC fields
- THEN the GatewayReconciler SHALL update the ConfigMap to include the OIDC section
- AND `allow_unauthenticated_users` SHALL change from `true` to `false`
- AND the StatefulSet SHALL restart

---

### Requirement: Gateway API Detection

The control plane SHALL detect at startup whether a compatible networking Gateway is available for GRPCRoute provisioning. Detection checks for both the GRPCRoute CRD and a configured networking Gateway resource.

#### Scenario: Networking Gateway available

- GIVEN the control plane starts up
- AND the `gateway.networking.k8s.io` API group is available (GRPCRoute CRD exists)
- AND a Gateway resource named `acpgw` exists in the `openshift-ingress` namespace (or the namespace configured via `GATEWAY_API_GATEWAY_NAMESPACE` env var)
- AND the Gateway's `.status.conditions` includes `Accepted: True`
- THEN the control plane SHALL enable GRPCRoute provisioning for gateways
- AND the GatewayReconciler SHALL create GRPCRoute resources for gateways that have `route` configuration

#### Scenario: GRPCRoute CRD not available

- GIVEN the control plane starts up
- AND the `gateway.networking.k8s.io` API group does NOT include the `grpcroutes` resource
- THEN the control plane SHALL disable GRPCRoute provisioning
- AND the GatewayReconciler SHALL skip GRPCRoute creation for all gateways
- AND no warning or error SHALL be logged — this is normal operation on clusters without Gateway API

#### Scenario: Networking Gateway not found

- GIVEN the control plane starts up
- AND the GRPCRoute CRD exists
- AND no Gateway resource named `acpgw` exists in the configured namespace
- THEN the control plane SHALL disable GRPCRoute provisioning
- AND it SHALL log an info message indicating that no networking Gateway was found

#### Scenario: Gateway with route field on cluster without Gateway API

- GIVEN the control plane is running on a cluster without Gateway API
- AND a Gateway resource includes a `route` field
- WHEN the GatewayReconciler reconciles this Gateway
- THEN it SHALL accept the `route` field without validation errors (the field is valid but inert)
- AND it SHALL NOT attempt to create a GRPCRoute resource
- AND it SHALL NOT populate the `routeAddress` field

---

### Requirement: Gateway API Configuration

The control plane SHALL support configuration of the networking Gateway reference via environment variables.

#### Scenario: Default configuration

- GIVEN no Gateway API environment variables are set
- THEN the control plane SHALL use:
  - Gateway name: `acpgw`
  - Gateway namespace: `openshift-ingress`
  - Base domain: read from `ingresses.config.openshift.io/cluster` `.spec.domain`, falling back to `GATEWAY_API_BASE_DOMAIN` env var

#### Scenario: Custom configuration

- GIVEN environment variables are set:
  - `GATEWAY_API_GATEWAY_NAME=my-gateway`
  - `GATEWAY_API_GATEWAY_NAMESPACE=ingress-system`
  - `GATEWAY_API_BASE_DOMAIN=apps.example.com`
- THEN the control plane SHALL reference the Gateway `my-gateway` in `ingress-system`
- AND GRPCRoute hostnames SHALL use `apps.example.com` as the base domain

---

### Requirement: Gateway Route Configuration

The Gateway resource SHALL support an optional `route` field that declares external exposure via a GRPCRoute. When `route` is present and Gateway API is available, the GatewayReconciler SHALL create and reconcile a GRPCRoute in the project namespace.

#### Scenario: Gateway with explicit route host

- GIVEN a Gateway resource with route configuration:
  ```yaml
  kind: Gateway
  name: openshell-gateway
  project: tenant-a
  route:
    host: custom-gateway.acpgw.apps.example.com
  ```
- WHEN the GatewayReconciler reconciles this Gateway
- THEN it SHALL create a GRPCRoute in the `tenant-a` namespace with hostname `custom-gateway.acpgw.apps.example.com`
- AND the GRPCRoute SHALL reference the networking Gateway via parentRefs

#### Scenario: Gateway with auto-assigned route host

- GIVEN a Gateway resource with route configuration and no host:
  ```yaml
  kind: Gateway
  name: openshell-gateway
  project: tenant-a
  route: {}
  ```
- WHEN the GatewayReconciler reconciles this Gateway
- THEN it SHALL create a GRPCRoute with hostname `openshell-gateway-tenant-a.acpgw.<base-domain>`
- AND the hostname SHALL be derived from the gateway name, namespace, and cluster base domain

#### Scenario: Gateway without route configuration

- GIVEN a Gateway resource with no `route` field
- WHEN the GatewayReconciler reconciles this Gateway
- THEN it SHALL NOT create a GRPCRoute resource
- AND the gateway SHALL remain accessible only via cluster-internal DNS and `kubectl port-forward`

#### Scenario: Route removed from Gateway configuration

- GIVEN a Gateway that previously had a `route` field
- AND the `route` field is removed via PATCH
- WHEN the GatewayReconciler reconciles the updated Gateway
- THEN it SHALL delete the GRPCRoute, BackendTLSPolicy, and CA ConfigMap from the namespace
- AND it SHALL clear the Gateway's `routeAddress` field

---

### Requirement: GRPCRoute Resource Specification

The GRPCRoute SHALL be constructed with appropriate labels, parentRefs, and backendRefs for gRPC traffic routing.

#### Scenario: GRPCRoute resource structure

- GIVEN a Gateway with `route` configuration
- WHEN the GatewayReconciler creates the GRPCRoute
- THEN the GRPCRoute SHALL have the following structure:
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

#### Scenario: GRPCRoute accepted by Gateway

- GIVEN a GRPCRoute has been created
- WHEN the networking Gateway controller processes it
- THEN the GRPCRoute's `.status.parents[].conditions` SHALL include `Accepted: True`
- AND the hostname SHALL be routable through the networking Gateway

---

### Requirement: BackendTLSPolicy for Re-encrypt

The control plane SHALL create a BackendTLSPolicy to enable TLS verification from the networking Gateway to the gateway pod. This keeps the gateway pod's TLS enabled without requiring clients to trust the pod's self-signed CA.

#### Scenario: BackendTLSPolicy created with CA certificate

- GIVEN a Gateway with `route` configuration
- AND the `openshell-server-tls` Secret exists in the project namespace
- WHEN the GatewayReconciler creates the BackendTLSPolicy
- THEN it SHALL read the `ca.crt` field from the `openshell-server-tls` Secret
- AND it SHALL create a ConfigMap named `openshell-backend-ca` containing the CA certificate
- AND it SHALL create a BackendTLSPolicy targeting the `openshell-gateway` Service
- AND the BackendTLSPolicy SHALL reference the `openshell-backend-ca` ConfigMap for CA verification
- AND the validation hostname SHALL be set to `openshell-gateway.<namespace>.svc.cluster.local`

#### Scenario: BackendTLSPolicy created before TLS secret available

- GIVEN a Gateway with `route` configuration
- AND the `openshell-server-tls` Secret does not yet exist
- WHEN the GatewayReconciler attempts to create the BackendTLSPolicy
- THEN it SHALL skip BackendTLSPolicy creation and log a debug message
- AND it SHALL create the BackendTLSPolicy on the next reconciliation cycle after the Secret exists
- AND the GRPCRoute SHALL still be created (traffic may fail until BackendTLSPolicy is in place)

#### Scenario: CA certificate rotated

- GIVEN a Gateway with an existing BackendTLSPolicy and CA ConfigMap
- AND the `openshell-server-tls` Secret is regenerated (cert-manager rotation)
- WHEN the GatewayReconciler reconciles
- THEN it SHALL update the `openshell-backend-ca` ConfigMap with the new CA certificate

#### Scenario: BackendTLSPolicy CRD not available

- GIVEN the cluster does not support BackendTLSPolicy
- WHEN the GatewayReconciler attempts to create a BackendTLSPolicy
- THEN it SHALL skip BackendTLSPolicy creation and log a warning
- AND the GRPCRoute SHALL still be created
- AND the warning SHALL indicate that the gateway pod's TLS may need to be disabled for traffic to flow

---

### Requirement: Route Address Discovery

The GatewayReconciler SHALL derive the route address from the GRPCRoute hostname and populate the Gateway's `routeAddress` field. The address protocol (http or https) is determined by the networking Gateway's listener protocol.

#### Scenario: Route address populated after GRPCRoute accepted

- GIVEN a Gateway with `route` configuration
- AND the GRPCRoute has been created and accepted by the networking Gateway controller
- WHEN the GatewayReconciler checks the GRPCRoute status
- THEN it SHALL read the GRPCRoute's hostname from `.spec.hostnames[0]`
- AND it SHALL determine the protocol from the networking Gateway's listener (HTTP → `http://`, HTTPS → `https://`)
- AND it SHALL PATCH the Gateway's `routeAddress` field with the full address (e.g., `https://openshell-gateway-tenant-a.acpgw.apps-crc.testing`)

#### Scenario: GRPCRoute not yet accepted

- GIVEN a Gateway with `route` configuration
- AND the GRPCRoute exists but `.status.parents` does not include `Accepted: True`
- WHEN the GatewayReconciler checks the status
- THEN the Gateway's `routeAddress` SHALL remain empty
- AND the reconciler SHALL populate it on the next cycle when the GRPCRoute is accepted

#### Scenario: Route address cleared when route removed

- GIVEN a Gateway with a populated `routeAddress`
- AND the `route` field is removed from the Gateway configuration
- WHEN the GatewayReconciler deletes the GRPCRoute
- THEN it SHALL PATCH the Gateway resource to clear the `routeAddress` field

---

### Requirement: Route Address Exposure via API

The Gateway API response SHALL include the route address so that CLI and SDK consumers can discover how to reach the gateway without direct Kubernetes API access.

#### Scenario: Route address in API response

- GIVEN a Gateway with a populated `routeAddress`
- WHEN a user queries the Gateway via the API
- THEN the response SHALL include the `routeAddress` field with the full external address

#### Scenario: Route address not yet available

- GIVEN a Gateway with `route` configuration
- AND the GRPCRoute has not yet been accepted
- WHEN a user queries the Gateway via the API
- THEN the `routeAddress` field SHALL be empty

---

### Requirement: CLI Route Address Display

The `acpctl get gateway` command SHALL display the route address when available.

The `acpctl gateway setup-cli` command operates in two modes:

1. **Default (API-only):** Queries the ACP API server for the gateway's `routeAddress` and runs the `openshell gateway add` command to register the gateway locally. It does NOT interact with the Kubernetes cluster directly. If no `routeAddress` is available, it errors. Use `--print` to output the command instead of executing it.

2. **`--kubectl` mode:** When `--kubectl` is passed and no `routeAddress` is available, the CLI falls back to direct cluster access — it locates the gateway via `kubectl`, manages a port-forward, extracts TLS/mTLS certificates, and sets up the openshell CLI using the local forwarded address.

#### Scenario: Gateway table includes route address

- GIVEN a Gateway with a populated `routeAddress`
- WHEN a user runs `acpctl get gateways`
- THEN the table output SHALL include an `ADDRESS` column alongside the existing columns (NAME, VERSION, AGE)
- AND the `ADDRESS` column SHALL display the route address for gateways with a route
- AND the `ADDRESS` column SHALL display `"Not ready..."` for gateways with a route but no address yet
- AND the `ADDRESS` column SHALL display comma-separated DNS names for gateways without a route

#### Scenario: Single gateway connection info includes route address

- GIVEN a Gateway with a populated `routeAddress`
- WHEN a user runs `acpctl get gateway <name>`
- THEN the connection info section SHALL display the route address as the primary external endpoint:
  ```
  Connection Info:
    Route:        <routeAddress>
    Cluster DNS:  openshell-gateway.<namespace>.svc.cluster.local:8080
    Server SANs:  <comma-separated ServerDnsNames>

  Setup openshell CLI:
    acpctl gateway setup-cli <name>
  ```
- AND the "Setup openshell CLI" hint SHALL only be shown when a route address is available

#### Scenario: setup-cli registers gateway via route address

- GIVEN a Gateway with a populated `routeAddress`
- WHEN a user runs `acpctl gateway setup-cli <name>`
- THEN the CLI SHALL query the ACP API server to retrieve the gateway resource
- AND it SHALL read the `routeAddress` field from the API response
- AND it SHALL execute `openshell gateway add` to register the gateway locally:
  ```
  openshell gateway add --name <project>-<gateway-name> <routeAddress>
  ```
- AND when the gateway has OIDC configured, the command SHALL include the OIDC issuer flag:
  ```
  openshell gateway add --name <project>-<gateway-name> --oidc-issuer <issuer> <routeAddress>
  ```
- AND it SHALL verify connectivity via `openshell status -g <project>-<gateway-name>` after registration

#### Scenario: setup-cli with --print flag

- GIVEN a Gateway with a populated `routeAddress`
- WHEN a user runs `acpctl gateway setup-cli <name> --print`
- THEN the CLI SHALL print the `openshell gateway add` command to stdout instead of executing it

#### Scenario: setup-cli errors when no route and no --kubectl

- GIVEN a Gateway without a populated `routeAddress`
- WHEN a user runs `acpctl gateway setup-cli <name>` without `--kubectl`
- THEN the CLI SHALL exit with an error indicating that the gateway has no external route address
- AND the error message SHALL suggest configuring a Route on the gateway, or using `--kubectl`

#### Scenario: setup-cli with --kubectl locates gateway and sets up port-forward

- GIVEN a Gateway without a populated `routeAddress`
- AND the user has `kubectl` access to the cluster
- WHEN the user runs `acpctl gateway setup-cli <name> --kubectl`
- THEN the CLI SHALL use `kubectl` to locate the gateway Service and start a port-forward
- AND it SHALL extract TLS/mTLS certificates from the namespace
- AND it SHALL execute `openshell gateway add` with the local forwarded address

#### Scenario: setup-cli with --kubectl prefers route address when available

- GIVEN a Gateway with a populated `routeAddress`
- WHEN the user runs `acpctl gateway setup-cli <name> --kubectl`
- THEN the CLI SHALL use the `routeAddress` and SHALL NOT start a port-forward

---

### Requirement: Gateway Route Configuration Schema

The Gateway resource schema SHALL be extended with `route` (input) and `routeAddress` (output) fields.

#### Scenario: API schema extension

- GIVEN the Gateway OpenAPI schema in `openapi.gateways.yaml`
- WHEN the `route` field is added
- THEN the schema SHALL define:
  ```yaml
  GatewayRoute:
    type: object
    properties:
      host:
        type: string
        description: >
          Hostname for the GRPCRoute. If empty, a hostname is derived from
          the gateway name, namespace, and cluster base domain.
  ```
- AND the Gateway object SHALL include:
  ```yaml
  route:
    $ref: '#/components/schemas/GatewayRoute'
  routeAddress:
    type: string
    readOnly: true
    description: >
      External address assigned to the GRPCRoute (populated by the control plane).
      Format: protocol://hostname (e.g., http://openshell-gateway-tenant-a.acpgw.apps-crc.testing).
  ```

#### Scenario: Database storage

- GIVEN the `route` configuration is an optional object
- WHEN stored in PostgreSQL
- THEN it SHALL be stored as JSONB (consistent with `oidc` storage)
- AND `routeAddress` SHALL be stored as a nullable text column

#### Scenario: SDK type generation

- GIVEN the schema includes `route` and `routeAddress`
- WHEN SDKs are generated
- THEN the Go SDK SHALL include `Route *GatewayRoute` and `RouteAddress string` on the Gateway type
- AND the Python and TypeScript SDKs SHALL include equivalent types
- AND `routeAddress` SHALL be read-only in all SDKs (not settable by clients)

---

### Requirement: Gateway Route Validation

The GatewayReconciler SHALL validate `route` configuration before creating GRPCRoute resources.

#### Scenario: Valid route with explicit host

- GIVEN a Gateway with `route.host` set to a valid DNS hostname
- WHEN the GatewayReconciler validates the configuration
- THEN validation SHALL pass

#### Scenario: Valid route with empty host

- GIVEN a Gateway with `route` present but `host` empty or omitted
- WHEN the GatewayReconciler validates the configuration
- THEN validation SHALL pass (hostname will be auto-derived)

#### Scenario: Invalid route host

- GIVEN a Gateway with `route.host` set to a value that is not a valid DNS hostname
- WHEN the GatewayReconciler validates the configuration
- THEN validation SHALL fail with a descriptive error
- AND the GRPCRoute SHALL NOT be created

---

### Requirement: RBAC for Gateway API Resources

The control plane ServiceAccount SHALL have permissions to manage Gateway API resources in project namespaces.

#### Scenario: Gateway API RBAC rules

- GIVEN the control plane needs to create and manage GRPCRoute, BackendTLSPolicy, and related resources
- THEN the ClusterRole SHALL include:
  ```yaml
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["grpcroutes", "backendtlspolicies"]
    verbs: ["get", "list", "create", "update", "patch", "delete"]
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["gateways"]
    verbs: ["get", "list"]
  ```
- AND the `route.openshift.io` permissions for Routes SHALL be removed (Routes are no longer used)

---

### Requirement: Cluster Prerequisites via Make Target

The `make crc-up` target SHALL install Gateway API prerequisites on the OpenShift cluster before deploying the ACP stack.

#### Scenario: Gateway API setup in crc-up

- GIVEN an OpenShift 4.22+ cluster with Gateway API CRDs available
- WHEN a developer runs `make crc-up`
- THEN the target SHALL:
  1. Verify GatewayClass `openshift-default` exists and is accepted
  2. Generate a CA and CA-signed leaf wildcard TLS certificate for `*.acpgw.<base-domain>`, store the leaf as Secret `acpgw-tls` and the CA as Secret `acpgw-ca` in `openshift-ingress`
  3. Create the networking Gateway `acpgw` in the `openshift-ingress` namespace with an HTTPS listener on `*.acpgw.<base-domain>` referencing the TLS Secret
  4. If the Gateway's LoadBalancer is pending (CRC), patch the default IngressController to allow wildcard routes (`routeAdmission.wildcardPolicy: WildcardsAllowed`) and create a passthrough Route that bridges the default router to the Gateway API pod
  5. Wait for the Gateway's status to include `Accepted: True`
  6. Continue with the existing ACP deployment steps

#### Scenario: Gateway already exists

- GIVEN the networking Gateway `acpgw` already exists in `openshift-ingress`
- WHEN `make crc-up` runs
- THEN it SHALL update the existing Gateway (apply, not create)
- AND it SHALL NOT fail if the Gateway is already present

---

### Requirement: Gateway Database Configuration Field

The Gateway resource SHALL support an optional `database` field that controls the database backend. When absent or null, the gateway uses the default SQLite behavior (backward compatible).

#### Scenario: Gateway with PostgreSQL database

- GIVEN a Gateway resource:
  ```yaml
  kind: Gateway
  name: openshell-gateway
  project: tenant-a
  database:
    type: postgres
    storageSize: 10Gi
  image: ghcr.io/nvidia/openshell:v0.0.70
  serverDnsNames:
    - openshell-gateway.tenant-a.svc.cluster.local
  ```
- WHEN the GatewayReconciler processes the Gateway
- THEN it SHALL provision a PostgreSQL Deployment, PVC, Service, NetworkPolicy, and Secret in the `tenant-a` namespace
- AND it SHALL deploy the gateway as a Deployment (not StatefulSet)
- AND the gateway container SHALL receive `OPENSHELL_DB_URL` from the provisioned Secret

#### Scenario: Gateway with default SQLite database

- GIVEN a Gateway resource with no `database` field (or `database.type: sqlite`)
- WHEN the GatewayReconciler processes the Gateway
- THEN it SHALL deploy the gateway as a StatefulSet with embedded SQLite (existing behavior)
- AND no PostgreSQL resources SHALL be provisioned

#### Scenario: Gateway with unsupported database type

- GIVEN a Gateway resource with `database.type: rds`
- WHEN the GatewayReconciler validates the configuration
- THEN it SHALL log a validation warning: unsupported database type
- AND it SHALL NOT provision any database resources
- AND it SHALL NOT deploy the gateway (configuration is invalid until corrected)

#### Scenario: Gateway with external database (Phase 2)

- GIVEN a Gateway resource with `database.externalSecretRef: my-db-secret`
- WHEN the GatewayReconciler validates the configuration
- THEN it SHALL reject the configuration with a validation error: `externalSecretRef is reserved for future use`
- AND it SHALL NOT provision any resources

---

### Requirement: Database Field Schema

The `database` field SHALL be a JSONB object on the Gateway resource with the following sub-fields:

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `type` | string | Yes (when `database` is set) | `sqlite` | Database backend: `sqlite`, `postgres`. Reserved for future: `rds`. |
| `storageSize` | string | No | `5Gi` | PVC storage request for the PostgreSQL data volume. Only applicable when `type: postgres`. Ignored for `type: sqlite`. |
| `image` | string | No | `postgres:16` | PostgreSQL container image. Override for RHEL-certified images (e.g., `registry.redhat.io/rhel10/postgresql-16:10.1`). When a RHEL image is detected (image path contains `rhel`), the reconciler SHALL use `POSTGRESQL_USER`, `POSTGRESQL_PASSWORD`, `POSTGRESQL_DATABASE` env vars instead of `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`. Only applicable when `type: postgres`. |
| `externalSecretRef` | string | No | — | Name of a K8s Secret containing a `url` key with the connection string. When set, the reconciler skips DB provisioning and mounts this Secret instead. Only valid with `type: postgres`. Reserved — not implemented in Phase 1; the reconciler SHALL reject this field with a validation error until support is added. |

#### Scenario: Database field defaults

- GIVEN a Gateway resource with `database: { type: postgres }` and no `storageSize`
- WHEN the GatewayReconciler provisions the database PVC
- THEN the PVC SHALL request `5Gi` of storage

#### Scenario: Database field absent

- GIVEN a Gateway resource with no `database` field
- WHEN the GatewayReconciler processes the Gateway
- THEN it SHALL treat the gateway as `database.type: sqlite`
- AND behavior SHALL be identical to the pre-existing gateway provisioning

#### Scenario: RHEL image env var mapping

- GIVEN a Gateway with `database.image: registry.redhat.io/rhel10/postgresql-16:10.1`
- WHEN the GatewayReconciler provisions the database Deployment
- THEN the container env vars SHALL use `POSTGRESQL_USER`, `POSTGRESQL_PASSWORD`, `POSTGRESQL_DATABASE`
- AND `PGDATA` SHALL remain `/var/lib/postgresql/data/pgdata`

---

### Requirement: PostgreSQL Resource Provisioning

When `database.type` is `postgres`, the GatewayReconciler SHALL provision the following Kubernetes resources in the gateway's project namespace. All resources SHALL use update-or-create semantics (never create-and-ignore-AlreadyExists).

#### Scenario: Provision PostgreSQL resources

- GIVEN a Gateway with `database.type: postgres` in project `tenant-a`
- AND the namespace `tenant-a` exists
- WHEN the GatewayReconciler reconciles the Gateway
- THEN it SHALL create or update these resources:

**Secret** (`openshell-gateway-db`):
- Key `db.user`: `openshell`
- Key `db.password`: cryptographically random 32-character password
- Key `db.name`: `openshell`
- Key `url`: `postgresql://openshell:<password>@openshell-gateway-db:5432/openshell?sslmode=disable`
- The password SHALL be generated using `crypto/rand` (32 bytes, base64url-encoded, truncated to 32 characters)

**PVC** (`openshell-gateway-db-data`):
- Access mode: `ReadWriteOnce`
- Storage request: value of `database.storageSize` (default `5Gi`)

**Deployment** (`openshell-gateway-db`):
- Replicas: 1
- Image: value of `database.image` (default `postgres:16`)
- Environment variables from Secret `openshell-gateway-db`:
  - `POSTGRES_USER` from key `db.user` (or `POSTGRESQL_USER` for RHEL images)
  - `POSTGRES_PASSWORD` from key `db.password` (or `POSTGRESQL_PASSWORD` for RHEL images)
  - `POSTGRES_DB` from key `db.name` (or `POSTGRESQL_DATABASE` for RHEL images)
- Environment variable: `PGDATA=/var/lib/postgresql/data/pgdata`
- Volume mount: PVC `openshell-gateway-db-data` at `/var/lib/postgresql/data`
- EmptyDir volume mounts: `/var/run/postgresql` and `/tmp` (PostgreSQL requires writable paths for its Unix socket and temp files; `PGDATA` is covered by the PVC mount)
- Container port: 5432
- Readiness probe: `pg_isready -U "$POSTGRES_USER"` (initialDelaySeconds: 10, periodSeconds: 10)
- Liveness probe: `pg_isready -U "$POSTGRES_USER"` (initialDelaySeconds: 30, periodSeconds: 30)
- Resource requests: `cpu: 100m`, `memory: 256Mi`
- Resource limits: `cpu: 500m`, `memory: 512Mi`
- SecurityContext: `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, capabilities `drop: [ALL]`, `readOnlyRootFilesystem: true`, `seccompProfile: { type: RuntimeDefault }`
- Strategy: `Recreate` (single-replica database; rolling update is not safe)

> **Production limitation:** Single-replica PostgreSQL with `Recreate` strategy is suitable for development and demonstration. It is not highly available — if the node the PVC is bound to becomes unavailable, the database is unreachable until the pod is rescheduled. For production workloads requiring HA, use `database.externalSecretRef` (Phase 2) to point at a managed PostgreSQL service (RDS, CloudSQL, or an externally-managed instance).

**Service** (`openshell-gateway-db`):
- Type: `ClusterIP`
- Port: 5432 → 5432

**NetworkPolicy** (`openshell-gateway-db`):
- PodSelector: `app.kubernetes.io/name: openshell`, `app.kubernetes.io/component: database`
- PolicyTypes: `Ingress`
- Ingress rule: allow TCP port 5432 from pods matching `app.kubernetes.io/name: openshell`, `app.kubernetes.io/instance: openshell-gateway` within the same namespace
- All other ingress to the database pod SHALL be denied

- AND all resources SHALL carry labels:
  - `app.kubernetes.io/name: openshell`
  - `app.kubernetes.io/component: database`
  - `app.kubernetes.io/managed-by: agent-control-plane`
  - `ambient-code.io/managed: true`

#### Scenario: PostgreSQL resources already exist (idempotency)

- GIVEN `tenant-a` already has PostgreSQL resources provisioned for the gateway
- WHEN the GatewayReconciler reconciles again
- THEN it SHALL apply the latest configuration using update-or-create semantics
- AND it SHALL NOT create duplicate resources
- AND the existing Secret password SHALL be preserved (not regenerated)

---

### Requirement: Database Credential Security

The database credentials Secret SHALL be generated securely and the password SHALL never be exposed in logs, error messages, or API responses.

#### Scenario: Password generation

- GIVEN a new Gateway with `database.type: postgres`
- AND no `openshell-gateway-db` Secret exists in the namespace
- WHEN the GatewayReconciler provisions the database
- THEN it SHALL generate a 32-character password using `crypto/rand`
- AND it SHALL construct the `url` value as `postgresql://openshell:<password>@openshell-gateway-db:5432/openshell?sslmode=disable`
- AND the password SHALL NOT appear in any log messages (use `len(password)` for logging)

> **Note:** `sslmode=disable` is an intentional choice. The database connection is in-cluster, same-namespace traffic between the gateway pod and the database pod. TLS on this link adds latency and operational complexity with negligible security benefit given the NetworkPolicy isolation. If cross-namespace or cross-cluster database access is needed in the future, `sslmode=require` should be enforced via the `externalSecretRef` connection string.

#### Scenario: Password preservation on reconcile

- GIVEN an `openshell-gateway-db` Secret already exists with a password
- WHEN the GatewayReconciler reconciles the Gateway
- THEN it SHALL read the existing password from the Secret
- AND it SHALL NOT overwrite the password
- AND the `url` value SHALL be recomputed using the existing password (in case other URI components changed)

#### Scenario: Secret deleted externally

- GIVEN the `openshell-gateway-db` Secret is deleted by an external actor
- WHEN the GatewayReconciler reconciles the Gateway
- THEN it SHALL generate a new password and recreate the Secret
- AND the gateway SHALL pick up the new credentials on its next restart

---

### Requirement: Gateway Workload Switching

When `database.type` is `postgres`, the gateway workload SHALL be deployed as a Deployment instead of a StatefulSet. This follows the upstream OpenShell pattern where `server.externalDbSecret` requires `workload.kind=deployment`.

#### Scenario: Deploy gateway as Deployment with PostgreSQL

- GIVEN a Gateway with `database.type: postgres`
- WHEN the GatewayReconciler deploys the gateway workload
- THEN it SHALL create a Deployment named `openshell-gateway` (not a StatefulSet)
- AND the Deployment SHALL NOT include a VolumeClaimTemplate for `openshell-data`
- AND the gateway container SHALL NOT include `--db-url sqlite:...` in its args
- AND the gateway container SHALL include an environment variable:
  ```yaml
  - name: OPENSHELL_DB_URL
    valueFrom:
      secretKeyRef:
        name: openshell-gateway-db
        key: url
  ```
- AND the Deployment SHALL include an init container that waits for database readiness (see Provisioning Order)
- AND the Deployment SHALL retain all other gateway container configuration (TLS mounts, config volume, probes, ports, SecurityContext)

#### Scenario: Deploy gateway as StatefulSet with SQLite

- GIVEN a Gateway with `database.type: sqlite` (or no `database` field)
- WHEN the GatewayReconciler deploys the gateway workload
- THEN it SHALL create a StatefulSet named `openshell-gateway` (existing behavior)
- AND the StatefulSet SHALL include a VolumeClaimTemplate for `openshell-data`
- AND the gateway container SHALL include `--db-url sqlite:/var/openshell/openshell.db` in its args

---

### Requirement: Database Resource Provisioning Order

The GatewayReconciler SHALL provision database resources before the gateway workload to ensure the database is available when the gateway starts.

#### Scenario: Provisioning order for postgres mode

- GIVEN a Gateway with `database.type: postgres`
- WHEN the GatewayReconciler reconciles the Gateway
- THEN it SHALL provision resources in this order:
  1. Database Secret (`openshell-gateway-db`)
  2. Database PVC (`openshell-gateway-db-data`)
  3. Database Deployment (`openshell-gateway-db`)
  4. Database Service (`openshell-gateway-db`)
  5. Database NetworkPolicy (`openshell-gateway-db`)
  6. Gateway RBAC (ServiceAccount, Role, RoleBinding — existing)
  7. Gateway ConfigMap (existing)
  8. Gateway certgen Job (existing)
  9. Gateway Service (existing)
  10. Gateway Deployment (`openshell-gateway` — new workload kind, with `pg_isready` init container)
  11. Gateway NetworkPolicy (existing)

#### Scenario: Database not yet ready

- GIVEN the PostgreSQL Deployment is provisioned but not yet ready
- WHEN the gateway Deployment starts
- THEN the gateway pod SHALL include an init container that runs `pg_isready` in a loop until the database is reachable
- AND the init container SHALL use the same database Secret for connection parameters
- AND the main gateway container SHALL NOT start until the init container succeeds
- AND the GatewayReconciler SHALL NOT block — it relies on the init container and Kubernetes restart behavior

The init container pattern (used by ACP's own API server) prevents the gateway from entering a crash-loop with error logs during initial database provisioning. The pod simply waits in `Init` state until the database is ready.

---

### Requirement: Database Type Transition

When a Gateway's `database.type` changes between `sqlite` and `postgres`, the GatewayReconciler SHALL cleanly transition between workload types and manage database resource lifecycle.

#### Scenario: Transition from sqlite to postgres

- GIVEN a Gateway currently deployed as a StatefulSet with `database.type: sqlite`
- WHEN the Gateway is updated to `database.type: postgres`
- THEN the GatewayReconciler SHALL:
  1. Provision PostgreSQL resources (Secret, PVC, Deployment, Service, NetworkPolicy)
  2. Delete the existing StatefulSet (`openshell-gateway`)
  3. Deploy a new Deployment (`openshell-gateway`) with `OPENSHELL_DB_URL`
- AND the SQLite VolumeClaimTemplate PVC SHALL be cleaned up

#### Scenario: Transition from postgres to sqlite

- GIVEN a Gateway currently deployed as a Deployment with `database.type: postgres`
- WHEN the Gateway is updated to `database.type: sqlite`
- THEN the GatewayReconciler SHALL:
  1. Delete the existing Deployment (`openshell-gateway`)
  2. Deploy a new StatefulSet (`openshell-gateway`) with SQLite
  3. Delete PostgreSQL resources (Deployment, Service, PVC, Secret, NetworkPolicy named `openshell-gateway-db*`)
- AND data in the PostgreSQL database SHALL be permanently lost
- AND this is a known destructive operation

---

### Requirement: Gateway Deletion with Database

When a Gateway with `database.type: postgres` is deleted, all associated database resources SHALL also be deleted.

#### Scenario: Delete gateway with postgres database

- GIVEN a Gateway with `database.type: postgres` exists in project `tenant-a`
- AND PostgreSQL resources (Secret, PVC, Deployment, Service, NetworkPolicy) exist in the namespace
- WHEN the Gateway is deleted
- THEN the GatewayReconciler SHALL delete all gateway K8s resources (existing behavior)
- AND it SHALL delete the database Deployment `openshell-gateway-db`
- AND it SHALL delete the database Service `openshell-gateway-db`
- AND it SHALL delete the database PVC `openshell-gateway-db-data`
- AND it SHALL delete the database Secret `openshell-gateway-db`
- AND it SHALL delete the database NetworkPolicy `openshell-gateway-db`
- AND data in the PostgreSQL database SHALL be permanently lost

#### Scenario: Delete gateway with sqlite database

- GIVEN a Gateway with `database.type: sqlite` (or no `database` field)
- WHEN the Gateway is deleted
- THEN the GatewayReconciler SHALL delete all gateway K8s resources (existing behavior)
- AND no database resources exist to clean up

---

### Requirement: New Manifest Templates

The control plane container SHALL include manifest templates for the PostgreSQL database resources and the gateway Deployment workload variant.

#### Scenario: Database manifest template

- GIVEN the ACP container includes gateway manifests at `/manifests/gateway/`
- THEN a `db-deployment.yaml` manifest SHALL exist containing:
  - PostgreSQL Deployment (`openshell-gateway-db`) with emptyDir mounts for `/var/run/postgresql` and `/tmp`
  - PVC (`openshell-gateway-db-data`) with `STORAGE_SIZE_PLACEHOLDER`
  - Service (`openshell-gateway-db`)
  - NetworkPolicy (`openshell-gateway-db`)
- AND the manifest SHALL use `NAMESPACE_PLACEHOLDER` for namespace substitution
- AND the manifest SHALL use `DB_IMAGE_PLACEHOLDER` for the PostgreSQL container image
- AND the manifest SHALL follow the same structure as `components/manifests/base/platform/ambient-api-server-db.yml`

#### Scenario: Gateway Deployment manifest template

- GIVEN the ACP container includes gateway manifests at `/manifests/gateway/`
- THEN a `deployment.yaml` manifest SHALL exist containing:
  - A Deployment (`openshell-gateway`) with the same pod spec as `statefulset.yaml`
  - No VolumeClaimTemplates
  - An `OPENSHELL_DB_URL` env var sourced from `secretKeyRef` on Secret `openshell-gateway-db` key `url`
  - An init container running `pg_isready` in a loop against the database Service
  - No `--db-url` CLI argument
- AND the existing `statefulset.yaml` SHALL be preserved for `database.type: sqlite` mode

---

### Requirement: OIDC OpenAPI Schema Extension

The Gateway OpenAPI schema SHALL be extended with an `oidc` object property. The `GatewayPatchRequest` schema SHALL also include the `oidc` field for partial updates.

#### Scenario: OpenAPI schema includes OIDC

- GIVEN the Gateway OpenAPI schema in `openapi.gateways.yaml`
- THEN it SHALL include an `oidc` property defined as:
  ```yaml
  oidc:
    type: object
    description: OIDC authentication configuration for the gateway
    properties:
      issuer:
        type: string
        description: OIDC issuer URL; empty disables OIDC
      audience:
        type: string
        description: Expected aud claim value in JWT
        default: "openshell-cli"
      jwks_ttl:
        type: integer
        description: JWKS key cache retention in seconds
        default: 3600
      roles_claim:
        type: string
        description: Dot-delimited path to roles array in JWT claims
      admin_role:
        type: string
        description: Role name conferring admin access
      user_role:
        type: string
        description: Role name conferring standard user access
      scopes_claim:
        type: string
        description: Dot-delimited path to scopes array in JWT claims
  ```

#### Scenario: SDK regeneration

- WHEN the OpenAPI schema is updated
- THEN `make generate` in the API server SHALL regenerate the Go OpenAPI client
- AND `make generate` in the SDK SHALL regenerate Go, Python, and TypeScript clients with the `oidc` field

---

### Requirement: OIDC Database Storage

The Gateway database model SHALL store OIDC configuration as a JSONB column. This follows the same pattern used for `labels` and `annotations`.

#### Scenario: OIDC persisted as JSONB

- GIVEN a Gateway with OIDC configuration
- WHEN the API server persists it
- THEN the `oidc` field SHALL be stored in a `oidc` column of type `jsonb`
- AND the column SHALL be nullable (null = OIDC not configured)

#### Scenario: Migration adds OIDC column

- WHEN the migration runs
- THEN it SHALL add a nullable `oidc` column of type `jsonb` to the `gateways` table
- AND existing gateways SHALL have `oidc = NULL`

---

### Requirement: Kind Cluster OIDC Testing

The Kind cluster Keycloak realm SHALL be configured to support OIDC testing with OpenShell gateways. This enables end-to-end OIDC validation in local development without an external identity provider.

#### Scenario: Keycloak client for OpenShell

- GIVEN the Kind cluster Keycloak realm `ambient-code`
- THEN it SHALL include a public client named `openshell-cli`:
  - `publicClient: true` (CLI-based auth flow)
  - `standardFlowEnabled: true` (authorization code flow)
  - `directAccessGrantsEnabled: true` (resource owner password for testing)
  - Protocol mapper: `audience` mapper adding `openshell-cli` to the `aud` claim

#### Scenario: OpenShell realm roles

- GIVEN the Kind cluster Keycloak realm `ambient-code`
- THEN it SHALL define two realm roles:
  - `openshell-admin` — admin-level access to OpenShell gateways
  - `openshell-user` — standard user access to OpenShell gateways

#### Scenario: User-to-role mappings

- GIVEN the Kind cluster users `admin` and `developer`
- THEN the `admin` user SHALL have the `openshell-admin` realm role assigned
- AND the `developer` user SHALL have the `openshell-user` realm role assigned
- AND both users' tokens SHALL include `realm_access.roles` containing their assigned roles

#### Scenario: Example Gateway with Kind OIDC

- GIVEN the Kind cluster is running with Keycloak
- THEN example Gateway overlays for Kind SHALL include OIDC configuration:
  ```yaml
  kind: Gateway
  name: openshell-gateway
  oidc:
    issuer: http://keycloak-service:8080/realms/ambient-code
    audience: openshell-cli
    roles_claim: realm_access.roles
    admin_role: openshell-admin
    user_role: openshell-user
  ```
- AND the gateway SHALL validate tokens issued by the Kind Keycloak instance

---

## E2E Testing on OpenShift Local

### Requirement: Gateway Route E2E Test

> **Note:** This e2e test cannot run in GitHub CI. It requires a running OpenShift Local (CRC) cluster.

#### Scenario: Full connectivity through GRPCRoute

- GIVEN the ACP stack is deployed on OpenShift Local with `make crc-up`
- AND the networking Gateway `acpgw` is installed in `openshift-ingress`
- AND a gateway is provisioned for a tenant with `route: {}`
- WHEN the GatewayReconciler reconciles the gateway
- THEN a GRPCRoute SHALL be created in the tenant namespace
- AND a BackendTLSPolicy SHALL be created targeting the gateway Service
- AND `acpctl get gateway openshell-gateway` SHALL show the route address under `*.acpgw.apps-crc.testing`
- AND `acpctl gateway setup-cli openshell-gateway --print` SHALL output the `openshell gateway add` command with the route address
- AND `openshell sandbox list` SHALL succeed through the GRPCRoute (gRPC over HTTP/2)

---

## Configuration

### Gateway Resource Schema (Consolidated)

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | Yes | — | Resource name (typically `openshell-gateway`) |
| `project` | Yes | — | Project name (determines target namespace) |
| `image` | No | `OPENSHELL_GATEWAY_IMAGE` env var | Gateway container image reference |
| `serverDnsNames` | Yes | — | DNS names for TLS certificate generation |
| `config` | No | — | OpenShell gateway TOML configuration (overrides defaults) |
| `oidc` | No | — | OIDC authentication configuration (see OIDC sections above) |
| `oidc.issuer` | Yes (to enable OIDC) | `""` | OIDC issuer URL; empty disables OIDC |
| `oidc.audience` | No | `"openshell-cli"` | Expected `aud` claim value in JWT |
| `oidc.jwks_ttl` | No | `3600` | JWKS key cache retention in seconds |
| `oidc.roles_claim` | No | `""` | Dot-delimited path to roles array in JWT claims |
| `oidc.admin_role` | No | `""` | Role name conferring admin access |
| `oidc.user_role` | No | `""` | Role name conferring standard user access |
| `oidc.scopes_claim` | No | `""` | Dot-delimited path to scopes array in JWT claims |
| `route` | No | — | Route configuration for external exposure |
| `route.host` | No | auto-derived | Hostname for the GRPCRoute |
| `routeAddress` | — | — | Read-only. External address populated by the control plane |
| `database` | No | — | Database backend configuration |
| `database.type` | Yes (when `database` set) | `sqlite` | `sqlite`, `postgres`, or future `rds` |
| `database.storageSize` | No | `5Gi` | PVC size for PostgreSQL data. Only for `type: postgres` |
| `database.image` | No | `postgres:16` | PostgreSQL container image. Override for RHEL-certified images |
| `database.externalSecretRef` | No | — | Name of Secret with `url` key. Skips DB provisioning. Reserved (Phase 2) |

### Control Plane Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GATEWAY_API_GATEWAY_NAME` | `acpgw` | Name of the networking Gateway resource |
| `GATEWAY_API_GATEWAY_NAMESPACE` | `openshift-ingress` | Namespace of the networking Gateway |
| `GATEWAY_API_BASE_DOMAIN` | auto-detected | Cluster base domain for hostname generation |

### Example: Full Gateway Configuration

```yaml
kind: Gateway
name: openshell-gateway
project: tenant-a
image: ghcr.io/nvidia/openshell:v0.0.83
serverDnsNames:
  - openshell-gateway.tenant-a.svc.cluster.local
config: |
  [openshell.gateway]
  bind_address = "0.0.0.0:8080"
  log_level = "info"
  sandbox_namespace = "tenant-a"
  default_image = "ghcr.io/nvidia/openshell-community/sandboxes/base:latest"
  supervisor_image = "ghcr.io/nvidia/openshell/supervisor:0.0.63"

  [openshell.gateway.auth]
  allow_unauthenticated_users = true
oidc:
  issuer: https://keycloak.example.com/realms/acp
  audience: openshell-gateway
route: {}
database:
  type: postgres
  storageSize: 10Gi
  image: postgres:16
```

### Example: Gateway with SQLite (default, backward compatible)

```yaml
kind: Gateway
name: openshell-gateway
project: tenant-a
image: ghcr.io/nvidia/openshell:v0.0.70
serverDnsNames:
  - openshell-gateway.tenant-a.svc.cluster.local
```

### Example: Gateway with RHEL PostgreSQL Image

```yaml
kind: Gateway
name: openshell-gateway
project: tenant-a
image: ghcr.io/nvidia/openshell:v0.0.70
serverDnsNames:
  - openshell-gateway.tenant-a.svc.cluster.local
database:
  type: postgres
  storageSize: 10Gi
  image: registry.redhat.io/rhel10/postgresql-16:10.1
```

---

## Migration

### Relationship to Existing Specs

This specification supersedes the "Gateway provisioning" constraint in `openshell-sandbox-provisioning.spec.md` (Iteration 1), which stated:

> "Gateway provisioning — the OpenShell gateway is assumed to already be deployed in each project namespace; ACP will not create it. A future iteration should have the control plane provision and reconcile gateway lifecycle per project namespace..."

This specification IS that future iteration, implemented through the API-driven Gateway resource model rather than the previously designed ConfigMap-based approach.

### Removed Components

| Component | Disposition |
|---|---|
| `internal/gateway/config.go` | Deleted — ConfigMap schema, loader, watcher eliminated |
| `internal/gateway/reconciler.go` | Logic moves to `internal/reconciler/gateway_reconciler.go` |
| `initGatewayProvisioning()` in `main.go` | Deleted — no ConfigMap watcher startup needed |
| `platform-config` ConfigMap and overlays | Deleted — replaced by `kind: Gateway` API resources |
| `internal/gateway/manifests.go` | Preserved — reused by GatewayReconciler |
| `internal/gateway/validation.go` | Preserved — reused by GatewayReconciler |

### New Components

| Component | Purpose |
|---|---|
| `internal/reconciler/gateway_reconciler.go` | Watches Gateway gRPC events, reconciles K8s gateway resources |
| Shared kustomize library (e.g., `ambient-sdk/go-sdk/kustomize/`) | Extracted from `acpctl apply`; consumed by CLI and ApplicationReconciler |
| `kind: Gateway` API resource | PostgreSQL-backed, REST API, gRPC watch events |
| `examples/overlays/*/gateway.yaml` | Per-tenant Gateway declarations in kustomize overlays |
| `examples/base/gateway.yaml` | Base Gateway configuration for overlay inheritance |
| `manifests/gateway/db-deployment.yaml` | PostgreSQL Deployment + PVC + Service + NetworkPolicy template |
| `manifests/gateway/deployment.yaml` | Gateway Deployment template (postgres mode, with `pg_isready` init container) |
| DB provisioning logic in GatewayReconciler | Password generation, Secret creation, DB resource reconciliation, RHEL image env var mapping |

### Data Model Changes Required

The Gateway kind in `data-model.spec.md` SHALL gain `oidc`, `route`, `routeAddress`, and `database` fields:

```
Gateway {
    ...existing fields...
    jsonb  oidc         "nullable — OIDC authentication config: {issuer, audience, jwks_ttl, roles_claim, admin_role, user_role, scopes_claim}"
    jsonb  route        "nullable — route exposure config (host)"
    text   routeAddress "nullable — read-only external address populated by control plane"
    jsonb  database     "nullable — database backend config: {type, storageSize, image, externalSecretRef}"
}
```

Database migrations SHALL add the columns to the `gateways` table:

```sql
ALTER TABLE gateways ADD COLUMN oidc JSONB;
ALTER TABLE gateways ADD COLUMN route JSONB;
ALTER TABLE gateways ADD COLUMN route_address TEXT;
ALTER TABLE gateways ADD COLUMN database JSONB;
```

### Backward Compatibility

When `OPENSHELL_USE_GATEWAY=false` (the default), all behavior is identical to the current system. The GatewayReconciler is only active when `OPENSHELL_USE_GATEWAY=true` and Gateway resources exist.

- Gateways without `oidc` configuration behave identically to current behavior
- Gateways without `route` configuration are accessible only via cluster-internal DNS
- Gateways without `database` configuration use SQLite StatefulSet (existing behavior)
- All new fields are optional and nullable — no breaking changes to existing API consumers
- The database migrations are additive (new nullable columns)

### Route Migration: Changes from Route-Based Approach

| Aspect | Previous (Routes) | New (Gateway API) |
|---|---|---|
| API group | `route.openshift.io` | `gateway.networking.k8s.io` |
| Resource type | Route | GRPCRoute |
| TLS re-encrypt | Route `destinationCACertificate` | BackendTLSPolicy + CA ConfigMap |
| HTTP/2 support | Broken (HAProxy `no-alpn`) | Native (Envoy gateway controller) |
| Cluster prereq | None (Routes built-in) | Networking Gateway in `openshift-ingress` |
| Detection | `route.openshift.io` API group | GRPCRoute CRD + Gateway resource |
| Hostname pattern | `*.apps-crc.testing` | `*.acpgw.apps-crc.testing` |

### Existing Consumer Impact

| Consumer | Impact |
|---|---|
| `kube_reconciler.go` | No changes — continues to use gateways for sandbox creation |
| `openshell/gateway_client.go` | No changes — continues to use gateways for sandbox creation |
| `pod_sync.go` | No changes |
| `ApplicationReconciler` | Updated to use shared kustomize library; now supports `kind: Gateway` in rendered manifests |
| `acpctl apply` | Refactored to use shared kustomize library; now supports `kind: Gateway` |
| `gateway_reconciler.go` | Replace Route CRUD with GRPCRoute + BackendTLSPolicy CRUD; add base domain detection; add DB provisioning |
| RBAC ClusterRole | Replace `route.openshift.io` rules with `gateway.networking.k8s.io` rules; add PVC verbs; add `delete` on Deployments/StatefulSets/NetworkPolicies |
| `Makefile` | Add Gateway prerequisite setup to `crc-up` |
| CLI | No changes — `routeAddress` format changes but CLI uses it opaquely |
| SDKs | Regenerated — add `oidc`, `route`, `routeAddress`, `database` fields |
| Gateway OpenAPI schema | Add `oidc`, `route`, `routeAddress`, `database` properties |
| Gateway DB model | Add `oidc`, `route`, `route_address`, `database` columns |
| Gateway presenter | Handle OIDC, route, database field serialization |
| Gateway config struct | Add `OidcConfig` struct to `GatewayConfig` |
| Gateway manifest overrides | Inject `[openshell.gateway.oidc]` into ConfigMap |
| Gateway validation | Validate OIDC role pairing, route host, database type |
| Kind Keycloak realm | Add `openshell-cli` client, realm roles, role mappings |
| Example overlays | Add OIDC-enabled and database-enabled examples |

---

## RBAC Requirements (Consolidated)

The ACP ServiceAccount SHALL have sufficient permissions to:
- Watch Gateway resources via gRPC (existing API server watch mechanism)
- Create, update, patch, get, and delete StatefulSets, Deployments, Services, ServiceAccounts, Roles, RoleBindings, ConfigMaps, Jobs, NetworkPolicies, and PersistentVolumeClaims in project namespaces

```yaml
- apiGroups: [""]
  resources: ["persistentvolumeclaims"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets", "statefulsets/finalizers"]
  verbs: ["create", "get", "update", "patch", "delete"]

- apiGroups: ["networking.k8s.io"]
  resources: ["networkpolicies"]
  verbs: ["create", "get", "update", "patch", "delete"]

- apiGroups: ["cert-manager.io"]
  resources: ["issuers", "certificates"]
  verbs: ["get", "list", "create", "update", "patch", "delete"]

- apiGroups: ["gateway.networking.k8s.io"]
  resources: ["grpcroutes", "backendtlspolicies"]
  verbs: ["get", "list", "create", "update", "patch", "delete"]

- apiGroups: ["gateway.networking.k8s.io"]
  resources: ["gateways"]
  verbs: ["get", "list"]
```

---

## Template Packaging

Gateway manifests SHALL be:
- Stored in the ACP codebase at `components/ambient-control-plane/manifests/gateway/`
- Generated once during development using `helm template` (NOT Helm at runtime)
- Packaged into the ACP container image at build time
- Read from the container filesystem at `/manifests/gateway/` at runtime

---

## Upstream Helm Chart Provenance

ACP does NOT install the OpenShell gateway via Helm at runtime. The gateway manifests at `components/ambient-control-plane/manifests/gateway/` were generated once using `helm template` from the upstream chart, then maintained as static files. Similarly, cert-manager resources and OpenShift adjustments are applied programmatically by the GatewayReconciler, not via Helm.

This section documents which upstream Helm chart values each ACP behavior is equivalent to, so that future configuration changes can be traced back to the upstream chart source.

### OpenShell Gateway Helm Chart

- **Chart:** `oci://ghcr.io/nvidia/openshell/helm-chart`
- **Source:** <https://github.com/NVIDIA/OpenShell/tree/main/deploy/helm/openshell>
- **Docs:** <https://docs.nvidia.com/openshell/kubernetes/openshift>, <https://docs.nvidia.com/openshell/kubernetes/managing-certificates>

The baseline `helm template` command that produced the static manifests:

```bash
helm template openshell-gateway oci://ghcr.io/nvidia/openshell/helm-chart \
  --namespace NAMESPACE_PLACEHOLDER \
  --set "pkiInitJob.serverDnsNames={openshell-gateway.NAMESPACE_PLACEHOLDER.svc.cluster.local}"
```

The following table maps each Helm chart value to the ACP behavior that implements it. When updating gateway configurations, consult the upstream chart's `values.yaml` and the NVIDIA docs linked above, then update the corresponding ACP implementation.

| Helm `--set` value | ACP equivalent | Implementation location |
|---|---|---|
| `pkiInitJob.serverDnsNames={...}` | `serverDnsNames` field on the Gateway API resource; substituted into `certgen-job.yaml` args and cert-manager Certificate SANs at reconcile time | `internal/gateway/reconciler.go` (certgen args), `internal/reconciler/gateway_reconciler.go` (cert-manager SANs) |
| `certManager.enabled=true` | Auto-detected: GatewayReconciler checks for `cert-manager.io` API group at startup via `detectCertManager()`. When present, creates Issuer/Certificate resources inline | `internal/reconciler/gateway_reconciler.go` — `detectCertManager()`, `reconcileCertManagerResources()` |
| `pkiInitJob.enabled` (default: true) | Always enabled. The certgen job runs on every gateway regardless of cert-manager — it handles JWT key generation (`signing.pem`, `public.pem`, `kid`) even when cert-manager manages TLS. Certgen skips TLS secrets that already exist | `manifests/gateway/certgen-job.yaml` — always in deploy order |
| `podSecurityContext.fsGroup=null` | On OpenShift only: `applyOpenShiftOverrides()` clears `fsGroup` from the StatefulSet pod securityContext before apply, so OpenShift's SCC admission assigns it from the namespace range | `internal/gateway/reconciler.go` — `applyOpenShiftOverrides()` |
| `securityContext.runAsUser=null` | On OpenShift only: `applyOpenShiftOverrides()` clears `runAsUser` from container securityContext | `internal/gateway/reconciler.go` — `applyOpenShiftOverrides()` |
| `server.disableTls=true` | **NOT used.** BackendTLSPolicy re-encrypts traffic from the networking Gateway to the pod, requiring the gateway to serve TLS. TLS remains enabled on all clusters | N/A — intentionally omitted |
| `server.externalDbSecret` | `database.type: postgres` provisions a Secret with `url` key; the gateway workload switches to Deployment and receives `OPENSHELL_DB_URL` from the Secret | `internal/reconciler/gateway_reconciler.go` — `reconcileDatabaseResources()`, `reconcileGatewayWorkload()` |
| `workload.kind=deployment` | Automatic when `database.type: postgres` — the reconciler deploys a Deployment instead of StatefulSet | `internal/reconciler/gateway_reconciler.go` |
| `server.oidc.*` | `oidc` field on Gateway resource; injected into `gateway.toml` ConfigMap by `ApplyConfigOverrides` | `internal/gateway/manifests.go` — `ApplyConfigOverrides()` |
| `replicaCount` | ACP uses 1 replica (StatefulSet/Deployment default) | N/A |

### cert-manager Installation

- **Chart:** `oci://quay.io/jetstack/charts/cert-manager` (Helm install) or release YAML (kubectl apply)
- **Docs:** <https://docs.nvidia.com/openshell/kubernetes/managing-certificates>

ACP test environments install cert-manager via `kubectl apply` (not Helm) for simplicity:

```bash
CERT_MANAGER_VERSION="${CERT_MANAGER_VERSION:-v1.17.1}"
kubectl apply -f "https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml"
```

This is equivalent to:

```bash
helm upgrade --install cert-manager oci://quay.io/jetstack/charts/cert-manager \
  --version v1.20.3 \
  --namespace cert-manager \
  --create-namespace \
  --set crds.enabled=true \
  --wait
```

The `kubectl apply` approach is preferred in test environments because it is simpler (no Helm binary required) and the release YAML bundles CRDs. Production environments MAY use the Helm chart for more control over upgrades and values.

The NVIDIA docs recommend cert-manager v1.20+. ACP test environments currently pin `v1.17.1` (the version available when this feature was implemented). The version is configurable via the `CERT_MANAGER_VERSION` environment variable.

### OpenShift-Specific Adjustments

- **Docs:** <https://docs.nvidia.com/openshell/kubernetes/openshift>

The upstream NVIDIA docs prescribe the following for OpenShift, which ACP implements programmatically:

| NVIDIA doc instruction | ACP equivalent |
|---|---|
| `oc adm policy add-scc-to-user privileged -z openshell-sandbox -n <ns>` | `reconcileOpenShiftSCC()` creates a RoleBinding granting `system:openshift:scc:privileged` ClusterRole to the `openshell-gateway-sandbox` ServiceAccount |
| `--set podSecurityContext.fsGroup=null` | `applyOpenShiftOverrides()` clears `fsGroup` via `unstructured.RemoveNestedField()` |
| `--set securityContext.runAsUser=null` | `applyOpenShiftOverrides()` clears `runAsUser` via `unstructured.RemoveNestedField()` |
| `--set server.disableTls=true` | **NOT used** — BackendTLSPolicy re-encrypts to the pod |

The NVIDIA docs note that the OpenShift install path is experimental and recommends `server.disableTls=true` for evaluation. ACP diverges from this recommendation by keeping TLS enabled, because BackendTLSPolicy re-encrypts traffic from the networking Gateway to the pod, requiring the gateway to terminate TLS on the backend segment.

---

## References

- [OpenShell Gateway Helm Chart](https://github.com/NVIDIA/OpenShell/tree/main/deploy/helm/openshell) — upstream chart source; consult `values.yaml` when adding new gateway configurations
- [NVIDIA OpenShell on OpenShift](https://docs.nvidia.com/openshell/kubernetes/openshift) — OpenShift-specific deployment (SCC, security context, TLS)
- [NVIDIA OpenShell Managing Certificates](https://docs.nvidia.com/openshell/kubernetes/managing-certificates) — cert-manager integration for TLS certificate lifecycle
- [NVIDIA OpenShell Kubernetes Ingress Guide](https://docs.nvidia.com/openshell/kubernetes/ingress) — GRPCRoute and Gateway setup for OpenShell
- [OpenShell Helm Gateway Template](https://github.com/NVIDIA/OpenShell/blob/main/deploy/helm/openshell/templates/gateway.yaml) — Reference Gateway resource
- [OpenShell Helm GRPCRoute Template](https://github.com/NVIDIA/OpenShell/blob/main/deploy/helm/openshell/templates/grpcroute.yaml) — Reference GRPCRoute resource
- [BackendTLSPolicy on OpenShift](https://www.redhat.com/en/blog/backendtlspolicy-expands-gateway-api-transport-security) — Re-encrypt TLS via Gateway API
- [BackendTLSPolicy API Reference](https://gateway-api.sigs.k8s.io/reference/api-types/policy/backendtlspolicy/) — Spec structure and fields
- [Gateway API TLS Guide](https://gateway-api.sigs.k8s.io/guides/tls/) — TLS configuration patterns
- [OpenShell OIDC User Authentication](https://docs.nvidia.com/openshell/latest/kubernetes/access-control#oidc-user-authentication) — OIDC integration
- [OpenShell OIDC Values Reference](https://docs.nvidia.com/openshell/latest/kubernetes/access-control#oidc-values-reference) — OIDC helm values
- [OpenShell Helm Chart — `server.externalDbSecret`](https://github.com/NVIDIA/OpenShell/tree/main/deploy/helm/openshell) — External PostgreSQL integration
- [OpenShell Kubernetes Setup — External DB](https://docs.nvidia.com/openshell/latest/kubernetes/setup) — External DB documentation
- [cert-manager Helm Chart](https://artifacthub.io/packages/helm/cert-manager/cert-manager) — cert-manager installation via Helm (alternative to kubectl apply)
- [openshell-sandbox-provisioning.spec.md](./openshell-sandbox-provisioning.spec.md) — Gateway usage for sandboxing
- [control-plane.spec.md](./control-plane.spec.md) — Control plane architecture
- [data-model.spec.md](./data-model.spec.md) — Gateway kind definition
- [security/gateway-rbac-policy.spec.md](../security/gateway-rbac-policy.spec.md) — Gateway RBAC policy
- [ambient-api-server-db.yml](../../components/manifests/base/platform/ambient-api-server-db.yml) — Existing PostgreSQL deployment pattern
