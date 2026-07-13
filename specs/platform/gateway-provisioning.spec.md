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
- **SecurityContext:** `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, capabilities `drop: [ALL]`
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

## Audit-Driven Requirements

> Requirements in this section address findings from the 2026-07 ProdSec security audit.
> Each requirement references the originating finding ID (fNNN) for traceability.

### Requirement: Gateway Image Registry Allowlist (f018)

Gateway images SHALL be validated against a registry allowlist (matching or stricter
than `AllowedSandboxRegistries`), not just character-format validation. The current
`ValidateImageReference` performs only format checks, allowing tenants to specify
arbitrary container images (e.g., `attacker.registry/evil:latest`) that are deployed
with the gateway's privileged RBAC — holder of JWT signing keys, server TLS keys,
cluster-wide TokenReview, and sandbox CRUD.

Additionally:
1. Gateway TOML configuration overrides SHALL be replaced with a validated schema
   of tenant-tunable fields — free-form TOML allows weakening sandbox security settings
2. Gateway images SHOULD be pinned by digest, not mutable tags
3. The `allow_unauthenticated_users` field SHALL default to `false` and be validated
   at the reconciler level (see also f038 in openshell-sandbox-provisioning.spec.md)

#### Scenario: Attacker-controlled gateway image rejected

- GIVEN a Gateway resource with `image: attacker.registry/evil:latest`
- WHEN the GatewayReconciler validates the configuration
- THEN validation fails: "image registry not in allowlist"
- AND the gateway is NOT deployed

#### Scenario: Gateway TOML with unsafe settings rejected

- GIVEN a Gateway with config containing `allow_unauthenticated_users = true`
- WHEN the GatewayReconciler validates the configuration
- THEN validation fails: "allow_unauthenticated_users must be false"
- AND the gateway is NOT deployed

## References

- [OpenShell Gateway Helm Chart](https://github.com/NVIDIA/OpenShell/tree/main/deploy/helm/openshell)
- [openshell-sandbox-provisioning.spec.md](./openshell-sandbox-provisioning.spec.md) — Gateway usage for sandboxing
- [control-plane.spec.md](./control-plane.spec.md) — Control plane architecture
- [data-model.spec.md](./data-model.spec.md) — Gateway kind definition
