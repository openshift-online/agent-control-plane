# OpenShell Sandbox Provisioning Specification

**Date:** 2026-06-23
**Status:** Design
**Related:** `control-plane.spec.md` — CP provisioning; `openshell-sandbox.spec.md` — file-mode sandbox
**Skill:** `skills/build/full-stack-pipeline/` — wave-based implementation pipeline

---

## Purpose

When the platform operates in OpenShell mode, the control plane SHALL delegate agent pod creation to an OpenShell gateway running in each project namespace, instead of creating Kubernetes pods directly. This provides policy-enforced sandboxing (network, filesystem, process controls) for all agent sessions through OpenShell's security layer.

The OpenShell gateway exposes a gRPC service (`openshell.v1.OpenShell`) that manages sandbox lifecycle. Each project namespace has an OpenShell gateway pre-installed via Helm chart. The control plane discovers it via Kubernetes Service DNS.

### Iteration 1 Constraints

This iteration is scoped to **scheduled agent runs** (single-run, short-lived sessions). The following are explicitly out of scope:

- **Long-running / steerable sessions** — credential lifecycle concerns (token expiry mid-session, gateway-managed refresh via OAuth2/client-credentials flows) are deferred
- **Gateway provisioning** — the OpenShell gateway is assumed to already be deployed in each project namespace; ACP will not create it. A future iteration should have the control plane provision and reconcile gateway lifecycle per project namespace (potentially adapting the [upstream Helm chart values](https://github.com/NVIDIA/OpenShell/blob/main/deploy/helm/openshell/values.yaml) into a managed resource)
- **Namespace-level credential storage** — credentials remain stored in ACP, not as Kubernetes Secrets in the project namespace. A future iteration should store credentials as Kubernetes Secrets in each project namespace, with ACP reading them from the Secret and passing them to the gateway when configuring providers. This indirection is necessary because the gateway does not yet support loading credentials directly from Kubernetes Secrets ([OpenShell#1882](https://github.com/NVIDIA/OpenShell/issues/1882))
- **Network policy ownership** — OpenShell policies (including network egress rules allowing runner-to-control-plane gRPC) will be user-configurable via the Agent spec. Whether ACP auto-injects the control plane egress rule on top of the user-configured policy or requires users to include it explicitly is TBD

### Relationship to [openshell-sandbox.spec.md]

This specification defines **gateway mode** — an alternative to the **file mode** sandbox approach defined in [openshell-sandbox.spec.md]. Both modes coexist and are selectable at deployment time via the `OPENSHELL_USE_GATEWAY` environment variable.

**File mode** (existing, [openshell-sandbox.spec.md]): The OpenShell Supervisor binary runs inside the runner container, wrapping the Claude Agent SDK runner process directly. Requires policy ConfigMap propagation, elevated container security context, and the Supervisor binary baked into the runner image.

**Gateway mode** (this spec): The OpenShell gateway owns sandbox lifecycle, policy enforcement, network isolation, and credential injection. The control plane delegates to the gateway via gRPC instead of creating pods directly. Sandboxes created by the gateway contain a Supervisor, but the gateway manages its configuration and security context — the control plane does not need to propagate policy ConfigMaps, grant elevated capabilities, or configure the Supervisor. ACP will attach a user-configured policy (defined via the Agent spec) to each sandbox using the equivalent logic as `openshell sandbox create --policy ./my-policy.yaml -- claude`.

The sandbox security guarantees (network namespace isolation, TLS proxy, Landlock filesystem isolation, process privilege drop, seccomp-BPF filtering) are equivalent in both modes. Both use an in-container Supervisor — file mode requires the control plane to configure it (policy mounts, elevated SecurityContext), while gateway mode delegates that responsibility to the gateway.

File mode SHALL remain fully functional as a rollback path in case the gateway's added operational complexity proves too costly to manage. The mode selection is controlled by a single environment variable with no changes to the file-mode code path.

---

## Requirements

### Requirement: Gateway-Based Sandbox Creation

When `OPENSHELL_USE_GATEWAY` is true, the control plane SHALL create agent sandboxes by calling the OpenShell gateway's `CreateSandbox` gRPC RPC instead of creating Kubernetes pods directly. When `OPENSHELL_USE_GATEWAY` is false, the existing provisioning path SHALL be used unchanged (either file-mode sandbox or direct pod creation, depending on `OPENSHELL_ENABLED`).

#### Scenario: Session provisioning with gateway mode

- GIVEN `OPENSHELL_USE_GATEWAY` is `true`
- AND an OpenShell gateway is running in the project namespace
- WHEN a session transitions to `Pending` phase
- THEN the control plane SHALL call `CreateSandbox` on the gateway in the session's project namespace
- AND the sandbox SHALL be created with the runner image, session environment variables, and attached credential providers
- AND the session phase SHALL transition to `Running`

#### Scenario: Session provisioning without gateway mode

- GIVEN `OPENSHELL_USE_GATEWAY` is `false`
- WHEN a session transitions to `Pending` phase
- THEN the control plane SHALL use the existing provisioning path (direct pod creation, with file-mode sandbox if `OPENSHELL_ENABLED` is true)
- AND no interaction with the OpenShell gateway SHALL occur and no OpenShell gateway will be provisioned/reconciled

#### Scenario: Gateway unreachable

- GIVEN `OPENSHELL_USE_GATEWAY` is `true`
- AND the OpenShell gateway in the project namespace is unreachable
- WHEN the control plane attempts to create a sandbox
- THEN the operation SHALL fail with an error
- AND the control plane SHALL NOT fall back to file-mode sandbox or direct pod creation

### Requirement: Gateway Discovery via Service

The control plane SHALL discover the OpenShell gateway in each project namespace by looking up the Kubernetes Service associated with the gateway's gRPC endpoint. The gateway SHALL be deployed without a Route to prevent external access from outside the cluster — all communication between ACP and the gateway is cluster-internal.

#### Scenario: Service-based discovery

- GIVEN an OpenShell gateway is deployed in namespace `my-project`
- WHEN the control plane needs to reach the gateway
- THEN it SHALL list Services in namespace `my-project` matching a well-known label (e.g., `app.kubernetes.io/name=openshell`)
- AND it SHALL extract the gateway endpoint from the Service's cluster DNS name and gRPC port

#### Scenario: Service not found

- GIVEN `OPENSHELL_USE_GATEWAY` is `true`
- AND no matching Service is found in the project namespace
- WHEN the control plane attempts to discover the gateway
- THEN it SHALL fail with an error indicating the gateway Service was not found

### Requirement: Sandbox Identity and Naming

Each sandbox SHALL have a deterministic name derived from the session ID using the existing `safeResourceName()` helper ([kube_reconciler.go]), and SHALL carry labels that identify the owning session and project.

Sandbox naming follows the same `session-<safe_name>` pattern used by pods (`podName()`), services (`serviceName()`), and service accounts (`serviceAccountName()`). The `safeResourceName()` helper lowercases the ID and truncates to 40 characters. Session IDs are KSUIDs (27 base62-encoded characters, alphanumeric only), so truncation never removes significant characters and lowercasing is defensive — KSUIDs contain no hyphens or DNS-unsafe characters. If the ID format changes in the future, the 40-character truncation limit would need to be reassessed for collision risk.

#### Scenario: Sandbox naming

- GIVEN a session with KSUID `2ORepVoGXMgXQMCzlOkzm8KVqDP`
- WHEN a sandbox is created for this session
- THEN the sandbox name SHALL be `session-2orepvogxmgxqmczlokzm8kvqdp` (via `safeResourceName()`: lowercased, 27 chars, no truncation)
- AND the sandbox SHALL carry labels `ambient-code.io/session-id`, `ambient-code.io/project-id`, `ambient-code.io/managed=true`, and `ambient-code.io/managed-by=ambient-control-plane`

#### Scenario: Idempotent creation

- GIVEN a sandbox already exists for a session
- WHEN the control plane reconciles the same session again
- THEN it SHALL detect the existing sandbox via `GetSandbox` and skip creation

### Requirement: Security Context Delegation

In gateway mode, the control plane SHALL NOT set a SecurityContext on the runner container. The OpenShell gateway owns pod creation and applies its own security settings — including the SCC, capabilities, and privilege configuration recommended by the [OpenShell OpenShift deployment guide](https://docs.nvidia.com/openshell/kubernetes/openshift). The gateway's sandbox service account is bound to the required SCC as part of the pre-deployed Helm installation. The [Sandbox CRD](https://docs.nvidia.com/openshell/kubernetes/setup#install-agent-sandbox) and the [privileged SCC grant for sandbox pods](https://docs.nvidia.com/openshell/kubernetes/openshift#grant-the-privileged-scc-to-sandbox-pods) are assumed to be pre-installed on the cluster.

This is a significant change from file mode, where the control plane must grant elevated privileges (`root`, `SYS_ADMIN`, `NET_ADMIN`, `SYS_PTRACE`, `SETUID`, `SETGID`, `CHOWN`, `DAC_OVERRIDE`, seccomp `Unconfined`) to the runner container so the in-container Supervisor can create network namespaces and drop privileges. In gateway mode, the Supervisor is still present inside the sandbox, but the gateway configures it — the control plane's [`buildRunnerSecurityContext()`][kube_reconciler.go] and `buildVolumes()` (OpenShell policy mount) are not invoked.

#### Scenario: Gateway mode — no ACP-managed SecurityContext

- GIVEN `OPENSHELL_USE_GATEWAY` is `true`
- WHEN the control plane provisions a session
- THEN it SHALL NOT build a pod spec or set a container SecurityContext
- AND it SHALL NOT propagate the OpenShell policy ConfigMap
- AND it SHALL NOT add the `/etc/openshell` volume mount
- AND the `CreateSandboxRequest` SHALL contain only image, environment, and provider references
- AND all pod-level security settings SHALL be the gateway's responsibility

#### Scenario: File mode — elevated SecurityContext preserved

- GIVEN `OPENSHELL_USE_GATEWAY` is `false` and `OPENSHELL_ENABLED` is `true`
- WHEN the control plane provisions a session
- THEN it SHALL apply the elevated SecurityContext as defined in [openshell-sandbox.spec.md § Container Security Context][sandbox-security-context]
- AND behavior SHALL be identical to the current file-mode implementation

### Requirement: Credential Mapping to OpenShell Providers

The control plane SHALL map ambient platform credentials to project-scoped OpenShell providers, replacing the credential sidecar container pattern. Providers are scoped to the project namespace — all sandboxes within a namespace may bind to a credential provider within the set of providers provisioned on the gateway in that namespace. The control plane ensures providers exist before creating sandboxes and updates them when credentials change.

The gateway's egress proxy resolves credential placeholders to real values at request time — the agent process inside the sandbox never holds real credentials, only opaque placeholders. This means provider updates take effect immediately for subsequent requests without restarting any sandbox. If the proxy encounters a placeholder it cannot resolve, it rejects the request with HTTP 500 rather than forwarding the raw placeholder upstream (fail-closed).

#### Scenario: Ensuring project providers exist

- GIVEN a project has configured credentials for `github` and `anthropic`
- WHEN the control plane provisions a sandbox in that project's namespace
- THEN it SHALL ensure an OpenShell provider exists for each credential via `CreateProvider` (idempotent — skip if already exists)
- AND the `github` credential SHALL map to OpenShell provider type `github`
- AND the `anthropic` credential SHALL map to OpenShell provider type `claude`
- AND providers for unrecognized types SHALL use the `generic` OpenShell provider type
- AND each provider name SHALL be scoped to the project (e.g., `<project_name>-github`)

#### Scenario: Partial provider creation failure

- GIVEN a project has configured credentials for `github` and `anthropic`
- WHEN `CreateProvider` succeeds for `github` but fails for `anthropic`
- THEN the control plane SHALL NOT proceed with sandbox creation
- AND the session SHALL remain in `Pending` phase until the next reconciliation attempt
- AND the successfully created provider SHALL persist (it is project-scoped and reusable)

#### Scenario: Attaching providers to sandbox

In iteration 1, all providers in the namespace are attached to every sandbox. A future iteration should attach only the providers that the user has indicated the sandbox needs via the Agent configuration spec.

- GIVEN project-scoped providers exist in the namespace
- WHEN a sandbox is created for a session
- THEN the `CreateSandboxRequest.Spec.Providers` field SHALL list all project provider names
- AND the OpenShell gateway SHALL inject credentials transparently via its egress proxy

#### Scenario: Credential rotation

- GIVEN a project with active providers attached to one or more sandboxes
- WHEN an ambient credential configuration changes (e.g., token rotation)
- THEN the control plane SHALL call `UpdateProvider` on the gateway with the new credential values
- AND the gateway's egress proxy SHALL resolve subsequent requests to the updated credentials at request time
- AND no sandboxes SHALL be restarted

#### Scenario: Provider type mapping

- GIVEN the following ambient credential provider names
- THEN they SHALL map to OpenShell provider types as follows (see [supported provider types](https://docs.nvidia.com/openshell/sandboxes/manage-providers#supported-provider-types) and [supported inference providers](https://docs.nvidia.com/openshell/sandboxes/manage-providers#supported-inference-providers)):

| Ambient Provider | OpenShell Type |
|---|---|
| `github` | `github` |
| `anthropic` | `claude` |
| `claude` | `claude` |
| `jira` | `generic` |
| `google` | `generic` |
| `vertex` | `vertex-prod` |
| `kubeconfig` | `generic` |
| (unknown) | `generic` |

### Requirement: Sandbox Environment Variables

The control plane SHALL pass session configuration to the sandbox as environment variables in the `CreateSandboxRequest.Spec.Template.Environment` map. OpenShell injects its own environment variables into the sandbox based on the attached provider types (see [supported provider types](https://docs.nvidia.com/openshell/sandboxes/manage-providers#supported-provider-types)). The control plane MUST NOT override these provider-injected variables.

#### Scenario: Environment variable translation

- GIVEN a session with LLM model, prompt, repo URL, and proxy settings
- WHEN the sandbox is created
- THEN all environment variables from `buildEnv()` that have literal string values SHALL be included
- AND Kubernetes-specific `valueFrom` / `fieldRef` entries (e.g., `POD_IP`) SHALL be omitted

#### Scenario: Provider-injected environment variable protection

- GIVEN a sandbox with attached providers that inject environment variables (e.g., `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`)
- WHEN `buildEnv()` produces an environment variable with the same name as one injected by an attached provider
- THEN the control plane SHALL exclude that variable from the `CreateSandboxRequest` environment
- AND the provider-injected value SHALL take precedence
- AND the control plane SHALL log a warning identifying the skipped variable

### Requirement: Sandbox Deprovisioning

When a session is stopped or deleted, the control plane SHALL delete the sandbox via the OpenShell gateway. Project-scoped providers are NOT deleted as part of session cleanup — they persist in the namespace for use by other sessions.

#### Scenario: Session stopping

- GIVEN a running session with an active sandbox
- WHEN the session phase transitions to `Stopping`
- THEN the control plane SHALL call `DeleteSandbox` with the session's sandbox name
- AND the session phase SHALL transition to `Stopped`
- AND project-scoped providers SHALL NOT be deleted

#### Scenario: Session deletion

- GIVEN a session with an associated sandbox
- WHEN the session is deleted
- THEN the control plane SHALL delete the sandbox
- AND the control plane SHALL continue to clean up Kubernetes resources (service accounts, secrets, services) as before
- AND project-scoped providers SHALL NOT be deleted

### Requirement: Dual-Signal Session Lifecycle

Session lifecycle in gateway mode SHALL be determined by two complementary signals: **runner gRPC events** (primary) and **gateway sandbox status** (secondary). The runner pushes AG-UI events (`RUN_STARTED`, `RUN_FINISHED`, etc.) to the control plane via gRPC — this is the same event flow used in file mode and direct pod mode, and provides authoritative, explicit lifecycle signals. The gateway sandbox status acts as a fallback for cases where the runner cannot report (crash, OOM, sandbox eviction).

The sandbox base image SHALL include the runner, so the existing runner → control plane gRPC event push continues to function inside gateway-managed sandboxes. The sandbox network policy SHALL permit egress to the control plane's gRPC endpoint.

**Tracking mechanism:** The session phase in PostgreSQL serves as the persistence mechanism for `RUN_FINISHED` receipt. When the runner pushes `RUN_FINISHED`, the session transitions to `Completed` — this is the existing behavior. The status syncer SHALL only check sandbox status for sessions still in `Running` phase; sessions already in a terminal phase (`Completed`, `Failed`, `Stopped`) are skipped. This means no additional state tracking is required — the session phase itself is the durable record of whether the runner reported completion, and the design is safe across control plane restarts.

#### Scenario: Normal completion via runner event

- GIVEN a session in `Running` phase inside a gateway-managed sandbox
- WHEN the runner pushes a `RUN_FINISHED` event to the control plane
- THEN the session phase SHALL transition to `Completed` (existing behavior, unchanged)
- AND the sandbox MAY be cleaned up by the gateway after the runner process exits
- AND subsequent status syncer polls SHALL skip this session (terminal phase)

#### Scenario: Abnormal termination via sandbox disappearance

- GIVEN a session in `Running` phase with an active sandbox
- AND the gateway is reachable
- WHEN the status syncer calls `GetSandbox` and receives a not-found response
- THEN the session phase SHALL transition to `Failed`
- AND the syncer SHALL log a warning with the session ID and sandbox name indicating the sandbox disappeared without a runner completion event

#### Scenario: Sandbox disappearance after runner completion

- GIVEN a session in a terminal phase (`Completed`, `Failed`, or `Stopped`)
- WHEN the status syncer evaluates this session
- THEN it SHALL skip sandbox status checks entirely (terminal phases are not synced)
- AND no `GetSandbox` call SHALL be made for sessions in terminal phases

### Requirement: Sandbox Status Syncing

The status syncer SHALL poll the OpenShell gateway for sandbox phase as a secondary signal, but only for sessions still in `Running` phase. Sessions in terminal phases (`Completed`, `Failed`, `Stopped`) are skipped entirely — no gateway calls are made. The syncer SHALL reuse the existing `podSyncInterval` (15 seconds) from [pod_sync.go] for its polling interval. The OpenShell `SandboxPhase` enum does not include a `SUCCEEDED` or `COMPLETED` state, and `SandboxStatus` does not expose an exit code. The gateway sandbox phase is used to detect error conditions and abnormal terminations that the runner cannot self-report.

> **Future optimization:** The OpenShell proto defines a `WatchSandbox` streaming RPC that could replace polling with push-based status updates. Since the control plane already uses gRPC streaming for API server events ([watcher.go]), adopting `WatchSandbox` would be a natural improvement in a later iteration.

#### Scenario: Sandbox phase mapping

- GIVEN a session in `Running` phase with an active sandbox
- WHEN the status syncer polls the gateway
- THEN sandbox phases SHALL map to session phases as follows:

| Sandbox State | Session Phase | Rationale |
|---|---|---|
| Sandbox exists, phase `PROVISIONING` | (no change) | Sandbox is starting up |
| Sandbox exists, phase `READY` | (no change) | Runner is executing normally |
| Sandbox exists, phase `ERROR` | `Failed` | Gateway detected an error |
| Sandbox exists, phase `DELETING` | (no change) | Gateway is cleaning up |
| Sandbox exists, phase `UNKNOWN` | (no change, log warning) | Transient or unexpected state |
| Sandbox not found | `Failed` | Abnormal termination (sandbox disappeared while session still Running) |

Sessions in terminal phases are not listed because the syncer skips them before reaching the gateway call.

#### Scenario: Gateway unreachable during sync

- GIVEN the gateway is temporarily unreachable (connection refused, deadline exceeded, or other transport error)
- WHEN the status syncer polls
- THEN it SHALL log a warning and retry on the next sync cycle
- AND it SHALL NOT change the session phase
- AND it SHALL NOT treat the unreachable gateway as sandbox disappearance

### Requirement: Sandbox Network Policy for Runner Events

The OpenShell sandbox network policy SHALL permit the runner process to push gRPC events to the control plane backend. Without this, the runner cannot report `RUN_FINISHED` and all sandbox exits would be treated as abnormal terminations.

#### Scenario: Runner gRPC egress permitted

- GIVEN a sandbox is created via the OpenShell gateway
- WHEN the runner process attempts to push AG-UI events to the control plane's gRPC endpoint
- THEN the sandbox network policy SHALL allow the connection
- AND the runner SHALL push events using the same gRPC protocol as in file mode and direct pod mode

### Requirement: Proto Vendoring and Code Generation

The control plane SHALL vendor OpenShell proto definitions and generate Go gRPC client stubs using buf v2, following the same pattern as the ambient-api-server.

#### Scenario: Proto file structure

- GIVEN the OpenShell proto files (`openshell.proto`, `datamodel.proto`, `sandbox.proto`)
- WHEN vendored into the control plane
- THEN they SHALL be placed at `components/ambient-control-plane/proto/openshell/v1/`
- AND each file SHALL have a `go_package` option added
- AND generated Go stubs SHALL be output to `internal/openshell/grpc/` (component-scoped, matching the control plane's convention of keeping packages under `internal/`; only the control plane consumes these stubs)

### Requirement: gRPC Connection Management

The control plane SHALL maintain a cache of gRPC connections to OpenShell gateways, one per namespace, with lazy initialization. Connections SHALL handle gateway pod restarts transparently using gRPC's built-in reconnection, following the same resilience patterns used by the control plane's existing gRPC watcher ([watcher.go]).

#### Scenario: Connection caching

- GIVEN multiple sessions in the same project namespace
- WHEN the control plane creates sandboxes for each
- THEN it SHALL reuse a single gRPC connection per namespace
- AND connections SHALL be created lazily on first use

#### Scenario: Connection dial

- WHEN a new gRPC connection is established to a gateway
- THEN the dial SHALL use gRPC's default non-blocking connection mode (connect-on-first-RPC)
- AND individual RPCs SHALL use a per-call timeout derived from the caller's context

#### Scenario: Unhealthy connection recovery

- GIVEN a cached gRPC connection to a gateway
- WHEN the gateway pod restarts or the connection becomes unhealthy
- THEN gRPC's built-in transport reconnection SHALL handle recovery transparently
- AND in-flight RPCs that fail due to the connection drop SHALL be retried by the reconciler on its next reconciliation loop (existing retry semantics — the reconciler already retries failed provisions on subsequent events)

#### Scenario: Stale connection eviction

- GIVEN a cached gRPC connection to a namespace
- WHEN an RPC returns an `Unavailable` or connection-level error
- THEN the client SHALL evict the cached connection and create a fresh one on the next call

#### Scenario: Shutdown cleanup

- WHEN the control plane shuts down
- THEN it SHALL close all cached gRPC connections

### Requirement: Configuration

The control plane SHALL expose configuration for OpenShell gateway mode alongside the existing `OPENSHELL_ENABLED` flag. `OPENSHELL_ENABLED` continues to control file-mode sandbox activation as defined in [openshell-sandbox.spec.md]. `OPENSHELL_USE_GATEWAY` is an independent flag that selects gateway-based provisioning.

> **Future work:** Once Unleash integration is added to the control plane, gateway mode SHOULD be gated behind a feature flag (e.g., `openshell-gateway-provisioning`) for gradual rollout and kill-switch capability. This is deferred to a follow-up spec.

#### Scenario: Configuration fields

- GIVEN the control plane configuration
- THEN the following environment variables SHALL be supported:

| Variable | Default | Purpose |
|---|---|---|
| `OPENSHELL_USE_GATEWAY` | `false` | Enable gateway-based sandbox provisioning (this spec) |

#### Scenario: Mode interaction

- GIVEN `OPENSHELL_USE_GATEWAY` is `true`
- THEN gateway mode SHALL be active regardless of the `OPENSHELL_ENABLED` value
- AND file-mode requirements (policy ConfigMap propagation, elevated security context, wrapper script) SHALL NOT apply

- GIVEN `OPENSHELL_USE_GATEWAY` is `false`
- AND `OPENSHELL_ENABLED` is `true`
- THEN file-mode sandbox SHALL be active as defined in [openshell-sandbox.spec.md]

- GIVEN `OPENSHELL_USE_GATEWAY` is `false` and `OPENSHELL_ENABLED` is `false`
- THEN no sandbox isolation SHALL be applied (direct pod creation)

---

## Migration

### Existing consumers

| Consumer | Impact |
|---|---|
| [kube_reconciler.go] `ensurePod()` | Preserved unchanged; used when `OPENSHELL_USE_GATEWAY=false` |
| [kube_reconciler.go] credential sidecars | Preserved unchanged; replaced by OpenShell providers only when gateway mode is active |
| [kube_reconciler.go] `ensureOpenShellPolicy()` | Preserved unchanged; skipped when gateway mode is active |
| [kube_reconciler.go] `buildRunnerSecurityContext()` | Preserved unchanged; not invoked in gateway mode (gateway owns pod security settings) |
| [pod_sync.go] | Extended with sandbox sync branch for gateway mode |
| `main.go` | Extended to create and wire `GatewayClient` when `OPENSHELL_USE_GATEWAY=true` |
| [config.go] | Extended with `OpenShellUseGateway` field |
| [openshell-sandbox.spec.md] | Unchanged — file-mode spec remains authoritative when `OPENSHELL_USE_GATEWAY=false` |
| Runner pod | No changes — same image, same env vars, running inside OpenShell sandbox instead of bare pod |

### Backward compatibility

When `OPENSHELL_USE_GATEWAY=false` (the default), all behavior is identical to the current system. File-mode sandbox (`OPENSHELL_ENABLED=true`) and direct pod creation (`OPENSHELL_ENABLED=false`) continue to work as before. No existing deployment is affected unless the operator explicitly enables gateway mode and installs OpenShell gateways.

<!-- Reference links -->
[openshell-sandbox.spec.md]: ../security/openshell-sandbox.spec.md
[sandbox-security-context]: ../security/openshell-sandbox.spec.md#requirement-container-security-context
[kube_reconciler.go]: ../../components/ambient-control-plane/internal/reconciler/kube_reconciler.go
[pod_sync.go]: ../../components/ambient-control-plane/internal/reconciler/pod_sync.go
[watcher.go]: ../../components/ambient-control-plane/internal/watcher/watcher.go
[config.go]: ../../components/ambient-control-plane/internal/config/config.go
