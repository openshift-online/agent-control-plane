# OpenShell Sandbox Provisioning Specification

**Date:** 2026-07-05
**Status:** Design
**Related:** `control-plane.spec.md` — CP provisioning; `openshell-sandbox.spec.md` — file-mode sandbox
**Skill:** `skills/build/full-stack-pipeline/` — wave-based implementation pipeline

---

## Purpose

When the platform operates in OpenShell mode, the control plane SHALL delegate agent pod creation to an OpenShell gateway running in each project namespace, instead of creating Kubernetes pods directly. This provides policy-enforced sandboxing (network, filesystem, process controls) for all agent sessions through OpenShell's security layer.

The OpenShell gateway exposes a gRPC service (`openshell.v1.OpenShell`) that manages sandbox lifecycle. Each project namespace has an OpenShell gateway pre-installed via the [OpenShell Helm chart](https://github.com/NVIDIA/OpenShell/tree/main/deploy/helm/openshell). The control plane discovers it via Kubernetes Service DNS.

#### Gateway Installation

The OpenShell gateway is installed into each project namespace using the upstream Helm chart:

```bash
helm install openshell-gateway oci://ghcr.io/nvidia/openshell/helm-chart --namespace <project-namespace>
```

The Helm chart deploys a StatefulSet, Service, ConfigMap, and TLS secrets via a `certgen` pre-install hook (`openshell-gateway generate-certs`). The certgen hook generates a self-signed CA, server certificate (with SANs derived from the Helm release name and namespace), client certificate, and JWT signing keys. These are stored in `openshell-server-tls`, `openshell-client-tls`, and `openshell-gateway-jwt-keys` Secrets respectively.

**Important:** The default server certificate SANs are derived from the Helm chart's `fullname` template (typically `openshell`) and the release namespace. If the Helm release name or Kubernetes Service name differs from the chart defaults, additional SANs must be provided via `pkiInitJob.serverDnsNames` to ensure sandbox-to-gateway TLS verification succeeds:

```bash
helm install openshell-gateway oci://ghcr.io/nvidia/openshell/helm-chart \
  --namespace tenant \
  --set "pkiInitJob.serverDnsNames={openshell-gateway.tenant.svc.cluster.local}"
```

Alternatively, cert-manager can manage TLS certificates by setting `certManager.enabled=true` in the Helm values.

The ACP control plane reads the `openshell-client-tls` Secret from the project namespace to establish mTLS connections to the gateway (see [Gateway TLS and Authentication](#requirement-gateway-tls-and-authentication)).

#### Sandbox CRD Installation

The [Agent Sandbox CRD](https://github.com/kubernetes-sigs/agent-sandbox) (`sandboxes.agents.x-k8s.io`) and its controller must be installed cluster-wide before deploying the gateway. The CRD version must match the API version that the OpenShell gateway expects.

**Version compatibility:** The agent-sandbox project graduated its API from `v1alpha1` to `v1beta1` in release v0.5.0. The v0.5.0+ CRD includes a conversion webhook that serves both `v1alpha1` and `v1beta1`, so existing `v1alpha1` API calls continue to work. The controller stamps `v1beta1` in ownerReferences. OpenShell gateway 0.0.74+ is compatible with `v1beta1` ownerReferences.

Install the CRD:

```bash
# Current recommended version (v1beta1 API with v1alpha1 conversion webhook)
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.1/manifest.yaml
```

This installs the `agent-sandbox-system` namespace, the CRD, and the sandbox controller. The controller watches for Sandbox CRs and creates pods with ownerReferences — the API version in those ownerReferences must match what the gateway authenticator expects.

### Iteration 1 Constraints

This iteration is scoped to **scheduled agent runs** (single-run, short-lived sessions). The following are explicitly out of scope:

- **Long-running / steerable sessions** — credential lifecycle concerns (token expiry mid-session, gateway-managed refresh via OAuth2/client-credentials flows) are deferred
- **Gateway provisioning** — ~~the OpenShell gateway is assumed to already be deployed in each project namespace~~ **Resolved:** Gateway provisioning is now specified in [gateway-provisioning.spec.md](./gateway-provisioning.spec.md). Gateways are declared as `kind: Gateway` API resources via `acpctl apply -k` and reconciled by the GatewayReconciler in `internal/reconciler/`
- **Namespace lifecycle (gateway mode)** — ~~project namespaces are created and managed externally to ACP~~ **Resolved:** The ProjectReconciler now creates namespaces for all Projects (Project = Namespace). In gateway mode, the GatewayReconciler deploys gateways into namespaces that the ProjectReconciler has already created. No external namespace provisioning is required. See [Namespace Lifecycle](#requirement-namespace-lifecycle)
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
- THEN the control plane SHALL look up the project by `session.ProjectID` and resolve the gateway namespace from the project's **Name** field (lowercased via `NamespaceName()`), not from `session.ProjectID` directly
- AND it SHALL enable provider endpoint injection by setting `providers_v2_enabled=true` globally on the gateway via `UpdateConfig` (see [Providers V2 Enablement](#requirement-providers-v2-enablement))
- AND it SHALL ensure credential providers exist via `CreateProvider` (see [Credential Mapping](#requirement-credential-mapping-to-openshell-providers))
- AND it SHALL configure inference routing via `SetClusterInference` if an inference-capable credential is present (see [Inference Configuration](#requirement-inference-configuration-via-updateconfig))
- AND it SHALL call `CreateSandbox` on the gateway in that namespace
- AND the sandbox SHALL be created with the runner image, session environment variables, and attached credential providers
- AND the session phase SHALL transition to `Running`
- AND the control plane SHALL asynchronously poll `GetSandbox` until the sandbox reaches `SANDBOX_PHASE_READY`, then execute the runner start command inside the sandbox via `ExecSandbox` (see [Sandbox Command Execution](#requirement-sandbox-command-execution-via-execsandbox))

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

- GIVEN an OpenShell gateway is deployed in a namespace matching the project's Name (e.g., project Name `my-project` → namespace `my-project`)
- WHEN the control plane needs to reach the gateway
- THEN it SHALL resolve the namespace from the project's Name field (not the session's `ProjectID`)
- AND it SHALL connect to the gateway at `<service-name>.<namespace>.svc.cluster.local:<grpc-port>` (configurable via `OPENSHELL_GATEWAY_SERVICE_NAME` and `OPENSHELL_GATEWAY_GRPC_PORT`)

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

In gateway mode, the control plane SHALL NOT set a SecurityContext on the runner container. The OpenShell gateway owns pod creation and applies its own security settings — including the SCC, capabilities, and privilege configuration recommended by the [OpenShell OpenShift deployment guide](https://docs.nvidia.com/openshell/kubernetes/openshift). The gateway's sandbox service account is bound to the required SCC as part of the pre-deployed Helm installation. The [Sandbox CRD](#sandbox-crd-installation) and the [privileged SCC grant for sandbox pods](https://docs.nvidia.com/openshell/kubernetes/openshift#grant-the-privileged-scc-to-sandbox-pods) are assumed to be pre-installed on the cluster.

This is a significant change from file mode, where the control plane must grant elevated privileges (`root`, `SYS_ADMIN`, `NET_ADMIN`, `SYS_PTRACE`, `SETUID`, `SETGID`, `CHOWN`, `DAC_OVERRIDE`, seccomp `Unconfined`) to the runner container so the in-container Supervisor can create network namespaces and drop privileges. In gateway mode, the Supervisor is still present inside the sandbox, but the gateway configures it — the control plane's [`buildRunnerSecurityContext()`][kube_reconciler.go] and `buildVolumes()` (OpenShell policy mount) are not invoked.

#### Scenario: Gateway mode — no ACP-managed SecurityContext

- GIVEN `OPENSHELL_USE_GATEWAY` is `true`
- WHEN the control plane provisions a session
- THEN it SHALL NOT build a pod spec or set a container SecurityContext
- AND it SHALL NOT propagate the OpenShell policy ConfigMap
- AND it SHALL NOT add the `/etc/openshell` volume mount
- AND the `CreateSandboxRequest` SHALL contain only image, environment, and provider references
- AND all pod-level security settings SHALL be the gateway's responsibility
- AND the gateway SHALL override the container command to its supervisor binary (`/opt/openshell/bin/openshell-sandbox`) — the runner image's `CMD`/`ENTRYPOINT` is not executed (the runner is started via `ExecSandbox` after the sandbox reaches Ready)

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

#### Scenario: Vertex AI provider credential refresh

The `google-vertex-ai` provider type requires gateway-managed token refresh so the gateway can mint short-lived access tokens from a GCP service account key. This is equivalent to the CLI command `openshell provider refresh configure <name> --credential-key GOOGLE_VERTEX_AI_SERVICE_ACCOUNT_TOKEN --strategy google-service-account-jwt --material client_email=... --material private_key=... --secret-material-key private_key`. See [OpenShell Vertex AI provider docs](https://docs.nvidia.com/openshell/providers/google-vertex-ai) for the full setup flow.

- GIVEN a project has a `vertex` credential (OpenShell type `google-vertex-ai`)
- AND the credential token is a GCP service account JSON key file
- WHEN the control plane creates or updates the provider via `CreateProvider`/`UpdateProvider`
- THEN it SHALL configure credential refresh by calling `ConfigureProviderRefresh` with:
  - `Provider` = the provider name (e.g., `<project>-vertex`)
  - `CredentialKey` = `GOOGLE_VERTEX_AI_SERVICE_ACCOUNT_TOKEN`
  - `Strategy` = `PROVIDER_CREDENTIAL_REFRESH_STRATEGY_GOOGLE_SERVICE_ACCOUNT_JWT`
  - `Material` = `{"client_email": "<from SA key>", "private_key": "<from SA key>"}`
  - `SecretMaterialKeys` = `["private_key"]`
- AND it SHALL call `RotateProviderCredential` to trigger an immediate token mint
- AND the provider credential mapping SHALL use `GOOGLE_SERVICE_ACCOUNT_KEY` as the credential key name (the raw SA JSON key file content)
- AND the provider config SHALL include `VERTEX_AI_PROJECT_ID` and `VERTEX_AI_REGION` from the control plane's environment

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
| `vertex` | `google-vertex-ai` |
| `kubeconfig` | `generic` |
| `mlflow` | `generic` |
| (unknown) | `generic` |

### Requirement: Providers V2 Enablement

Before configuring providers or inference routing, the control plane SHALL enable provider endpoint injection on the gateway by setting the `providers_v2_enabled` global setting to `true`. This is equivalent to the CLI command `openshell settings set --global --key providers_v2_enabled --value true` and is required for gateway versions 0.0.72+ to correctly proxy inference traffic through the configured provider instead of attempting local execution (which results in 503 "inference service unavailable" errors).

See [OpenShell Vertex AI provider docs](https://docs.nvidia.com/openshell/providers/google-vertex-ai) for context on why this setting must be enabled before configuring providers.

#### Scenario: Providers V2 enabled before provider creation

- GIVEN `OPENSHELL_USE_GATEWAY` is `true`
- AND an OpenShell gateway is running in the project namespace
- WHEN the control plane provisions a sandbox
- THEN it SHALL call `UpdateConfig` with `global=true`, `setting_key="providers_v2_enabled"`, `setting_value=true` (bool) BEFORE calling `CreateProvider` or `SetClusterInference`
- AND failure to set this setting SHALL prevent sandbox creation (the session remains in `Pending` phase)

#### Scenario: Idempotent enablement

- GIVEN `providers_v2_enabled` is already set to `true` on the gateway
- WHEN the control plane provisions another sandbox in the same namespace
- THEN the `UpdateConfig` call SHALL succeed idempotently (setting the same value again is a no-op)

### Requirement: Inference Configuration via SetClusterInference

After ensuring credential providers exist, the control plane SHALL configure the gateway's inference routing so that sandboxes can reach an LLM via the `inference.local` endpoint. This is equivalent to the CLI command `openshell inference set --provider <name> --model <model>` and is performed via the `SetClusterInference` gRPC RPC on the `openshell.inference.v1.Inference` service. See [OpenShell inference routing docs](https://docs.nvidia.com/openshell/sandboxes/inference-routing) for details on how `inference.local` routes requests through the gateway's privacy router.

The control plane iterates all bound credentials and configures inference routing for every provider whose OpenShell type is inference-capable. Inference-capable types are those that support the `inference.local` routing endpoint: `google-vertex-ai`, `claude`, `anthropic`, `nvidia`, `openai`, and `aws-bedrock`. For each qualifying provider, the control plane calls `SetClusterInference` with `provider_name` (the provider name as created by `ensureGatewayProviders`), `model_id`, and `no_verify=true`. These settings are applied per namespace after provider creation.

> **TODO:** The inference model is currently hardcoded to `claude-sonnet-4-6`. A future iteration should allow the model to be configured per-session via `session.LlmModel`, falling back to a sensible default when unset.

#### Scenario: Inference configuration with an inference-capable credential

- GIVEN a project has a credential whose OpenShell provider type is inference-capable (e.g., `vertex` → `google-vertex-ai`, `anthropic` → `claude`)
- AND the control plane has created the corresponding provider via `CreateProvider`
- AND `providers_v2_enabled` has been set to `true` on the gateway (see [Providers V2 Enablement](#requirement-providers-v2-enablement))
- WHEN the control plane provisions a sandbox in that project's namespace
- THEN it SHALL call `SetClusterInference` with `provider_name=<provider-name>` (the name returned by `ProviderName(projectName, ambientProvider)`), `model_id="claude-sonnet-4-6"`, and `no_verify=true`
- AND the call SHALL complete before sandbox creation proceeds
- AND failure SHALL prevent sandbox creation (the session remains in `Pending` phase)

#### Scenario: No inference-capable credential — inference configuration skipped

- GIVEN a project has only credentials for non-inference-capable types (e.g., `github`, `jira`, `kubeconfig`)
- WHEN the control plane provisions a sandbox
- THEN it SHALL NOT call `UpdateConfig` for inference settings
- AND sandbox creation SHALL proceed normally

#### Scenario: UpdateConfig RPC vendoring

- GIVEN the control plane proto definitions
- THEN the vendored `openshell.v1.OpenShell` service SHALL include the `UpdateConfig` RPC
- AND the vendored `openshell.sandbox.v1` package SHALL include the `SettingValue` message (oneof: `string_value`, `bool_value`, `int_value`, `bytes_value`)
- AND the `UpdateConfigRequest` message SHALL include fields: `name` (string), `policy` (SandboxPolicy), `setting_key` (string), `setting_value` (SettingValue), `delete_setting` (bool), `global` (bool), `expected_resource_version` (uint64)
- AND the `UpdateConfigResponse` message SHALL include fields: `version` (uint32), `policy_hash` (string), `settings_revision` (uint64), `deleted` (bool)

### Requirement: Sandbox Environment Variables

The control plane SHALL pass session configuration to the sandbox as environment variables in the `CreateSandboxRequest.Spec.Template.Environment` map. OpenShell injects its own environment variables into the sandbox based on the attached provider types (see [supported provider types](https://docs.nvidia.com/openshell/sandboxes/manage-providers#supported-provider-types)). The control plane MUST NOT override these provider-injected variables.

#### Scenario: Environment variable translation

- GIVEN a session with LLM model, repo URL, and proxy settings
- WHEN the sandbox is created
- THEN all environment variables from `buildSandboxEnv()` that have literal string values SHALL be included
- AND Kubernetes-specific `valueFrom` / `fieldRef` entries (e.g., `POD_IP`) SHALL be omitted
- AND `INITIAL_PROMPT` SHALL NOT be included in the gateway environment — the assembled prompt contains newlines which OpenShell strips; the prompt is delivered via file upload instead (see [Payload Upload via SSH](#requirement-payload-upload-via-ssh))

#### Scenario: Provider-injected environment variable protection

- GIVEN a sandbox with attached providers that inject environment variables (e.g., `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`)
- WHEN `buildEnv()` produces an environment variable with the same name as one injected by an attached provider
- THEN the control plane SHALL exclude that variable from the `CreateSandboxRequest` environment
- AND the provider-injected value SHALL take precedence
- AND the control plane SHALL log a warning identifying the skipped variable

### Requirement: Sandbox Command Execution via ExecSandbox

The OpenShell gateway's Kubernetes driver overrides the container entrypoint to the supervisor binary (`/opt/openshell/bin/openshell-sandbox`) and hardcodes `OPENSHELL_SANDBOX_COMMAND=sleep infinity` in the container environment. This means the sandbox always boots with `sleep infinity` as its main process — the runner image's `CMD`/`ENTRYPOINT` is never executed. This is by design: the OpenShell sandbox model treats the sandbox as a persistent workspace where user commands run via exec after provisioning completes.

Setting `OPENSHELL_SANDBOX_COMMAND` in the `CreateSandboxRequest` environment is ineffective because the K8s driver's `apply_required_env()` overwrites it after applying user environment variables.

The control plane SHALL start the runner process inside the sandbox by calling the `ExecSandbox` gRPC RPC after the sandbox reaches `SANDBOX_PHASE_READY`. This mirrors how the OpenShell CLI implements `openshell sandbox create -- <command>`: it creates the sandbox, watches for Ready, then runs the command via exec — the command is never part of the `CreateSandboxRequest`.

The `ExecSandbox` RPC is a server-streaming call that returns stdout, stderr, and exit code events. The `ExecSandboxRequest.SandboxId` field requires the gateway's internal sandbox UUID (from `Sandbox.Metadata.Id` in the `GetSandbox` response), not the Kubernetes sandbox name.

#### Scenario: Runner startup via ExecSandbox

- GIVEN a sandbox has been created via `CreateSandbox`
- WHEN the sandbox reaches `SANDBOX_PHASE_READY`
- THEN the control plane SHALL call `ExecSandbox` with the command `["/bin/bash", "-c", "cd /runner/ambient-runner && PATH=/sandbox/.venv/bin:$PATH uvicorn main:app --host 0.0.0.0 --port 8001"]`
- AND the `SandboxId` SHALL be the gateway's internal UUID obtained from `GetSandbox` response metadata
- AND the exec SHALL run asynchronously (fire-and-forget) — the control plane launches a goroutine that consumes the exec stream but does not block reconciliation
- AND the exec goroutine SHALL use a separate context from the readiness-polling context — the polling context has a configurable timeout (default 600s via `SANDBOX_READINESS_TIMEOUT_SECONDS`) suitable for provisioning, but the exec context must remain open for the lifetime of the uvicorn process (which runs until session completion)
- AND the exec goroutine SHALL NOT accumulate stdout/stderr in memory — it SHALL discard or stream output to the logger to avoid unbounded memory growth for long-running processes

#### Scenario: Gateway image runner path

- GIVEN `OPENSHELL_USE_GATEWAY` is `true`
- AND the sandbox uses the gateway-mode runner image (built from `Dockerfile.openshell`)
- THEN the runner SHALL be located at `/runner/ambient-runner` inside the container
- AND the `ExecSandbox` command SHALL use this path to start the uvicorn server
- AND this path differs from the standard runner image (`/app/ambient-runner`) because the gateway image uses `/runner` as its runner directory root
- AND the gateway image's `CMD` directive is irrelevant — the gateway overrides the container entrypoint to the supervisor binary, so the runner is always started via `ExecSandbox`

#### Scenario: Polling for sandbox readiness

- GIVEN a sandbox was just created
- WHEN the control plane polls `GetSandbox` for readiness
- THEN it SHALL poll every 2 seconds with a configurable timeout (default 600 seconds, set via `SANDBOX_READINESS_TIMEOUT_SECONDS` env var)
- AND the control plane SHALL log a progress message every 30 seconds during polling, including sandbox name, session ID, and elapsed time
- AND if the sandbox enters `SANDBOX_PHASE_ERROR`, the control plane SHALL start a 15-second grace period — logging a warning on first observation and continuing to poll. If the sandbox remains in `SANDBOX_PHASE_ERROR` for at least 15 consecutive seconds, the control plane SHALL log an error, stop polling, and transition the session to `Failed`. If the sandbox recovers (transitions out of `SANDBOX_PHASE_ERROR`) before the grace period expires, the timer resets
- AND if the timeout expires before `SANDBOX_PHASE_READY`, the control plane SHALL log an error

#### Scenario: Idempotent exec on re-reconcile

- GIVEN a sandbox already exists for a session (detected via `GetSandbox` in the idempotency check)
- WHEN the control plane reconciles the same session again
- THEN it SHALL launch the exec-after-Ready goroutine again
- AND if the runner process is already listening on port 8001, the new uvicorn invocation SHALL fail to bind and exit — the original runner continues unaffected
- AND the control plane SHALL treat a non-zero exit code from a re-exec as non-fatal (log at warn level, do not transition the session to Failed)

#### Scenario: OPENSHELL_SANDBOX_COMMAND is not used

- GIVEN the control plane builds the gateway environment map
- THEN it SHALL NOT include `OPENSHELL_SANDBOX_COMMAND` in the environment
- AND the runner start command SHALL only be delivered via `ExecSandbox` after the sandbox is ready

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
| Sandbox exists, phase `ERROR` (session `Creating`, within 15s grace period) | (no change) | Transient errors during sandbox provisioning — grace period allows recovery |
| Sandbox exists, phase `ERROR` (session `Creating`, grace period exceeded) | `Failed` | Sustained error during provisioning — sandbox cannot recover |
| Sandbox exists, phase `ERROR` (session `Running`) | `Failed` | Gateway detected an error after sandbox was operational |
| Sandbox exists, phase `DELETING` | (no change) | Gateway is cleaning up |
| Sandbox exists, phase `UNKNOWN` | (no change, log warning) | Transient or unexpected state |
| Sandbox not found | `Failed` | Abnormal termination (sandbox disappeared while session still Running) |

Sessions in terminal phases are not listed because the syncer skips them before reaching the gateway call.

#### Scenario: Sandbox error grace period during creation

- GIVEN a session in `Creating` phase with a sandbox in `SANDBOX_PHASE_ERROR`
- WHEN the status syncer first observes the error
- THEN it SHALL record the timestamp, log a warning, and NOT change the session phase
- AND on subsequent sync cycles within 15 seconds of the first observation, it SHALL continue to skip the phase update
- AND if the sandbox remains in `SANDBOX_PHASE_ERROR` for at least 15 seconds, the syncer SHALL transition the session to `Failed`
- AND if the sandbox transitions out of `SANDBOX_PHASE_ERROR` before the grace period expires, the tracked timestamp SHALL be cleared
- AND the provisioning poller (`execAfterReady`) SHALL independently enforce the same 15-second grace period — both code paths must agree to prevent one from short-circuiting the other

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

### Requirement: Sandbox Network Namespace Isolation

In gateway mode, the OpenShell supervisor creates a separate network namespace for sandboxed processes. All traffic from within the sandbox namespace MUST traverse the supervisor's HTTP CONNECT proxy at `10.200.0.1:3128` — there is no direct route to cluster IPs or external DNS from the sandbox namespace.

The supervisor automatically injects proxy and TLS environment variables into processes started via `ExecSandbox` (SSH path). The SSH path calls `env_clear()` on the child process and rebuilds the environment from `child_env::proxy_env_vars()` (9 vars: `ALL_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, their lowercase equivalents, `grpc_proxy`, `NODE_USE_ENV_PROXY=1`) and `child_env::tls_env_vars()` (6 vars: `NODE_EXTRA_CA_CERTS`, `DENO_CERT`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`), plus the `user_environment` from the `CreateSandboxRequest`.

#### Scenario: ExecSandbox PATH requirement

- GIVEN the supervisor's SSH path calls `env_clear()` on the child process
- AND `env_clear()` strips all inherited environment variables including `PATH`
- AND the SSH path rebuilds `PATH` from a minimal set (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`)
- WHEN the control plane starts the runner via `ExecSandbox`
- THEN the command SHALL prepend `/sandbox/.venv/bin` to `PATH` (e.g., `PATH=/sandbox/.venv/bin:$PATH uvicorn ...`)
- AND without this, `uvicorn` and other Python venv binaries will not be found, causing the exec to exit with code 3

#### Scenario: NO_PROXY must exclude cluster service domains

- GIVEN the sandbox network namespace has no direct route to cluster IPs or DNS
- AND all non-loopback traffic MUST traverse the supervisor proxy at `10.200.0.1:3128`
- WHEN the control plane builds the sandbox environment map
- THEN `NO_PROXY` SHALL be set to `127.0.0.1,localhost` only
- AND `NO_PROXY` SHALL NOT include `.svc.cluster.local` or any cluster-internal domain suffix
- AND if `.svc.cluster.local` is included in `NO_PROXY`, the runner's gRPC client and HTTP calls to the API server will attempt direct connections that fail because the sandbox namespace has no route to cluster IPs
- AND this differs from non-gateway modes where the pod has direct cluster connectivity and `.svc.cluster.local` in `NO_PROXY` is correct

#### Scenario: Supervisor proxy and TLS CA

- GIVEN the supervisor creates an ephemeral self-signed CA per sandbox
- AND the CA certificate is written to `/etc/openshell-tls/openshell-ca.pem`
- WHEN the supervisor injects TLS environment variables via `child_env::tls_env_vars()`
- THEN `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, and `DENO_CERT` SHALL all point to the CA certificate path
- AND the runner SHALL trust this CA for all HTTPS connections routed through the proxy
- AND `inference.local` TLS connections are terminated by the proxy using this CA — there is no DNS entry for `inference.local`; the proxy intercepts the CONNECT request by hostname

#### Scenario: Security parity between ExecSandbox and entrypoint

- GIVEN the supervisor's ExecSandbox (SSH) path and entrypoint path
- WHEN a process is spawned via either path
- THEN both paths SHALL apply identical pre-exec security restrictions:
  1. `setns(fd, CLONE_NEWNET)` — enter the sandbox network namespace
  2. `supervisor_identity_mount` — filesystem identity isolation
  3. `drop_privileges(setgroups/setgid/setuid)` — switch to sandbox user
  4. `harden_child_process(RLIMIT_CORE=0, PR_SET_DUMPABLE=0, PR_SET_NO_NEW_PRIVS=1)`
  5. `landlock::enforce(restrict_self)` — filesystem allowlist
  6. `seccomp::apply(bpf_filter)` — syscall blocklist
- AND the SSH path is stricter because it calls `env_clear()` (the entrypoint inherits the supervisor's environment minus 4 supervisor-only vars: `SANDBOX_TOKEN`, `SANDBOX_TOKEN_FILE`, `K8S_SA_TOKEN_FILE`, `PROVIDER_SPIFFE_WORKLOAD_API_SOCKET`)
- AND the `ns_fd` for `setns()` can silently be `None` if the namespace file open fails (the supervisor logs a warning and falls back to running without network namespace isolation)

### Requirement: ACP Internal Network Policy Injection

The control plane SHALL inject an `_acp_internal` network policy rule into the sandbox **after creation** using OpenShell's `UpdateConfig` RPC with `merge_operations`. This permits the runner process (Python/uvicorn) to reach the ACP control plane and API server through the supervisor proxy. Without this, all cluster-internal traffic from the runner will be denied by the OPA policy engine with `DENIED FORWARD`.

The `_acp_internal` rule SHALL NOT be included in the `CreateSandboxRequest.Spec.Policy` field, because doing so replaces the sandbox's entire default policy — stripping rules the sandbox depends on. The `merge_operations` approach (equivalent to `openshell policy update <sandbox-name> --add-allow`) is additive: it adds or replaces only the `_acp_internal` rule while preserving all other rules in the sandbox's default policy.

#### Scenario: ACP internal endpoints injected post-creation

- GIVEN a sandbox has been created via `CreateSandbox` and has received its default policy from OpenShell
- AND the runner process will run inside the sandbox network namespace
- AND all traffic routes through the supervisor's HTTP CONNECT proxy at `10.200.0.1:3128`
- AND the proxy evaluates each CONNECT request against the OPA policy
- WHEN the control plane injects the `_acp_internal` rule via `UpdateConfig` merge operations
- THEN the `_acp_internal` network policy rule SHALL allow traffic to:

| Endpoint | Port | Purpose |
|----------|------|---------|
| `ambient-control-plane.{namespace}.svc` | 8080 | CP token endpoint |
| `ambient-control-plane.{namespace}.svc.cluster.local` | 8080 | CP token endpoint (FQDN) |
| `ambient-api-server.{namespace}.svc` | 8000 | API server HTTP |
| `ambient-api-server.{namespace}.svc.cluster.local` | 8000 | API server HTTP (FQDN) |
| `ambient-api-server.{namespace}.svc` | 9000 | API server gRPC |
| `ambient-api-server.{namespace}.svc.cluster.local` | 9000 | API server gRPC (FQDN) |

- AND `{namespace}` SHALL be the control plane's runtime namespace (`CP_RUNTIME_NAMESPACE`)
- AND allowed binaries SHALL include `/sandbox/.venv/bin/python`, `/sandbox/.venv/bin/python3`, `/sandbox/.venv/bin/uvicorn`, and `/sandbox/.uv/python/cpython-*/bin/python*`
- AND both short (`svc`) and fully-qualified (`svc.cluster.local`) hostnames SHALL be listed because the proxy resolves based on the exact hostname in the CONNECT request
- AND all other rules in the sandbox's default policy SHALL be preserved

#### Scenario: Default sandbox policy preserved during injection

- GIVEN a sandbox's default policy contains rules for provider traffic, DNS, or other platform concerns
- WHEN the control plane injects `_acp_internal` via `UpdateConfig` merge operations
- THEN the existing default policy rules SHALL remain intact and unmodified
- AND the `_acp_internal` rule SHALL be added alongside them

#### Scenario: Policy merge confirmation via UpdateConfig response

- GIVEN the control plane has called `UpdateConfig` with the `_acp_internal` merge operation
- WHEN the gateway processes the merge
- THEN the `UpdateConfigResponse` SHALL include the new `version` (uint32) and `policy_hash` (string)
- AND a successful response SHALL serve as the definitive confirmation that the merge has been applied
- AND the control plane SHALL NOT poll sandbox logs to verify the merge — the synchronous `UpdateConfig` RPC is authoritative
- AND the control plane SHALL log the returned `policy_version` and `policy_hash` for observability
- AND the entrypoint execution SHALL proceed immediately after a successful `UpdateConfig` response

#### Scenario: Missing ACP internal policy causes runner failure

- GIVEN the `_acp_internal` network policy rule has not been injected (e.g., `UpdateConfig` merge failed)
- WHEN the runner starts and attempts to fetch a CP token via `AMBIENT_CP_TOKEN_URL`
- THEN the supervisor proxy SHALL deny the CONNECT request
- AND the runner SHALL fail to authenticate and exit with a non-zero exit code
- AND the sandbox logs SHALL show `DENIED FORWARD` for the control plane hostname

### Requirement: DNS Configuration via Sandbox CRD Patch

The control plane SHALL configure DNS resolution for sandboxes by patching the Sandbox CRD's `podTemplate.spec.dnsConfig` with `ndots:1`, then deleting the sandbox pod to force recreation with the updated DNS config. This is a workaround for [OpenShell#2053](https://github.com/NVIDIA/OpenShell/issues/2053) — without it, DNS resolution for external FQDNs (e.g., `api.github.com`) fails inside sandboxes because the default `ndots:5` causes excessive search-domain expansion.

#### Scenario: DNS configuration after sandbox creation

- GIVEN a sandbox has been created via `CreateSandbox`
- WHEN the control plane prepares the sandbox for runner execution
- THEN it SHALL patch the `agents.x-k8s.io/v1beta1` Sandbox CR using a Kubernetes merge-patch on `spec.podTemplate.spec.dnsConfig` with `options: [{name: ndots, value: "1"}]`
- AND it SHALL delete the sandbox pod to trigger recreation by the sandbox controller with the updated DNS config
- AND if the pod deletion fails with NotFound, the error SHALL be ignored (pod may not exist yet)
- AND DNS patching failures SHALL be logged as warnings but SHALL NOT block sandbox provisioning

#### Scenario: DNS configuration on re-reconcile

- GIVEN a sandbox already exists for a session (idempotent creation path)
- WHEN the control plane reconciles the same session again
- THEN it SHALL re-apply the DNS config patch (idempotent merge-patch)
- AND it SHALL delete the existing sandbox pod to ensure the DNS config is applied

### Requirement: Payload Upload via SSH

The control plane SHALL upload payload files into the sandbox filesystem via SSH-over-gRPC before starting the runner entrypoint. The upload uses the gateway's `CreateSshSession` and `ForwardTcp` gRPC RPCs to establish an SSH connection to the sandbox's embedded SSH server, then writes files via `mkdir -p <dir> && cat > <path>` commands. This runs as root through the supervisor's SSH server, bypassing the sandbox's read-only root filesystem restriction that prevents writes via `ExecSandbox`.

#### Scenario: Payload upload before entrypoint execution

- GIVEN a sandbox has reached `SANDBOX_PHASE_READY`
- AND the agent has inline content payloads (payloads with `sandbox_path` and `content`)
- WHEN the control plane starts the exec-after-Ready goroutine
- THEN it SHALL upload all inline content payloads via SSH BEFORE calling `ExecSandbox` to start the runner
- AND if any payload upload fails, the session SHALL transition to `Failed` with a descriptive error
- AND the `ExecSandbox` call SHALL NOT proceed

#### Scenario: SSH connection establishment

- GIVEN the control plane needs to upload payloads to a sandbox
- WHEN it initiates the upload
- THEN it SHALL call `CreateSshSession` with the sandbox's gateway UUID to obtain an SSH session token and host key fingerprint
- AND it SHALL open a `ForwardTcp` bidirectional stream with a `TcpForwardInit` frame containing the sandbox ID, a service ID (`payload-upload:<sandboxID>`), an `SshRelayTarget`, and the authorization token
- AND it SHALL perform an SSH handshake over the gRPC stream using the `sandbox` user
- AND it SHALL verify the SSH host key fingerprint against the `CreateSshSession` response (if provided; empty fingerprint is accepted when gRPC mTLS provides the outer security boundary)

#### Scenario: File write via SSH

- GIVEN an SSH connection is established to the sandbox
- WHEN the control plane writes a payload
- THEN it SHALL execute `mkdir -p '<dir>' && cat > '<path>'` via an SSH session with the payload content piped to stdin
- AND `sandbox_path` SHALL be validated: must be an absolute path, must not contain `..` traversal, must match `^/[a-zA-Z0-9/_.\-]+$`
- AND invalid paths SHALL be rejected before the SSH command is executed

#### Scenario: Initial prompt delivered as file payload

- GIVEN a session with a non-empty assembled prompt (from project, agent, inbox, or session prompt)
- WHEN the control plane prepares payloads for the sandbox
- THEN it SHALL append a synthetic payload with `SandboxPath="/tmp/initial_prompt.txt"` and `Content=<assembled prompt>` to the payload list
- AND this payload SHALL be uploaded via SSH alongside any agent-defined payloads before `ExecSandbox`
- AND the runner SHALL read this file on startup and push it as a `PushSessionMessage(event_type="user")` via gRPC so the prompt is visible in the UI chat history

#### Scenario: No payloads — upload skipped

- GIVEN an agent with no inline content payloads (or no agent associated with the session) AND no initial prompt
- WHEN the sandbox reaches `SANDBOX_PHASE_READY`
- THEN the control plane SHALL skip the SSH upload step entirely
- AND proceed directly to `ExecSandbox`

### Requirement: Proto Vendoring and Code Generation

The control plane SHALL vendor OpenShell proto definitions and generate Go gRPC client stubs using buf v2, following the same pattern as the ambient-api-server.

#### Scenario: Proto file structure

- GIVEN the OpenShell proto files (`openshell.proto`, `datamodel.proto`, `sandbox.proto`)
- WHEN vendored into the control plane
- THEN they SHALL be placed at `components/ambient-control-plane/proto/openshell/v1/`
- AND each file SHALL have a `go_package` option added
- AND generated Go stubs SHALL be output to `internal/openshell/grpc/` (component-scoped, matching the control plane's convention of keeping packages under `internal/`; only the control plane consumes these stubs)
- AND the vendored proto SHALL include the `ExecSandbox` RPC (server-streaming: `ExecSandboxRequest` → `stream ExecSandboxEvent`), `CreateSshSession` RPC (`CreateSshSessionRequest` → `CreateSshSessionResponse`), and `ForwardTcp` RPC (bidirectional streaming: `stream TcpForwardFrame` → `stream TcpForwardFrame`) in addition to sandbox lifecycle and provider management RPCs
- AND the vendored proto SHALL include `TcpForwardFrame` (oneof: `TcpForwardInit init`, `bytes data`), `TcpForwardInit` (fields: `sandbox_id`, `service_id`, `SshRelayTarget ssh`), `SshRelayTarget` (empty message), `CreateSshSessionRequest` (field: `sandbox_id`), and `CreateSshSessionResponse` (fields: `token`, `host_key_fingerprint`) messages

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

### Requirement: Gateway TLS and Authentication

The control plane SHALL use mTLS for transport-level security when connecting to the OpenShell gateway. The gateway SHALL be deployed with `allow_unauthenticated_users = false` — all clients must authenticate via one of the gateway's application-layer authenticators in addition to presenting a valid mTLS client certificate.

**Authentication paths:**
- **ACP → gateway:** The control plane presents its Kubernetes ServiceAccount token as a Bearer token in gRPC requests. The gateway validates it via the `K8sServiceAccountAuthenticator` (TokenReview API). This is the same auth path used by sandbox pods for `IssueSandboxToken` bootstrap, ensuring a consistent authentication model.
- **Sandbox → gateway:** Sandbox pods authenticate via `IssueSandboxToken` (K8s SA token exchange for a gateway-minted JWT), then use the sandbox JWT for subsequent requests (policy fetch, log push, token refresh). This is managed entirely by the gateway and its supervisor — the control plane is not involved.

The gateway is not exposed outside the cluster (no Route), so the only clients are ACP (via mTLS + K8s SA token) and sandboxes (via mTLS + gateway-minted JWTs).

The control plane SHALL load client TLS credentials dynamically from a Kubernetes Secret in each project namespace, enabling per-namespace certificate isolation. The `openshell-client-tls` Secret (configurable via `OPENSHELL_GATEWAY_CLIENT_TLS_SECRET`) contains the client certificate, private key, and CA certificate for verifying the gateway's server certificate.

#### Scenario: mTLS connection

- GIVEN `OPENSHELL_GATEWAY_TLS` is not set to `false`
- WHEN the control plane connects to a gateway in a project namespace
- THEN it SHALL read the `openshell-client-tls` Secret from that namespace
- AND it SHALL use `tls.crt` and `tls.key` as the client certificate
- AND it SHALL use `ca.crt` as the root CA for server verification
- AND TLS credentials SHALL be cached per namespace and evicted on connection errors
- AND the control plane SHALL attach its Kubernetes ServiceAccount token as a Bearer token in gRPC call metadata for application-layer authentication

#### Scenario: Gateway authentication configuration

- GIVEN an OpenShell gateway deployed in a project namespace
- WHEN the gateway is configured for ACP integration
- THEN `allow_unauthenticated_users` SHALL be set to `false` in the gateway configuration
- AND the gateway SHALL require all clients to authenticate via one of its application-layer authenticators (`SandboxJwtAuthenticator`, `K8sServiceAccountAuthenticator`, or `OidcAuthenticator`)
- AND the control plane SHALL present its Kubernetes ServiceAccount token as a Bearer token in gRPC requests to pass the `K8sServiceAccountAuthenticator`
- AND sandbox-to-gateway authentication (bootstrap JWTs via `IssueSandboxToken`) remains the gateway's responsibility and is unaffected

#### Scenario: TLS ServerName override

- GIVEN the gateway's server certificate SANs do not include the Service DNS name (e.g., cert is valid for `openshell` but the Service is named `openshell-gateway`)
- WHEN `OPENSHELL_GATEWAY_TLS_SERVER_NAME` is set
- THEN the TLS handshake SHALL use the override value for server name verification instead of the DNS name

#### Scenario: Plaintext connections (development)

- GIVEN `OPENSHELL_GATEWAY_TLS` is set to `false`
- WHEN the control plane connects to a gateway
- THEN it SHALL use insecure (plaintext) gRPC credentials
- AND no TLS Secret lookups SHALL occur

#### Scenario: Multiline environment variable filtering

- GIVEN the OpenShell gateway rejects environment variable values containing newline or carriage return characters
- WHEN the control plane builds the sandbox environment map
- THEN it SHALL remove any entries whose values contain `\n` or `\r`
- AND it SHALL log a warning for each removed entry

#### Scenario: PEM key transport via base64 encoding

- GIVEN `AMBIENT_CP_TOKEN_PUBLIC_KEY` contains an RSA public key in PEM format (multiline)
- WHEN the control plane builds the gateway sandbox environment map
- THEN it SHALL base64-encode the PEM value before including it in the `CreateSandboxRequest` environment
- AND the encoded value SHALL be a single line with no newline characters
- AND all consumers (runner, credential sidecar, MCP sidecar) SHALL detect the encoding format: if the value starts with `-----` it is raw PEM; otherwise it is base64-decoded before PEM parsing
- AND this encoding is specific to the gateway code path — the direct pod creation path (`envVar()`) continues to pass the raw PEM unchanged, since Kubernetes natively supports multiline environment variable values

### Requirement: Namespace Lifecycle

Namespace lifecycle is unified across modes. The ProjectReconciler creates and manages namespaces for all Projects (Project = Namespace). There is no mode-dependent namespace provisioning.

- **All modes**: The ProjectReconciler watches Project events via gRPC and creates a Kubernetes namespace for each Project via `ensureNamespace()`. The namespace carries managed labels (`ambient-code.io/managed=true`, `ambient-code.io/project-id`, `ambient-code.io/managed-by=ambient-control-plane`). Gateway mode no longer requires externally-provisioned namespaces.
- **Gateway mode** (`OPENSHELL_USE_GATEWAY=true`): The GatewayReconciler deploys OpenShell gateway resources into the namespace after the ProjectReconciler has created it. Gateway configuration is declared as a `kind: Gateway` API resource applied via `acpctl apply -k`. No `platform-config` ConfigMap or `initGatewayProvisioning()` startup path is needed.

#### Scenario: Namespace created by ProjectReconciler

- GIVEN a Project named `my-project` exists in the API server
- WHEN the ProjectReconciler processes the Project event
- THEN it SHALL create namespace `my-project` with managed labels
- AND the namespace SHALL be available for both session provisioning and gateway deployment

#### Scenario: Gateway mode — namespace exists before gateway deployment

- GIVEN `OPENSHELL_USE_GATEWAY` is `true`
- AND a `kind: Gateway` resource references project `my-project`
- WHEN the GatewayReconciler processes the Gateway event
- THEN the namespace `my-project` SHALL already exist (created by ProjectReconciler)
- AND the GatewayReconciler SHALL deploy gateway K8s resources into it

#### Scenario: Gateway mode — namespace does not yet exist

- GIVEN `OPENSHELL_USE_GATEWAY` is `true`
- AND a Gateway event arrives before the corresponding Project has been reconciled
- WHEN the GatewayReconciler attempts to deploy
- THEN it SHALL log a warning and skip reconciliation
- AND it SHALL retry when the namespace becomes available

#### Scenario: Session cleanup (pod mode)

- GIVEN `OPENSHELL_USE_GATEWAY` is `false`
- AND a session is being stopped or deleted
- WHEN the control plane cleans up session resources
- THEN it SHALL delete session-scoped resources (secrets, service accounts, services) within the namespace
- AND it SHALL call `DeprovisionNamespace` to delete the namespace

#### Scenario: Session cleanup (gateway mode)

- GIVEN `OPENSHELL_USE_GATEWAY` is `true`
- AND a session is being stopped or deleted
- WHEN the control plane cleans up session resources
- THEN it SHALL delete session-scoped resources (secrets, service accounts, services, sandboxes) within the namespace
- AND it SHALL NOT delete the namespace (the namespace is owned by the ProjectReconciler and may be used by other sessions and the gateway)

#### Scenario: Project deletion

- GIVEN a project with name `my-project` and associated namespace `my-project`
- WHEN the project is deleted from ACP
- THEN the ProjectReconciler SHALL handle namespace cleanup according to its lifecycle policy
- AND gateway resources within the namespace SHALL be cleaned up by the GatewayReconciler when the corresponding Gateway resource is deleted

### Requirement: Configuration

The control plane SHALL expose configuration for OpenShell gateway mode alongside the existing `OPENSHELL_ENABLED` flag. `OPENSHELL_ENABLED` continues to control file-mode sandbox activation as defined in [openshell-sandbox.spec.md]. `OPENSHELL_USE_GATEWAY` is an independent flag that selects gateway-based provisioning.

> **Future work:** Once Unleash integration is added to the control plane, gateway mode SHOULD be gated behind a feature flag (e.g., `openshell-gateway-provisioning`) for gradual rollout and kill-switch capability. This is deferred to a follow-up spec.

#### Scenario: Configuration fields

- GIVEN the control plane configuration
- THEN the following environment variables SHALL be supported:

| Variable | Default | Purpose |
|---|---|---|
| `OPENSHELL_USE_GATEWAY` | `false` | Enable gateway-based sandbox provisioning (this spec) |
| `OPENSHELL_GATEWAY_SERVICE_NAME` | `openshell-gateway` | Kubernetes Service name for the OpenShell gateway in each project namespace |
| `OPENSHELL_GATEWAY_GRPC_PORT` | `8080` | gRPC port on the gateway Service |
| `OPENSHELL_GATEWAY_TLS` | `true` (enabled unless set to `false`) | Enable mTLS when connecting to the gateway |
| `OPENSHELL_GATEWAY_CLIENT_TLS_SECRET` | `openshell-client-tls` | Name of the Kubernetes TLS Secret (per project namespace) containing `tls.crt`, `tls.key`, and `ca.crt` for mTLS client authentication |
| `OPENSHELL_GATEWAY_TLS_SERVER_NAME` | (empty — uses actual DNS name) | Override TLS ServerName for certificate verification; set when the gateway's server certificate SANs don't match the Service DNS name |
| `OPENSHELL_RUNNER_IMAGE` | `quay.io/ambient_code/acp_runner_openshell:latest` | Container image used for gateway-mode sandboxes (built from `Dockerfile.openshell`); separate from `RUNNER_IMAGE` which is used for direct pod creation |
| `SANDBOX_READINESS_TIMEOUT_SECONDS` | `600` | Maximum seconds to wait for a sandbox to reach `SANDBOX_PHASE_READY` before failing the session |

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
| [config.go] | Extended with `OpenShellUseGateway` and `OpenShellRunnerImage` fields |
| `StandardNamespaceProvisioner` | In pod mode (`OPENSHELL_USE_GATEWAY=false`): `ProvisionNamespace` creates the namespace if absent, updates labels if it exists (update-or-create). `DeprovisionNamespace` deletes the namespace. In gateway mode: `ProvisionNamespace` is called during `initGatewayProvisioning` to apply managed labels to externally-created namespaces (update-or-create); it never creates namespaces in this path since they must already exist |
| `provisionSessionGateway()` | Bypasses the provisioner for session provisioning — uses a direct `GetNamespace` check so no provisioner implementation can inadvertently create the namespace. Namespace labeling is handled separately during gateway initialization via `ensureProject` |
| `cleanupSessionGateway()` | Does not call `DeprovisionNamespace` — namespace lifecycle is fully external in gateway mode |
| [openshell-sandbox.spec.md] | Unchanged — file-mode spec remains authoritative when `OPENSHELL_USE_GATEWAY=false` |
| Runner pod | Same image and env vars, but the runner process is started via `ExecSandbox` with `["/bin/bash", "-c", "cd /runner/ambient-runner && PATH=/sandbox/.venv/bin:$PATH uvicorn main:app --host 0.0.0.0 --port 8001"]` after the sandbox reaches Ready — the gateway overrides the container entrypoint to the supervisor binary with `sleep infinity`, so the image's CMD is never executed directly. The exec goroutine must use a long-lived context (not the configurable polling timeout context) and must not accumulate stdout/stderr in memory |
| `GatewayClient.ExecSandbox()` | Current implementation blocks on the full stream and accumulates output — must be updated to support fire-and-forget semantics for long-running processes (discard/stream output, use caller-provided context) |
| `GatewayClient.UpdateConfig()` | New method — calls the `UpdateConfig` gRPC RPC; used by `enableProvidersV2` to set `providers_v2_enabled=true` globally on the gateway |
| `GatewayClient.SetClusterInference()` | New method — calls the `SetClusterInference` gRPC RPC on the `openshell.inference.v1.Inference` service; used by `configureInference` to set provider and model for inference routing |
| [kube_reconciler.go] `enableProvidersV2()` | New method — called before `ensureGatewayProviders`; sets `providers_v2_enabled=true` on the gateway, required for v0.0.72+ gateways |
| [kube_reconciler.go] `configureInference()` | New method — called after `ensureGatewayProviders`; sets gateway inference routing via `SetClusterInference` when an inference-capable credential is present |
| `GatewayClient.UploadPayloads()` | New method — opens an SSH session via `CreateSshSession` / `ForwardTcp` gRPC RPCs and writes payload files into the sandbox via `mkdir -p && cat >` SSH commands. Called in the exec-after-Ready goroutine before `ExecSandbox` when the agent has inline content payloads |
| `GatewayClient.ExecSandboxStreaming()` | New method — fire-and-forget variant of `ExecSandbox` that discards output and uses a caller-provided context, replacing the blocking `ExecSandbox` for long-running processes |
| [kube_reconciler.go] `patchSandboxDNSConfig()` | New method — patches `agents.x-k8s.io/v1beta1` Sandbox CR's `podTemplate.spec.dnsConfig` with `ndots:1` and deletes the sandbox pod to force recreation. Workaround for [OpenShell#2053](https://github.com/NVIDIA/OpenShell/issues/2053) |
| [kube_reconciler.go] `resolveEntrypoint()` | Default entrypoint changed from `/sandbox/runner/entrypoint.sh` to `/runner/entrypoint.sh` to match the gateway runner image's directory layout |
| `provider_mapping.go` | Updated `vertex` mapping from `vertex-prod` to `google-vertex-ai` to match the OpenShell CLI's provider type |
| Vendored proto (`openshell.proto`, `sandbox.proto`) | Extended with `UpdateConfig` RPC, `UpdateConfigRequest`/`UpdateConfigResponse` messages, `SettingValue` message, `CreateSshSession` RPC, `ForwardTcp` RPC (bidirectional streaming), `TcpForwardFrame`, `TcpForwardInit`, `SshRelayTarget`, `CreateSshSessionRequest`, and `CreateSshSessionResponse` messages |
| `ssh_upload.go` | New file — implements SSH-over-gRPC payload upload using `CreateSshSession`/`ForwardTcp` RPCs with a `grpcConn` adapter that wraps the bidirectional `ForwardTcp` stream as a `net.Conn` for the Go SSH client |

### Backward compatibility

When `OPENSHELL_USE_GATEWAY=false` (the default), all behavior is identical to the current system. File-mode sandbox (`OPENSHELL_ENABLED=true`) and direct pod creation (`OPENSHELL_ENABLED=false`) continue to work as before. No existing deployment is affected unless the operator explicitly enables gateway mode and installs OpenShell gateways.

<!-- Reference links -->
[openshell-sandbox.spec.md]: ../security/openshell-sandbox.spec.md
[sandbox-security-context]: ../security/openshell-sandbox.spec.md#requirement-container-security-context
[kube_reconciler.go]: ../../components/ambient-control-plane/internal/reconciler/kube_reconciler.go
[pod_sync.go]: ../../components/ambient-control-plane/internal/reconciler/pod_sync.go
[watcher.go]: ../../components/ambient-control-plane/internal/watcher/watcher.go
[config.go]: ../../components/ambient-control-plane/internal/config/config.go
