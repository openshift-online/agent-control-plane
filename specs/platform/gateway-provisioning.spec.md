# Gateway Provisioning Specification

**Date:** 2026-06-26  
**Status:** Design  
**Related:** `openshell-sandbox-provisioning.spec.md` — gateway mode usage; `control-plane.spec.md` — CP reconciliation patterns  
**Skill:** `skills/build/full-stack-pipeline/` — wave-based implementation pipeline

---

## Purpose

The control plane SHALL provision and reconcile OpenShell gateway deployments in project namespaces. This replaces the assumption in `openshell-sandbox-provisioning.spec.md` (Iteration 1) that gateways are pre-installed. The control plane discovers which project namespaces to manage via a platform configuration ConfigMap and applies gateway resource manifests using Kubernetes APIs.

Gateway provisioning is an **infrastructure-layer capability**. Gateway state is NOT stored in PostgreSQL; the platform-config ConfigMap is the source of truth for which namespaces require gateways.

This enables:
- **Centralized gateway lifecycle management** — ACP team controls gateway versions
- **Deterministic deployments** — Gateway manifests versioned with ACP code
- **Self-service namespace provisioning** — Add namespace to ConfigMap → gateway auto-deploys
- **Consistent gateway configuration** — All tenants use the same vetted gateway configuration

---

## Requirements

### Requirement: Platform Configuration Discovery

The control plane SHALL read gateway configuration from a ConfigMap named `platform-config` in its own namespace. This ConfigMap SHALL contain a list of namespaces that the control plane is responsible for managing.

#### Scenario: Load platform configuration on startup

- GIVEN ACP starts up
- AND a ConfigMap named `platform-config` exists in the ACP namespace
- AND the ConfigMap contains a `namespaces` key with a YAML list
- WHEN ACP loads configuration
- THEN ACP SHALL parse the namespace list
- AND ACP SHALL store the list of project namespaces in memory

#### Scenario: Platform ConfigMap not found

- GIVEN ACP starts up
- AND the ConfigMap `platform-config` does NOT exist in the ACP namespace
- WHEN ACP attempts to load configuration
- THEN ACP SHALL log an error "platform-config ConfigMap not found"
- AND ACP SHALL NOT proceed with gateway deployments
- AND ACP SHALL retry loading the ConfigMap periodically

#### Scenario: Platform ConfigMap malformed

- GIVEN the `platform-config` ConfigMap exists
- AND the `namespaces` key contains invalid YAML
- WHEN ACP attempts to parse the ConfigMap
- THEN ACP SHALL log an error with parse failure details
- AND ACP SHALL NOT proceed with gateway deployments
- AND ACP SHALL wait for the ConfigMap to be corrected

#### Scenario: Platform ConfigMap updated at runtime

- GIVEN ACP is running with `platform-config` loaded in memory
- AND an admin updates the `platform-config` ConfigMap
- WHEN ACP detects the ConfigMap change
- THEN ACP SHALL reload the ConfigMap
- AND ACP SHALL update its in-memory namespace list
- AND ACP SHALL reconcile gateways based on the new configuration
- AND ACP SHALL deploy gateways for newly added namespaces
- AND ACP SHALL update gateway configurations for modified namespaces

---

### Requirement: Namespace Validation

For each namespace listed in the platform configuration, the control plane SHALL verify that the namespace exists in the cluster before attempting to deploy a gateway.

#### Scenario: All namespaces exist

- GIVEN `platform-config` lists namespaces: `tenant-alpha`, `tenant-beta`, `tenant-gamma`
- AND all three namespaces exist in the cluster
- WHEN ACP validates namespaces
- THEN ACP SHALL proceed with gateway reconciliation for all three namespaces

#### Scenario: Namespace does not exist

- GIVEN `platform-config` lists namespace `tenant-nonexistent`
- AND this namespace does NOT exist in the cluster
- WHEN ACP validates namespaces
- THEN ACP SHALL log an error "namespace tenant-nonexistent not found"
- AND ACP SHALL skip gateway deployment for that namespace
- AND ACP SHALL continue processing other valid namespaces
- AND ACP SHALL NOT crash or enter a crash loop

#### Scenario: Namespace deleted at runtime

- GIVEN ACP is managing `tenant-alpha` with a deployed gateway
- AND `platform-config` still lists `tenant-alpha`
- WHEN an admin deletes the namespace from the cluster
- THEN ACP SHALL detect the missing namespace in the next reconcile cycle
- AND ACP SHALL log a warning "namespace tenant-alpha listed in config but not found in cluster"
- AND ACP SHALL skip that namespace until it reappears or is removed from the ConfigMap
- AND the UI SHALL display the namespace in an "error" state with message "namespace not found in cluster"

**Note:** UI error state integration with existing namespace status representation is described in #158.

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

**Path validation:** Before constructing the shell command, each `sandbox_path` is validated against the regex `^/[a-zA-Z0-9/_.\-]+$` and checked for `..` traversal segments. Paths that fail validation are rejected before any SSH session is opened. This prevents shell injection via crafted payload paths in agent ConfigMaps. The path constraint is defined in `agent-sandbox-config.spec.md` § Payloads.

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
- AND it SHALL validate each `sandbox_path` against the path allowlist (`^/[a-zA-Z0-9/_.\-]+$`, no `..` traversal) before constructing any shell command
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

### Requirement: Gateway Manifest Loading

The control plane SHALL load gateway resource manifests from its container filesystem. Gateway manifests SHALL be stored in the ACP codebase and packaged into the ACP container image.

Gateway manifests SHALL be generated via `helm template` with namespace-specific configuration from the platform ConfigMap, including:
- `gateway.image` → image reference
- `gateway.serverDnsNames` → PKI init job serverDnsNames (e.g., `openshell-gateway.<namespace>.svc.cluster.local`)
- `gateway.config` → TOML configuration injected into gateway ConfigMap

**Helm command reference:**
```bash
helm template openshell-gateway oci://ghcr.io/nvidia/openshell/helm-chart \
  --namespace <tenant-namespace> \
  --set "pkiInitJob.serverDnsNames={openshell-gateway.<tenant-namespace>.svc.cluster.local}"
```

The generated manifests SHALL be placed at `components/ambient-control-plane/manifests/gateway/` in the ACP codebase and packaged into the container image.

#### Scenario: Load gateway manifests from filesystem

- GIVEN ACP container includes gateway manifests at `/manifests/gateway/`
- AND the directory contains files: `deployment.yaml`, `service.yaml`, `serviceaccount.yaml`, `rbac.yaml`
- WHEN ACP loads gateway manifests
- THEN ACP SHALL read all YAML files from the manifests directory
- AND ACP SHALL parse each file into Kubernetes resource objects

#### Scenario: Required manifest file missing

- GIVEN ACP container is expected to have `/manifests/gateway/deployment.yaml`
- AND this file does NOT exist
- WHEN ACP attempts to load manifests
- THEN ACP SHALL log an error "required manifest file not found: /manifests/gateway/deployment.yaml"
- AND ACP SHALL NOT proceed with gateway deployments
- AND ACP SHALL exit with a non-zero code

---

### Requirement: Gateway Deployment

For each project namespace, the control plane SHALL deploy an OpenShell gateway by applying the loaded manifests to the namespace. The gateway SHALL consist of a Deployment, Service, ServiceAccount, and RBAC resources.

All gateway resources SHALL use fixed names:
- Deployment: `openshell-gateway`
- Service: `openshell-gateway`
- ServiceAccount: `openshell-gateway`
- Role: `openshell-gateway`
- RoleBinding: `openshell-gateway`

All gateway resources SHALL carry the following labels:
- `app.kubernetes.io/name=openshell`
- `app.kubernetes.io/component=gateway`
- `app.kubernetes.io/managed-by=agent-control-plane`

The gateway Deployment SHALL specify:
- **SecurityContext:** `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, capabilities `drop: [ALL]`
- **Resource requests:** `cpu: 100m`, `memory: 256Mi`
- **Resource limits:** `cpu: 500m`, `memory: 512Mi`

Gateway resources SHALL NOT have OwnerReferences (consistent with current session pod pattern where resources are managed via labels, not ownership chains).

#### Scenario: Deploy gateway to empty namespace

- GIVEN `tenant-alpha` namespace exists
- AND no OpenShell gateway is deployed in `tenant-alpha`
- WHEN ACP reconciles gateways
- THEN ACP SHALL apply all gateway manifests to `tenant-alpha`
- AND each resource SHALL have its namespace field set to `tenant-alpha`
- AND the gateway Deployment SHALL be created
- AND the gateway Service SHALL be created with label `app.kubernetes.io/name=openshell`
- AND the ServiceAccount and RBAC resources SHALL be created

#### Scenario: Gateway already exists (idempotency)

- GIVEN `tenant-alpha` has an OpenShell gateway already deployed
- AND `platform-config` lists `tenant-alpha`
- WHEN ACP reconciles gateways
- THEN ACP SHALL detect the existing gateway via Service label `app.kubernetes.io/name=openshell`
- AND ACP SHALL apply the latest gateway configurations using client-go Server-Side Apply (SSA) or equivalent
- AND ACP SHALL NOT create duplicate resources
- AND ACP MAY verify the gateway is healthy

#### Scenario: Multiple namespaces, parallel deployment

- GIVEN `platform-config` lists 10 namespaces without gateways
- WHEN ACP reconciles gateways on startup
- THEN ACP SHALL deploy gateways to all 10 namespaces
- AND deployments MAY execute in parallel
- AND failure in one namespace SHALL NOT block deployments in other namespaces

---

### Requirement: Gateway Discovery

The control plane SHALL discover existing gateways in a namespace by looking for a Service with the label `app.kubernetes.io/name=openshell`.

#### Scenario: Gateway detected via Service label

- GIVEN `tenant-alpha` has a Service with label `app.kubernetes.io/name=openshell`
- WHEN ACP checks for an existing gateway
- THEN ACP SHALL consider the gateway as already deployed
- AND ACP SHALL NOT attempt to create a new gateway

#### Scenario: Service exists but Deployment missing

- GIVEN `tenant-alpha` has a Service with label `app.kubernetes.io/name=openshell`
- AND the corresponding Deployment does NOT exist
- WHEN ACP reconciles gateways
- THEN ACP SHALL detect the inconsistent state
- AND ACP SHALL create the missing Deployment
- AND ACP SHALL log a warning "inconsistent state detected: Service exists without Deployment"

---

### Requirement: Gateway Version Updates

When the gateway manifests in the ACP codebase are updated, the control plane SHALL detect drift between deployed gateway resources and the new manifests, and update the deployed resources accordingly.

Drift detection enables automated gateway updates without manual intervention. When ACP is upgraded with new gateway manifests (e.g., new image version, configuration changes), it SHALL automatically roll out the updates to all managed namespaces.

#### Scenario: Detect drift after ACP upgrade

- GIVEN `tenant-alpha` has gateway v0.0.70 deployed
- AND ACP is upgraded with manifests specifying gateway v0.0.71
- WHEN ACP reconciles gateways after the upgrade
- THEN ACP SHALL detect that the deployed Deployment differs from the manifest
- AND ACP SHALL update the Deployment to v0.0.71
- AND the update SHALL be a rolling update (zero downtime)

**Note:** Drift detection mechanism (template hash annotations, image tag comparison, resource spec comparison) is implementation-specific.

---

### Requirement: Dynamic Configuration Updates

The control plane SHALL detect changes to the platform-config ConfigMap and reconcile gateway state accordingly.

When a new namespace is added to the platform configuration, the control plane SHALL deploy a gateway to the new namespace.

**Note:** Implementation MAY use Kubernetes ConfigMap watch (recommended) or periodic polling to detect configuration changes.

#### Scenario: New namespace added to ConfigMap

- GIVEN ACP is managing `tenant-alpha` and `tenant-beta`
- AND an admin updates `platform-config` to add `tenant-gamma`
- WHEN ACP detects the ConfigMap change
- THEN ACP SHALL validate that `tenant-gamma` namespace exists
- AND ACP SHALL deploy a gateway to `tenant-gamma`
- AND the existing gateways in `tenant-alpha` and `tenant-beta` SHALL NOT be modified

---

### Requirement: Gateway Deployment Failure Handling

When gateway deployment fails (e.g., ImagePullBackOff, insufficient permissions), the control plane SHALL log the error and retry on subsequent reconcile cycles without crashing.

#### Scenario: Image pull failure

- GIVEN ACP attempts to deploy a gateway to `tenant-alpha`
- AND the gateway manifest specifies an image that does not exist
- WHEN Kubernetes attempts to pull the image
- THEN the Deployment SHALL enter ImagePullBackOff state
- AND ACP SHALL log an error with the namespace and failure reason
- AND ACP SHALL retry on the next reconcile cycle
- AND ACP SHALL NOT mark the namespace as permanently failed

#### Scenario: Insufficient RBAC permissions

- GIVEN ACP ServiceAccount does NOT have permission to create Deployments in `tenant-alpha`
- WHEN ACP attempts to apply gateway manifests
- THEN the Kubernetes API SHALL return a Forbidden error
- AND ACP SHALL log an error "insufficient permissions to create Deployment in namespace tenant-alpha"
- AND ACP SHALL continue processing other namespaces where it has permissions

---

### Requirement: Platform ConfigMap Gateway Configuration Mandatory

When a namespace entry exists in the platform configuration, it MUST include gateway configuration. If gateway configuration is missing, the control plane SHALL log an error and skip that namespace.

This requirement ensures explicit configuration for all gateways and prevents unexpected deployments with unconfigured gateway instances.

#### Scenario: Namespace with missing gateway configuration

- GIVEN `OPENSHELL_USE_GATEWAY=true` in ACP environment
- AND `platform-config` contains:
  ```yaml
  namespaces:
    - name: tenant-alpha
  ```
- WHEN ACP processes the ConfigMap
- THEN ACP SHALL log an error "namespace tenant-alpha missing required gateway configuration"
- AND ACP SHALL skip gateway deployment for that namespace
- AND ACP SHALL continue processing other namespaces

#### Scenario: Namespace with complete gateway configuration

- GIVEN `platform-config` contains:
  ```yaml
  namespaces:
    - name: tenant-alpha
      gateway:
        image: ghcr.io/nvidia/openshell:v0.0.70
        serverDnsNames:
          - openshell-gateway.tenant-alpha.svc.cluster.local
        config: |
          [openshell.gateway]
          bind_address = "0.0.0.0:8080"
  ```
- WHEN ACP processes the ConfigMap
- THEN ACP SHALL deploy the gateway to `tenant-alpha` with the specified configuration
- AND no namespace-specific customization SHALL be applied

**Note:** If `OPENSHELL_USE_GATEWAY=false` or the feature is disabled, missing gateway configuration SHALL NOT trigger errors.

---

### Requirement: Separation from Agent Configuration

Gateway provisioning SHALL be independent of agent definitions. Agent-specific configuration (schedules, prompts, policies) is out of scope for this specification.

**Note:** Future work may introduce per-tenant agent ConfigMaps that ACP discovers, but the schema and discovery mechanism are not defined in this specification.

---

## Migration

### Relationship to Existing Specs

This specification supersedes the "Gateway provisioning" constraint in `openshell-sandbox-provisioning.spec.md` (line 20-22), which stated:

> "Gateway provisioning — the OpenShell gateway is assumed to already be deployed in each project namespace; ACP will not create it. A future iteration should have the control plane provision and reconcile gateway lifecycle per project namespace..."

This specification IS that future iteration.

### Backward Compatibility

This is a new capability. When disabled (no `platform-config` ConfigMap), ACP behavior is unchanged — it will not attempt to manage gateways.

When enabled, this specification does NOT conflict with:
- Existing gateway mode (`OPENSHELL_USE_GATEWAY=true`) — that controls whether sessions use the gateway for sandboxing
- File mode (`OPENSHELL_ENABLED=true`) — unaffected
- Direct pod mode (`OPENSHELL_USE_GATEWAY=false`, `OPENSHELL_ENABLED=false`) — unaffected

### Existing Consumers

| Consumer | Impact |
|---|---|
| `kube_reconciler.go` | No changes — gateway provisioning is a separate reconciler |
| `openshell/gateway_client.go` | No changes — continues to use gateways for sandbox creation |
| `pod_sync.go` | No changes |
| `StandardNamespaceProvisioner` | No changes — continues to create/verify namespaces as before |

**Note:** Namespaces MAY be managed by ACP (current behavior) or externally via App Interface. Gateway provisioning works with both models — it only requires that namespaces exist before gateway deployment.

---

## Configuration

### Environment Variables

No new environment variables are required. Gateway provisioning is enabled by the presence OPENSHELL_USE_GATEWAY=true

### ConfigMap Schema

**Name:** `platform-config`  
**Namespace:** Same namespace where ACP is deployed (e.g., `ambient-code`)

**Required Keys:**
- `namespaces` (string, YAML format) — List of namespace objects with gateway configuration

**Example:**
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: platform-config
  namespace: ambient-code
data:
  namespaces: |
    - name: tenant-alpha
      gateway:
        image: ghcr.io/nvidia/openshell:v0.0.70
        serverDnsNames:
          - openshell-gateway.tenant-alpha.svc.cluster.local
        config: |
          [openshell.gateway]
          bind_address = "0.0.0.0:8080"
          log_level = "info"
          sandbox_namespace = "tenant-alpha"
          default_image = "ghcr.io/nvidia/openshell-community/sandboxes/base:latest"
          supervisor_image = "ghcr.io/nvidia/openshell/supervisor:0.0.63"
          
          [openshell.gateway.auth]
          allow_unauthenticated_users = true
    
    - name: tenant-beta
      gateway:
        image: ghcr.io/nvidia/openshell:v0.0.70
        serverDnsNames:
          - openshell-gateway.tenant-beta.svc.cluster.local
        # config field optional - uses defaults if omitted
    
    - name: tenant-gamma
      gateway:
        image: ghcr.io/nvidia/openshell:v0.0.70
        serverDnsNames:
          - openshell-gateway.tenant-gamma.svc.cluster.local
```

**Gateway Configuration Fields:**
- `gateway.image` (optional) — Gateway container image (defaults to `OPENSHELL_GATEWAY_IMAGE` env var)
- `gateway.serverDnsNames` (required) — DNS names for TLS certificate generation
- `gateway.config` (optional) — OpenShell gateway TOML configuration (overrides defaults from base manifests)

---

## RBAC Requirements

The ACP ServiceAccount SHALL have sufficient permissions to:
- Get and watch ConfigMaps in its own namespace (to load and detect changes to `platform-config`)
- List and get namespaces (to validate namespace existence)
- Create, update, patch, and get Deployments, Services, ServiceAccounts, Roles, and RoleBindings in project namespaces

**Note:** The exact ClusterRole definition will be determined during implementation. The control plane follows the principle of least privilege — permissions are scoped to only what is necessary for gateway provisioning.

---

## Template Packaging

Gateway manifests SHALL be:
- Stored in the ACP codebase at `components/ambient-control-plane/manifests/gateway/`
- Generated once during development using `helm template` (NOT Helm at runtime)
- Packaged into the ACP container image at build time
- Read from the container filesystem at `/manifests/gateway/` at runtime

**Manifest files:**
- `deployment.yaml` — Gateway Deployment
- `service.yaml` — Gateway Service
- `serviceaccount.yaml` — ServiceAccount for gateway pods
- `rbac.yaml` — Role/RoleBinding for gateway ServiceAccount

---

## Future Work

The following capabilities are deferred to future iterations:

1. **Namespace-specific gateway configuration:** Different namespaces MAY require different gateway settings (e.g., resource limits, image overrides). This can be added via additional fields in the platform-config namespace entries.

2. **Advanced drift detection:** The initial implementation MAY use a create-only pattern (matching current session pod behavior). Future iterations can add hash-based drift detection or spec comparison for automatic updates.

---

## References

- [OpenShell Gateway Helm Chart](https://github.com/NVIDIA/OpenShell/tree/main/deploy/helm/openshell)
- [openshell-sandbox-provisioning.spec.md](./openshell-sandbox-provisioning.spec.md) — Gateway usage for sandboxing
- [control-plane.spec.md](./control-plane.spec.md) — Control plane architecture
- Design document: `gateway-provisioning-design-es.md`
