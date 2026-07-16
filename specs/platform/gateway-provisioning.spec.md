# Gateway Provisioning Specification

**Date:** 2026-07-07
**Status:** Design
**Supersedes:** Previous ConfigMap-based `platform-config` gateway provisioning design
**Related:** `openshell-sandbox-provisioning.spec.md` — gateway mode usage; `control-plane.spec.md` — CP reconciliation patterns; `data-model.spec.md` — Gateway kind definition
**Skill:** `skills/build/full-stack-pipeline/` — wave-based implementation pipeline

---

## Purpose

The control plane SHALL provision and reconcile OpenShell gateway deployments in project namespaces through a fully API-driven model. Gateway configuration is expressed as a first-class ACP resource (`kind: Gateway`), applied via `acpctl apply -k` alongside Project, Agent, Credential, and RoleBinding resources. The API server persists Gateway resources in PostgreSQL. The control plane discovers Gateway resources via the same gRPC watch stream used for all other resources and reconciles them into Kubernetes gateway deployments.

This replaces the previous ConfigMap-based `platform-config` approach. The ConfigMap, its watcher (`internal/gateway/config.go`), and the `initGatewayProvisioning()` startup path are eliminated.

This enables:
- **Unified declarative model** — Gateways are managed with the same `acpctl apply -k` workflow as Projects and Agents
- **Kustomize composition** — Gateway configuration inherits from bases and is patched via overlays, identical to all other ACP kinds
- **API-driven lifecycle** — Gateway state lives in PostgreSQL, not in a ConfigMap; standard CRUD operations apply
- **Shared kustomize library** — The rendering engine is extracted from `acpctl apply` into a reusable library consumed by both the CLI and the ApplicationReconciler
- **Full testability** — The shared kustomize library is unit-testable without a running cluster; `--dry-run` validates the full rendering pipeline

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
Kubernetes (StatefulSet, Service, RBAC, certgen Job, NetworkPolicy)
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

**TLS is NOT disabled.** The NVIDIA docs show `--set server.disableTls=true` for evaluation scenarios. ACP does NOT use this setting because BackendTLSPolicy (see `gateway-route-exposure.spec.md`) re-encrypts traffic from the networking Gateway to the pod, which requires the gateway to serve TLS. The gateway's self-signed certificate (generated by the certgen Job or cert-manager) is used for the backend TLS segment.

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
- AND the GatewayReconciler detects Gateway API availability for GRPCRoute provisioning (see `gateway-route-exposure.spec.md`)
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

### Backward Compatibility

When `OPENSHELL_USE_GATEWAY=false` (the default), all behavior is identical to the current system. The GatewayReconciler is only active when `OPENSHELL_USE_GATEWAY=true` and Gateway resources exist.

### Existing Consumers

| Consumer | Impact |
|---|---|
| `kube_reconciler.go` | No changes — continues to use gateways for sandbox creation |
| `openshell/gateway_client.go` | No changes — continues to use gateways for sandbox creation |
| `pod_sync.go` | No changes |
| `ApplicationReconciler` | Updated to use shared kustomize library; now supports `kind: Gateway` in rendered manifests |
| `acpctl apply` | Refactored to use shared kustomize library; now supports `kind: Gateway` |

---

## RBAC Requirements

The ACP ServiceAccount SHALL have sufficient permissions to:
- Watch Gateway resources via gRPC (existing API server watch mechanism)
- Create, update, patch, and get StatefulSets, Services, ServiceAccounts, Roles, RoleBindings, ConfigMaps, Jobs, and NetworkPolicies in project namespaces

---

## Configuration

### Environment Variables

No new environment variables are required for gateway provisioning. Gateway configuration is expressed declaratively via `kind: Gateway` resources. The existing `OPENSHELL_USE_GATEWAY=true` flag enables gateway mode, and the GatewayReconciler activates when Gateway resources are present.

### Gateway Resource Schema

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | Yes | — | Resource name (typically `openshell-gateway`) |
| `project` | Yes | — | Project name (determines target namespace) |
| `image` | No | `OPENSHELL_GATEWAY_IMAGE` env var | Gateway container image reference |
| `serverDnsNames` | Yes | — | DNS names for TLS certificate generation |
| `config` | No | — | OpenShell gateway TOML configuration (overrides defaults) |
| `oidc` | No | — | OIDC authentication configuration (see `gateway-oidc.spec.md`) |
| `route` | No | — | Route configuration for external exposure (see `gateway-route-exposure.spec.md`) |
| `route.host` | No | auto-derived | Hostname for the GRPCRoute |
| `routeAddress` | — | — | Read-only. External address populated by the control plane |

### Example

```yaml
kind: Gateway
name: openshell-gateway
project: tenant-a
image: ghcr.io/nvidia/openshell:v0.0.70
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
| `server.disableTls=true` | **NOT used.** BackendTLSPolicy re-encrypts traffic from the networking Gateway to the pod (see `gateway-route-exposure.spec.md`), requiring the gateway to serve TLS. TLS remains enabled on all clusters | N/A — intentionally omitted |

#### Values NOT mapped (no ACP equivalent yet)

These upstream Helm values are not currently used by ACP but may be relevant for future features:

| Helm value | Purpose | Notes |
|---|---|---|
| `workload.kind=deployment` | Use Deployment instead of StatefulSet | ACP always uses StatefulSet |
| `server.oidc.*` | OIDC configuration block | ACP injects OIDC via `gateway.toml` config, not Helm values (see `gateway-oidc.spec.md`) |
| `replicaCount` | Gateway replica count | ACP uses 1 replica (StatefulSet default) |

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
| `--set server.disableTls=true` | **NOT used** — BackendTLSPolicy re-encrypts to the pod (see `gateway-route-exposure.spec.md`) |

The NVIDIA docs note that the OpenShift install path is experimental and recommends `server.disableTls=true` for evaluation. ACP diverges from this recommendation by keeping TLS enabled, because BackendTLSPolicy re-encrypts traffic from the networking Gateway to the pod, requiring the gateway to terminate TLS on the backend segment.

---

## References

- [OpenShell Gateway Helm Chart](https://github.com/NVIDIA/OpenShell/tree/main/deploy/helm/openshell) — upstream chart source; consult `values.yaml` when adding new gateway configurations
- [NVIDIA OpenShell on OpenShift](https://docs.nvidia.com/openshell/kubernetes/openshift) — OpenShift-specific deployment (SCC, security context, TLS)
- [NVIDIA OpenShell Managing Certificates](https://docs.nvidia.com/openshell/kubernetes/managing-certificates) — cert-manager integration for TLS certificate lifecycle
- [cert-manager Helm Chart](https://artifacthub.io/packages/helm/cert-manager/cert-manager) — cert-manager installation via Helm (alternative to kubectl apply)
- [openshell-sandbox-provisioning.spec.md](./openshell-sandbox-provisioning.spec.md) — Gateway usage for sandboxing
- [control-plane.spec.md](./control-plane.spec.md) — Control plane architecture
- [data-model.spec.md](./data-model.spec.md) — Gateway kind definition
