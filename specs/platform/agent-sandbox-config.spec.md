# Agent Sandbox Configuration

**Date:** 2026-07-05
**Status:** Proposed
**Related:** `specs/platform/data-model.spec.md` (Agent entity), `specs/platform/openshell-sandbox-provisioning.spec.md` (gateway-mode sandbox provisioning — Iteration 1), `specs/security/openshell-sandbox.spec.md` (file-mode sandbox isolation), `specs/security/credential-binding.spec.md` (credential resolution), `specs/platform/control-plane.spec.md` (session provisioning), `specs/platform/runner.spec.md` (runner lifecycle — being replaced)

---

## Purpose

Agent definitions SHALL be expressed as declarative YAML documents in ConfigMaps, applied by ArgoCD into tenant namespaces and reconciled by the ACP control plane. The YAML schema SHALL support the full range of OpenShell sandbox configuration: what binary runs inside the sandbox, what credentials it has access to, what network and filesystem policies constrain it, what content is pre-loaded, and what compute resources are allocated.

This spec extends the Agent concept from `data-model.spec.md` with sandbox-aware configuration fields aligned to NVIDIA OpenShell's `SandboxSpec`, `SandboxPolicy`, and `Provider` protobuf definitions. When gateway mode is enabled (`OPENSHELL_USE_GATEWAY=true`), agents using this schema are executed via OpenShell Gateway-managed sandboxes instead of the existing Kubernetes Job runner model.

---

## Terminology

- **Agent Declaration** — a YAML document within a ConfigMap that defines an agent's identity, behavior, and sandbox configuration. The primary mechanism for creating and updating agents.
- **Provider** — an OpenShell Gateway-registered credential provider (e.g., `github`, `anthropic`, `jira`). The gateway's egress proxy resolves credential placeholders at the network boundary — credentials never enter the sandbox. Not to be confused with the `provider` field on the platform's `Credential` entity, which classifies the stored token type.
- **Payload** — content delivered into the sandbox filesystem at a declared path. Sources include inline text (`content`) or a git repository (`repo_url`). Used for prompts (CLAUDE.md), settings, MCP configs, task files, and source code.
- **Entrypoint** — the CLI binary launched inside the sandbox (e.g., `claude`, `opencode`, `bash`).
- **Sandbox Policy** — an OpenShell `SandboxPolicy` governing network endpoints, filesystem paths, process identity, and Landlock constraints within the sandbox. Declared as a namespace-scoped resource in a Policy ConfigMap using the exact upstream OpenShell YAML format, and referenced by agents by name.
- **Policy Declaration** — a `data` entry within a ConfigMap (labeled `ambient.ai/kind: policy`) containing a raw upstream OpenShell `SandboxPolicy` YAML definition with a `name` field. The policy name is derived from the `name` field within the YAML content. Policy declarations are namespace-scoped and available for any agent in the tenant namespace to reference by name — they are not automatically bound to all agents.
- **Secret (provider `secret` field)** — the name of a Kubernetes Secret in the tenant namespace, attached to a provider declaration, from which the control plane reads credential values and passes them over gRPC to configure OpenShell providers. This is a transitional mechanism — once [NVIDIA/OpenShell#1882](https://github.com/NVIDIA/OpenShell/issues/1882) is resolved, the gateway will load secrets directly and ACP will only need to pass references.
- **Provider Declaration** — a YAML document within a ConfigMap (labeled `ambient.ai/kind: provider`) that defines a named provider with its type and the Secret holding its credential. Provider declarations are namespace-scoped and available for any agent in the tenant namespace to reference. Agent configurations specify which of these providers they require for their workload.
- **Sandbox Template** — compute and runtime configuration for the sandbox container: image, CPU/memory/GPU resources, runtime class, driver config.
- **Agent Declaration** vs **Agent** — an Agent Declaration is the YAML input format (the ConfigMap data); an Agent is the reconciled platform entity in the API server's database. The control plane reconciles declarations into agents.
- **Tenant Namespace** — a Kubernetes namespace scoped to a project, named `{project_name}` by convention. ConfigMaps containing agent declarations are applied here by ArgoCD.
- **Base Agent** — *(future)* a shared agent configuration baseline composed via Kustomize overlays at apply time. The control plane only sees the fully-resolved result. See `agent-inheritance.spec.md` (draft).

---

## Agent YAML Schema

### Identity

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Human-readable identifier; unique within the project. Stable address: `{project_name}/{agent_name}`. |
| `display_name` | string | no | Human-friendly display label. |
| `description` | string | no | Purpose description for the agent. |
| `prompt` | string | no | Standing instructions defining who this agent is. Injected into every session start context. |
| `labels` | map[string]string | no | Queryable key-value metadata. |
| `annotations` | map[string]string | no | Freeform key-value metadata. |

### Entrypoint

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `entrypoint` | string | no | `claude` | CLI binary to launch inside the sandbox. Valid values include `claude`, `opencode`, `bash`, or any binary on the sandbox image's `PATH`. |

### Providers

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `providers` | array of string | no | Names of providers this agent requires. Each name references a provider declared in a Provider ConfigMap in the same tenant namespace. |

Providers are namespace-scoped resources declared separately from agents (see [Provider Declarations](#provider-declarations)). Agents reference them by name. At sandbox creation time, the control plane resolves each referenced provider, reads its Secret, and creates or refreshes the provider on the OpenShell Gateway.

### Payloads

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `payloads` | array of Payload | no | Content to upload into the sandbox filesystem before the entrypoint launches. |

**Payload object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sandbox_path` | string | yes | Absolute path inside the sandbox where the content is delivered. |
| `content` | string | one of | Inline string content to place at the sandbox path. |
| `repo_url` | string | one of | Git repository URL to clone into the sandbox path. Supports the same URL formats as the current ACP agent `repo_url` field (HTTPS, SSH). |
| `ref` | string | no | Git ref to check out (branch, tag, or commit SHA). Only valid with `repo_url`. Defaults to the repository's default branch. |

Exactly one of `content` or `repo_url` MUST be specified per payload entry. Specifying both is a validation error.

> **Path constraints.** `sandbox_path` MUST be an absolute path within the sandbox root (`/sandbox/`). The control plane SHALL reject paths containing `..` traversal segments or paths outside `/sandbox/`.

### Environment

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `environment` | map[string]string | no | Environment variables injected into the sandbox. Literal string values. |

### Sandbox Template

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sandbox_template` | SandboxTemplate | no | Compute and runtime configuration for the sandbox container. |

**SandboxTemplate object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `image` | string | no | OCI container image reference for the sandbox. Defaults to the platform's configured sandbox image. |
| `resources` | ResourceRequirements | no | CPU and memory requests/limits. |
| `gpu` | GpuRequirements | no | GPU resource requirements. |
| `runtime_class_name` | string | no | Kubernetes RuntimeClassName for the sandbox pod. |
| `driver_config` | object | no | OpenShell driver-specific opaque configuration (JSON). |
| `labels` | map[string]string | no | Labels applied to the sandbox compute resources (pods). Distinct from agent-level `labels`. |
| `annotations` | map[string]string | no | Annotations applied to the sandbox compute resources. Distinct from agent-level `annotations`. |
| `log_level` | string | no | Sandbox supervisor log verbosity: `debug`, `info`, `warn`, `error`. Default: `warn`. |

> **Platform abstraction.** The `resources` and `gpu` fields are platform-level abstractions. In the OpenShell proto, `SandboxTemplate.resources` is a `google.protobuf.Struct` (opaque JSON) and GPU is a separate field on `SandboxSpec`. The control plane maps these user-friendly fields to the appropriate proto structures when calling `CreateSandbox`.
>
> **Initial support.** Not all sandbox template fields may be supported in the initial platform implementation. The schema includes them for forward compatibility with OpenShell capabilities. Fields like `gpu`, `runtime_class_name`, and `driver_config` will be accepted but SHALL be ignored until the platform adds support.

**ResourceRequirements object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cpu` | string | no | CPU request/limit in Kubernetes quantity format (e.g., `"2"`, `"500m"`). |
| `memory` | string | no | Memory request/limit in Kubernetes quantity format (e.g., `"4Gi"`, `"256Mi"`). |

**GpuRequirements object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `count` | integer | no | Number of GPUs to allocate. Default: `0`. |

### Sandbox Policy

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sandbox_policy` | string | no | Name of a policy declared in a Policy ConfigMap in the same tenant namespace. When omitted, the platform's default policy applies. |

Policies are namespace-scoped resources declared separately from agents (see [Policy Declarations](#policy-declarations)). Each policy contains a raw upstream OpenShell `SandboxPolicy` YAML definition — the control plane passes it through to `CreateSandbox` as-is. Agents reference policies by name.

> **Policy composition via Kustomize.** Agents reference a single policy by name. Composing multiple policy concerns (e.g., combining a base network policy with agent-specific endpoints) is handled via Kustomize overlays at apply time — see `agent-inheritance.spec.md` (draft). The control plane only sees the fully-resolved policy ConfigMap.

---

## Provider Declarations

Providers are namespace-scoped resources declared in their own ConfigMaps, separate from agent declarations. A provider binds a name to a Secret. Multiple agents in the same namespace can reference the same provider.

### Discovery

The control plane SHALL discover provider declarations by watching ConfigMaps with the label `ambient.ai/kind: provider` in tenant namespaces.

### Structure

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: provider-declarations
  namespace: {project_name}
  labels:
    ambient.ai/kind: provider
data:
  github: |
    name: github
    type: github
    secret: github-pat
  anthropic: |
    name: anthropic
    type: anthropic
    secret: anthropic-key
```

### Provider Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique provider name within the namespace. This is the name agents use to reference the provider. |
| `type` | string | yes | ACP credential type (e.g., `github`, `anthropic`, `jira`, `vertex`, `kubeconfig`, `generic`). The control plane maps this to the corresponding OpenShell provider type at sandbox creation time — see [Credential-to-Provider Type Mapping](#credential-to-provider-type-mapping). |
| `secret` | string | yes | Name of a Kubernetes Secret in the tenant namespace that holds the credential for this provider (e.g., `github-pat`). The Secret must exist in the same namespace as the provider ConfigMap. |

> **Transitional mechanism.** Currently, ACP must read the Secret from Kubernetes, extract the credential value, and pass it over gRPC to the gateway to configure the OpenShell provider. Once [NVIDIA/OpenShell#1882](https://github.com/NVIDIA/OpenShell/issues/1882) is resolved, ACP should be able to pass the Secret name directly to the gateway, which will load and read the credentials itself — eliminating the need for ACP to handle credential values in transit.

> **Scope restrictions.** References are scoped to the tenant namespace — only Secrets within the same namespace as the provider ConfigMap can be referenced. The control plane SHALL enforce this at reconcile time by rejecting provider declarations that reference Secrets in other namespaces. The control plane's Kubernetes RBAC SHALL be scoped to only permit `get` on Secrets in tenant namespaces it manages.

### Credential-to-Provider Type Mapping

When the control plane creates OpenShell providers on the gateway, it maps ACP credential types to OpenShell provider types. This is the handoff boundary — ACP resolves credentials, OpenShell manages providers:

| ACP Credential Type | OpenShell Provider Type |
|---------------------|------------------------|
| `github` | `github` |
| `anthropic` | `claude` |
| `claude` | `claude` |
| `jira` | `generic` |
| `google` | `generic` |
| `vertex` | `google-vertex-ai` |
| `kubeconfig` | `generic` |
| `mlflow` | `generic` |

Credential types not in this table are mapped to `generic`. The mapping may be extended as new credential types are added.

### OpenShell Provider Naming

When the control plane creates an OpenShell provider on the gateway, it SHALL use the naming convention `{projectName}-{providerName}`. This scopes providers to the project and ensures unique provider names on the gateway.

For example, a provider declaration named `github` in project `alpha` becomes OpenShell provider `alpha-github` on the gateway.

### Sandbox Creation Flow

When a sandbox session starts for an agent:

1. The control plane reads the agent's `providers` list (array of names)
2. For each provider name, the control plane looks up the provider declaration in the namespace
3. The control plane reads the credential from the provider's referenced Secret
4. The control plane maps the credential type to an OpenShell provider type (see [Credential-to-Provider Type Mapping](#credential-to-provider-type-mapping))
5. If an OpenShell provider already exists on the gateway (by gateway-scoped name) → refresh the credential
6. If no OpenShell provider exists → create one with the resolved credential and mapped type
7. The control plane calls `CreateSandbox` with all OpenShell provider names attached
8. The control plane tracks which environment variables each OpenShell provider injects (see [OpenShell Provider-Injected Environment Variables](#openshell-provider-injected-environment-variables))

### OpenShell Provider-Injected Environment Variables

OpenShell providers inject specific environment variables into the sandbox at the gateway level (e.g., `ANTHROPIC_API_KEY` for `claude` providers, `GITHUB_TOKEN` for `github` providers). This happens on the OpenShell side — the control plane does not inject these variables directly.

When building the sandbox environment map, the control plane SHALL detect which variables each OpenShell provider is known to inject and remove any agent-declared environment variables that would conflict — the OpenShell provider-injected value takes precedence. The control plane SHALL log a warning for each skipped variable.

---

## Policy Declarations

Policies are namespace-scoped resources declared in their own ConfigMaps, separate from agent declarations. A policy contains an upstream OpenShell `SandboxPolicy` YAML definition stored as a `data` entry. The control plane treats the policy content as an opaque passthrough — it deserializes it as an OpenShell `SandboxPolicy` proto and passes it directly to `CreateSandbox`. Multiple agents in the same namespace can reference the same policy.

### Discovery

The control plane SHALL discover policy declarations by watching ConfigMaps with the label `ambient.ai/kind: policy` in tenant namespaces.

### Structure

Each policy is stored as a `data` entry. The data key is an arbitrary ConfigMap key used as a unique identifier within the ConfigMap. The YAML content includes a `name` field — a human-readable identifier that agents reference — followed by the upstream OpenShell `SandboxPolicy` fields. The `name` field is the authoritative policy identifier (not the data key), allowing descriptive names that would be invalid as ConfigMap keys.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: policy-declarations
  namespace: {project_name}
  labels:
    ambient.ai/kind: policy
data:
  restricted-github-only: |
    name: restricted-github-only
    network_policies:
      github_api:
        endpoints:
          - host: api.github.com
            port: 443
            protocol: rest
            rules:
              - allow:
                  method: "*"
                  path: "/**"
        binaries:
          - path: /usr/bin/git
      inference:
        endpoints:
          - host: inference.local
            port: 443
            protocol: rest
            rules:
              - allow:
                  method: POST
                  path: "/v1/**"
    filesystem:
      read_write:
        - /sandbox
        - /tmp
      read_only:
        - /usr
        - /etc
        - /lib
    process:
      run_as_user: sandbox
      run_as_group: sandbox
    landlock:
      compatibility: best_effort
  permissive-dev: |
    name: permissive-dev
    filesystem:
      read_write:
        - /sandbox
        - /tmp
      read_only:
        - /usr
        - /etc
    process:
      run_as_user: sandbox
      run_as_group: sandbox
```

### Policy Schema

The policy content is the upstream OpenShell `SandboxPolicy` YAML format. This spec does NOT re-document the OpenShell schema — the authoritative reference is the [OpenShell `SandboxPolicy` protobuf definition](https://github.com/NVIDIA/OpenShell). The control plane deserializes the YAML as a `SandboxPolicy` proto message and passes it through to `CreateSandbox`.

This passthrough approach ensures:
- **Guaranteed compatibility** — if OpenShell adds new policy fields, they work immediately without a platform spec or code update
- **No schema drift** — policy authors use the exact same format documented in OpenShell, not a platform-specific subset
- **Validation at the source** — the OpenShell Gateway validates the policy at `CreateSandbox` time; the control plane does not duplicate validation logic

Platform minimum enforcement (ensuring tenant policies cannot weaken platform-level security constraints) is planned but deferred — see [Sandbox Policy Minimum Enforcement (Deferred)](#requirement-sandbox-policy-minimum-enforcement-deferred).

### Conventions

- Each `data` key is an arbitrary ConfigMap key (e.g., `restricted`)
- The policy name is derived from the `name` field within the YAML content, not from the data key
- Policy names MUST be unique within a namespace (across all Policy ConfigMaps)
- One ConfigMap MAY contain multiple policy entries
- A tenant namespace MAY contain multiple Policy ConfigMaps

### Policy Resolution at Sandbox Creation

When building the `CreateSandbox` request:

1. The control plane reads the agent's `sandbox_policy` field (a policy name)
2. The control plane looks up the policy entry by `name` field in Policy ConfigMaps in the tenant namespace
3. The control plane deserializes the YAML content as an OpenShell `SandboxPolicy` proto message
4. The deserialized policy is passed to OpenShell's `CreateSandbox` RPC (platform minimum enforcement is deferred — see [Sandbox Policy Minimum Enforcement (Deferred)](#requirement-sandbox-policy-minimum-enforcement-deferred))

---

## Requirements

### Requirement: Agent Declaration via ConfigMap

Agent definitions SHALL be expressed as YAML documents within ConfigMaps in tenant namespaces. The control plane SHALL watch for ConfigMap changes and reconcile agent state.

#### Scenario: Single agent in a ConfigMap

- GIVEN a ConfigMap with label `ambient.ai/kind: agent` exists in tenant namespace `alpha`
- AND the ConfigMap's `data` contains a key `security-reviewer` with a valid agent YAML document
- WHEN the control plane reconciles the namespace
- THEN an agent named `security-reviewer` SHALL be created in project `alpha`
- AND the agent's sandbox configuration SHALL reflect the YAML document

#### Scenario: Multiple agents in a single ConfigMap

- GIVEN a ConfigMap with label `ambient.ai/kind: agent` exists in tenant namespace `alpha`
- AND the ConfigMap's `data` contains keys `reviewer` and `builder`
- WHEN the control plane reconciles the namespace
- THEN agents `reviewer` and `builder` SHALL both be created in project `alpha`

#### Scenario: ConfigMap update triggers reconciliation

- GIVEN an agent `reviewer` was created from a ConfigMap
- WHEN the ConfigMap's `reviewer` data key is updated with a new `entrypoint` value
- THEN the control plane SHALL update the agent's configuration to match
- AND no running session SHALL be affected (changes apply to the next session start)

#### Scenario: ConfigMap deletion removes agent

- GIVEN an agent `reviewer` was created from a ConfigMap
- WHEN the ConfigMap is deleted
- THEN the agent SHALL be removed from the project
- AND any running session for that agent SHALL NOT be terminated (it completes normally)
- AND the status for that running session SHALL still be available to view in the UI

#### Scenario: Invalid YAML rejected

- GIVEN a ConfigMap contains a data key with invalid agent YAML (e.g., missing `name`)
- WHEN the control plane attempts to reconcile
- THEN the invalid entry SHALL be rejected with a clear error in the control plane logs
- AND valid entries in the same ConfigMap SHALL still be reconciled

---

### Requirement: Entrypoint Declaration

The agent YAML SHALL declare which binary runs inside the sandbox. The entrypoint defaults to `claude` when not specified.

> **Execution model.** The OpenShell gateway overrides the sandbox container's entrypoint to its supervisor binary (`/opt/openshell/bin/openshell-sandbox`) and hardcodes `OPENSHELL_SANDBOX_COMMAND=sleep infinity`. The runner image's `CMD`/`ENTRYPOINT` is never executed. The agent's `entrypoint` is delivered to the sandbox via `ExecSandbox` after the sandbox reaches `SANDBOX_PHASE_READY` — see [Sandbox Command Execution](#requirement-sandbox-command-execution).

#### Scenario: Custom entrypoint

- GIVEN an agent declaration with `entrypoint: opencode`
- WHEN a session starts for this agent
- THEN the control plane SHALL pass `opencode` as the command to `ExecSandbox` after the sandbox reaches Ready

#### Scenario: Default entrypoint

- GIVEN an agent declaration with no `entrypoint` field
- WHEN a session starts for this agent
- THEN the control plane SHALL pass `claude` as the command to `ExecSandbox` after the sandbox reaches Ready

#### Scenario: Invalid entrypoint

- GIVEN an agent declaration with `entrypoint: /nonexistent/binary`
- WHEN a session starts for this agent
- THEN the `ExecSandbox` call SHALL fail
- AND the session SHALL transition to `Failed` with a clear error message

---

### Requirement: Provider Reference Resolution

The agent YAML SHALL declare which providers the agent requires as an array of provider name strings. The control plane SHALL resolve each name to a provider declaration in the tenant namespace and execute the sandbox creation flow (see Provider Declarations § Sandbox Creation Flow) before creating the sandbox.

#### Scenario: Provider declaration exists in namespace

- GIVEN an agent declares `providers: [github]`
- AND a provider declaration named `github` exists in the tenant namespace (ConfigMap labeled `ambient.ai/kind: provider`)
- WHEN a session starts for this agent
- THEN the control plane SHALL read the `github` provider's Secret
- AND register or refresh the provider on the OpenShell Gateway
- AND the sandbox SHALL have access to the `github` provider's credentials via the gateway egress proxy

#### Scenario: Provider declaration not found

- GIVEN an agent declares `providers: [nonexistent-provider]`
- AND no provider declaration named `nonexistent-provider` exists in the tenant namespace
- WHEN a session starts for this agent
- THEN the session start SHALL fail
- AND the error SHALL identify the missing provider declaration by name

#### Scenario: Provider credential refresh

- GIVEN an agent declares `providers: [github]`
- AND a provider named `github` already exists on the gateway from a previous session
- WHEN a new session starts for this agent
- THEN the control plane SHALL read the current credential from the provider declaration's Secret
- AND refresh the provider's credential on the gateway (not create a duplicate)

#### Scenario: Multiple providers

- GIVEN an agent declares `providers: [github, anthropic]`
- AND both `github` and `anthropic` provider declarations exist in the tenant namespace
- WHEN a session starts
- THEN both providers SHALL be resolved and registered on the gateway
- AND failure to resolve one provider SHALL fail the session start (all declared providers are required)

#### Scenario: Provider shared across agents

- GIVEN provider declaration `github` exists in namespace `alpha`
- AND agents `reviewer` and `builder` both declare `providers: [github]`
- WHEN sessions start for both agents
- THEN both sessions SHALL use the same `github` provider on the gateway
- AND each session SHALL trigger a credential refresh for the shared provider

---

### Requirement: Payload Injection

The agent YAML SHALL declare payloads to deliver into the sandbox before the entrypoint launches. Each payload specifies a `sandbox_path` and exactly one source: `content` (inline) or `repo_url` (git clone).

**Delivery mechanism:** Inline content payloads are delivered via SSH-over-gRPC, following the OpenShell CLI's upload pattern. The control plane opens an SSH session through the gateway (`CreateSshSession` → `ForwardTcp` stream → SSH handshake) and writes each payload file via `mkdir -p <dir> && cat > <path>` with the content piped to stdin. This runs as root through the supervisor's embedded SSH server, bypassing the sandbox's read-only root filesystem restriction that prevents writes via `ExecSandbox`.

#### Scenario: Inline content payload (prompt)

- GIVEN an agent declares:
  ```yaml
  payloads:
    - sandbox_path: /sandbox/.claude/CLAUDE.md
      content: |
        You are a security review agent.
  ```
- WHEN a session starts
- THEN the file `/sandbox/.claude/CLAUDE.md` SHALL exist in the sandbox with the declared content
- AND the file SHALL be available before the entrypoint process starts

#### Scenario: Repository payload

- GIVEN an agent declares:
  ```yaml
  payloads:
    - sandbox_path: /sandbox/workspace
      repo_url: https://github.com/example/my-repo.git
      ref: main
  ```
- WHEN a session starts
- THEN the repository SHALL be cloned into `/sandbox/workspace`
- AND the `main` branch SHALL be checked out
- AND the clone SHALL complete before the entrypoint process starts

#### Scenario: Repository payload with default ref

- GIVEN an agent declares a payload with `repo_url` but no `ref`
- WHEN the repository is cloned
- THEN the repository's default branch SHALL be checked out

#### Scenario: Missing sandbox_path (validation error)

- GIVEN an agent declares a payload without `sandbox_path`
- WHEN the control plane validates the agent YAML
- THEN the declaration SHALL be rejected

#### Scenario: Multiple sources (validation error)

- GIVEN an agent declares a payload with both `content` and `repo_url`
- WHEN the control plane validates the agent YAML
- THEN the declaration SHALL be rejected (exactly one source required)

---

### Requirement: Sandbox Policy Application

The agent YAML SHALL reference a sandbox policy by name. The control plane SHALL resolve the named policy from the tenant namespace and pass it to OpenShell's `CreateSandbox` RPC.

#### Scenario: Policy declaration exists in namespace

- GIVEN an agent declares `sandbox_policy: restricted`
- AND a policy declaration named `restricted` exists in the tenant namespace (ConfigMap labeled `ambient.ai/kind: policy`)
- WHEN a session starts for this agent
- THEN the control plane SHALL resolve the `restricted` policy
- AND pass the policy's network, filesystem, process, and Landlock constraints to `CreateSandbox`

#### Scenario: Policy declaration not found

- GIVEN an agent declares `sandbox_policy: nonexistent-policy`
- AND no policy declaration named `nonexistent-policy` exists in the tenant namespace
- WHEN a session starts for this agent
- THEN the session start SHALL fail
- AND the error SHALL identify the missing policy declaration by name

#### Scenario: No sandbox policy (default applied)

- GIVEN an agent declaration with no `sandbox_policy` field
- WHEN a session starts
- THEN the platform's default sandbox policy SHALL be applied
- AND the default policy SHALL restrict network access to the minimum required for the declared providers

#### Scenario: Policy shared across agents

- GIVEN policy declaration `restricted` exists in namespace `alpha`
- AND agents `reviewer` and `builder` both declare `sandbox_policy: restricted`
- WHEN sessions start for both agents
- THEN both sessions SHALL use the same resolved policy constraints

#### Scenario: Deny rules take precedence

> **Note:** Deny rule enforcement is OpenShell's responsibility. This scenario documents the expected behavior from the platform's perspective as a test case outcome.

- GIVEN a policy declaration with a network policy containing an allow rule for `*.github.com:443` and a deny rule for `raw.githubusercontent.com:443`
- WHEN an agent referencing this policy attempts to connect to `raw.githubusercontent.com:443`
- THEN the connection SHALL be blocked (deny rule takes precedence — enforced by OpenShell)

---

### Requirement: Sandbox Template

The agent YAML SHALL declare compute and runtime configuration for the sandbox container via the `sandbox_template` field.

#### Scenario: Custom image

- GIVEN an agent declares `sandbox_template.image: ghcr.io/nvidia/openshell:sandbox-v0.2.0`
- WHEN a session starts
- THEN the sandbox SHALL use the specified image

#### Scenario: Default image

- GIVEN an agent declaration with no `sandbox_template.image`
- WHEN a session starts
- THEN the sandbox SHALL use the platform's configured default sandbox image

#### Scenario: Resource requests

- GIVEN an agent declares:
  ```yaml
  sandbox_template:
    resources:
      cpu: "2"
      memory: 4Gi
  ```
- WHEN a session starts
- THEN the sandbox container SHALL request 2 CPU cores and 4Gi memory

#### Scenario: GPU allocation

- GIVEN an agent declares `sandbox_template.gpu.count: 1`
- WHEN a session starts
- THEN the sandbox SHALL be allocated 1 GPU

---

### Requirement: Environment Variables

The agent YAML SHALL declare environment variables as a structured `map[string]string`. These are injected into the sandbox at creation time.

#### Scenario: Literal environment variables

- GIVEN an agent declares:
  ```yaml
  environment:
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1"
    MY_VAR: hello
  ```
- WHEN a session starts
- THEN the sandbox SHALL have `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` and `MY_VAR=hello` in its environment

#### Scenario: Provider-injected variables take precedence

- GIVEN an agent declares an environment variable that overlaps with a provider-injected variable
- AND the `anthropic` provider injects the same variable via the gateway
- WHEN a session starts
- THEN the provider-injected value SHALL take precedence over the agent-declared value

---

### Requirement: Sandbox Command Execution

The OpenShell gateway's Kubernetes driver overrides the container entrypoint to the supervisor binary (`/opt/openshell/bin/openshell-sandbox`) and hardcodes `OPENSHELL_SANDBOX_COMMAND=sleep infinity` in the container environment. The sandbox boots with `sleep infinity` as its main process — the runner image's `CMD`/`ENTRYPOINT` is never executed. This is by design: the OpenShell sandbox model treats the sandbox as a persistent workspace where user commands run via exec after provisioning completes.

The control plane SHALL start the runner process inside the sandbox by calling the `ExecSandbox` gRPC RPC after the sandbox reaches `SANDBOX_PHASE_READY`. The `ExecSandbox` RPC is a server-streaming call that returns stdout, stderr, and exit code events. The `ExecSandboxRequest.SandboxId` field requires the gateway's internal sandbox UUID (from `Sandbox.Metadata.Id` in the `GetSandbox` response), not the Kubernetes sandbox name.

#### Scenario: Runner startup via ExecSandbox

- GIVEN a sandbox has been created via `CreateSandbox`
- WHEN the sandbox reaches `SANDBOX_PHASE_READY`
- THEN the control plane SHALL call `ExecSandbox` with the agent's `entrypoint` command (default: `claude`)
- AND the `SandboxId` SHALL be the gateway's internal UUID obtained from `GetSandbox` response metadata
- AND the exec SHALL run asynchronously (fire-and-forget) — the control plane does not block on the exec stream

#### Scenario: Polling for sandbox readiness

- GIVEN a sandbox was just created
- WHEN the control plane polls `GetSandbox` for readiness
- THEN it SHALL poll every 2 seconds with a configurable timeout (default 600 seconds, set via `SANDBOX_READINESS_TIMEOUT_SECONDS` env var)
- AND the control plane SHALL log a progress message every 30 seconds during polling, including sandbox name, session ID, and elapsed time
- AND if the sandbox enters `SANDBOX_PHASE_ERROR`, the control plane SHALL log an error, stop polling, and transition the session to `Failed`
- AND if the timeout expires before `SANDBOX_PHASE_READY`, the control plane SHALL log an error and transition the session to `Failed`

#### Scenario: OPENSHELL_SANDBOX_COMMAND is not used

- GIVEN the control plane builds the sandbox environment map
- THEN it SHALL NOT include `OPENSHELL_SANDBOX_COMMAND` in the environment
- AND the runner start command SHALL only be delivered via `ExecSandbox` after the sandbox is ready

---

### Requirement: Schema Validation

The control plane SHALL validate agent YAML against the schema before reconciling. Invalid declarations SHALL be rejected with clear error messages.

#### Scenario: Missing required field

- GIVEN an agent YAML with no `name` field
- WHEN the control plane validates
- THEN the declaration SHALL be rejected
- AND the error SHALL identify `name` as a required field

#### Scenario: Unknown fields

- GIVEN an agent YAML with an unrecognized field `foo: bar`
- WHEN the control plane validates
- THEN the declaration SHOULD be accepted (unknown fields are ignored for forward compatibility)
- AND the control plane SHOULD log a warning about the unrecognized field

#### Scenario: Type mismatch

- GIVEN an agent YAML with `sandbox_template.gpu.count: "not-a-number"`
- WHEN the control plane validates
- THEN the declaration SHALL be rejected with a type mismatch error

---

### Requirement: Sandbox Policy Minimum Enforcement (Deferred)

> **Out of scope for this PR.** The platform SHALL enforce minimum sandbox policy constraints regardless of what a policy declaration specifies. Policy declarations are additive on top of platform minimums — they cannot weaken them. Merge semantics, enforcement mechanism, and the location of platform-level default policies will be defined in a future spec. See Iteration 4 in [Implementation Iterations](#implementation-iterations).

---

### Requirement: ConfigMap Authorization

Access control for agent declarations relies on Kubernetes RBAC for the tenant namespace. Only principals with write access to ConfigMaps in a tenant namespace can create or modify agent declarations.

#### Scenario: Authorized user creates agent declaration

- GIVEN user A has RBAC permission to create/update ConfigMaps in namespace `alpha`
- WHEN user A creates a ConfigMap with label `ambient.ai/kind: agent`
- THEN the control plane SHALL reconcile the agent declaration

#### Scenario: ArgoCD applies agent declarations

- GIVEN ArgoCD has RBAC permission to manage ConfigMaps in tenant namespaces
- WHEN ArgoCD syncs a git repository containing agent declaration ConfigMaps
- THEN the ConfigMaps SHALL be applied to the tenant namespace
- AND the control plane SHALL reconcile the agent declarations

---

### Requirement: Feature Flag Gating

ConfigMap-based agent declaration and OpenShell Gateway sandbox provisioning SHALL be gated behind feature flags. When disabled, the existing runner-based agent lifecycle remains unchanged.

#### Scenario: Gateway mode enabled

- GIVEN `OPENSHELL_USE_GATEWAY=true` in the control plane configuration
- WHEN the control plane starts
- THEN the control plane SHALL watch for agent declaration ConfigMaps in tenant namespaces
- AND provision sandboxes via the OpenShell Gateway for sessions using ConfigMap-declared agents

#### Scenario: Gateway mode disabled (default)

- GIVEN `OPENSHELL_USE_GATEWAY=false` (or unset) in the control plane configuration
- WHEN the control plane starts
- THEN the control plane SHALL NOT watch for agent declaration ConfigMaps
- AND the existing runner-based session provisioning SHALL remain the active path

---

## ConfigMap Format

### Discovery

The control plane SHALL discover agent declarations by watching ConfigMaps with the label `ambient.ai/kind: agent` in tenant namespaces.

### Structure

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: agent-declarations
  namespace: {project_name}
  labels:
    ambient.ai/kind: agent
data:
  security-reviewer: |
    name: security-reviewer
    description: Reviews PRs for security vulnerabilities
    prompt: You are a security review agent.
    entrypoint: claude
    providers:
      - github
      - anthropic
    # ... (full agent YAML)
  builder: |
    name: builder
    # ... (another agent YAML)
```

### Conventions

- Each data key is an arbitrary ConfigMap key (e.g., `reviewer`)
- Each data value is a complete agent YAML document
- One ConfigMap MAY contain multiple agent declarations
- A tenant namespace MAY contain multiple agent ConfigMaps
- Agent names MUST be unique within a project (across all ConfigMaps in the namespace)
- The ConfigMap name is not significant — the agent `name` field inside the YAML is the identifier

### Reconciliation

- The control plane SHALL reconcile on ConfigMap create, update, and delete events
- On update: the control plane SHALL diff the previous and current data keys, applying creates, updates, and deletes for individual agents accordingly
- On delete: all agents declared in the ConfigMap SHALL be removed from the project
- Running sessions SHALL NOT be affected by agent declaration changes — changes apply to the next session start

---

## Storage Model

The control plane reads agent declarations from ConfigMaps as the source of truth. The control plane SHALL persist agent state in the API server's PostgreSQL database using the existing `agents` table so that agent configurations remain visible and queryable via the REST API and UI. The UI SHALL display ConfigMap-sourced agents the same way it displays API-created agents — the source of the agent declaration is transparent to the user.

When persisted, the new structured fields map to columns as follows:

| YAML Field | Column | Type | Notes |
|------------|--------|------|-------|
| `entrypoint` | `entrypoint` | TEXT | Nullable; default `claude` |
| `providers` | `providers` | JSONB | Array of provider name strings (e.g., `["github", "anthropic"]`). Provider declarations are resolved from namespace-scoped ConfigMaps at sandbox creation time. |
| `payloads` | `payloads` | JSONB | Array of payload objects |
| `environment` | `environment` | JSONB | Map of string → string |
| `sandbox_template` | `sandbox_template` | JSONB | Nested object |
| `sandbox_policy` | `sandbox_policy` | TEXT | Nullable; name of a policy declaration in the tenant namespace. Policy declarations are resolved from namespace-scoped ConfigMaps at sandbox creation time. |

Legacy fields (`resource_overrides`, `environment_variables` as TEXT) remain in the table for backward compatibility during migration but are not populated by ConfigMap-sourced agents.

---

## Migration

### Existing consumers

| Consumer | Current behavior | Required change |
|----------|-----------------|-----------------|
| Control plane reconciler | Watches API server for sessions, provisions K8s Jobs with runner containers | Watch ConfigMaps for agent declarations; provision OpenShell sandboxes via Gateway gRPC instead of K8s Jobs |
| API server (agents plugin) | Full CRUD for Agent resource via REST API | May become read-only consumer of ConfigMap-sourced agents; retain for status/query; add JSONB columns for new fields |
| CLI (`acpctl apply`) | Submits agent YAML to API server | May write ConfigMaps directly to tenant namespaces or continue via API |
| Runner (Python) | Executes Claude Code CLI in K8s Job pod | Bypassed when `OPENSHELL_USE_GATEWAY=true` — sessions for ConfigMap-declared agents use OpenShell sandboxes instead. Runner remains active for REST API-created agents and when gateway mode is disabled. |
| UI agent editor | Full CRUD via REST API | May become read-only view of ConfigMap-declared agents; editing requires ConfigMap update flow |
| Go/Python/TS SDKs | Generated from OpenAPI Agent schema | Regenerate if API schema changes to include new fields |
| ArgoCD | Not involved in agent lifecycle | Must be configured to sync agent declaration ConfigMaps into tenant namespaces (prerequisite) |

### Specs requiring amendment

| Spec | Amendment |
|------|-----------|
| `specs/platform/data-model.spec.md` | Update Agent entity fields; document ConfigMap as source of truth for agent declarations |
| `specs/platform/control-plane.spec.md` | Add ConfigMap watching; replace Job provisioning with OpenShell Gateway sandbox creation |
| `specs/platform/runner.spec.md` | Document feature-flag gating; runner is bypassed when gateway mode is enabled but remains active otherwise |
| `specs/security/openshell-sandbox.spec.md` | Extend from file-mode to gateway-mode; reference per-agent sandbox policies from this spec |

---

## Implementation Iterations

This spec describes the complete desired state. Implementation is expected to proceed in iterations, with each building on the previous:

### Iteration 1: Gateway Sandbox Provisioning (current — PR #179)

**Scope:** Route session provisioning through the OpenShell Gateway instead of creating Kubernetes pods directly.

**What's implemented:**
- Feature flag: `OPENSHELL_USE_GATEWAY=true` gates gateway mode
- Provider resolution via the existing REST API Credential/RoleBinding system (`sdk.Credentials().Get()` → `CreateProvider` on gateway)
- Credential-to-provider type mapping (ACP credential types → OpenShell provider types) and gateway naming (`{projectName}-{providerName}`)
- `CreateSandbox` gRPC call with image, environment, and provider references
- `ExecSandbox` to start the runner after sandbox readiness
- Per-namespace gRPC connection cache with mTLS and K8s ServiceAccount authentication
- Sandbox status synchronization (`GetSandbox` polling, phase mapping)
- Sandbox deprovisioning via `DeleteSandbox`

**What's NOT in this iteration:**
- ConfigMap-based agent declarations (`ambient.ai/kind: agent`)
- ConfigMap-based provider declarations (`ambient.ai/kind: provider`)
- ConfigMap-based policy declarations (`ambient.ai/kind: policy`)
- Sandbox policy passthrough and platform minimum enforcement
- ConfigMap-based credential resolution via Secret references

> **Note on credential resolution.** Iteration 1 resolves credentials via the existing Credential/RoleBinding system — the control plane calls `sdk.Credentials().Get()` and `sdk.RoleBindings().List()` to find credentials for each provider, then creates providers on the gateway. The ConfigMap-based provider declarations with Secret references described in this spec are the desired future state for Iteration 2+, which decouples credential management from the REST API and aligns with the GitOps model.

### Iteration 2: ConfigMap-Based Agent Declarations

**Scope:** Implement the agent declaration model described in this spec.

**Delivers:**
- ConfigMap watching with `ambient.ai/kind: agent` label discovery
- Agent YAML schema parsing and validation
- Reconciliation of ConfigMap-declared agents into the `agents` table
- Session provisioning from ConfigMap-declared agents via the gateway (building on Iteration 1)
- `acpctl apply` support for agent declaration ConfigMaps

> **Known gap (PR #246):** The `ApplicationReconciler`'s `gitAgentDeclaration` struct currently supports `name`, `display_name`, `description`, `prompt`, `entrypoint`, `providers`, `payloads`, `environment`, `repo_url`, `llm_model`, `labels`, and `annotations` — but does NOT include `sandbox_template` or `sandbox_policy`. Git-sourced agent declarations cannot yet declare compute resources or custom sandbox policies. The `UploadPayloads` SSH mechanism (Iteration 1) is wired to `agent.Payloads` at sandbox creation time, so payload delivery works end-to-end for git-sourced agents.
>
> **Known gap (`acpctl apply`):** The `acpctl apply` command's `resource` struct and `buildAgentPatch()` function do not include `sandbox_policy`, `sandbox_template`, or `entrypoint` fields. These fields are silently dropped during YAML parsing, meaning `acpctl apply -k` cannot set them on agents. The API server and SDK fully support these fields via PATCH. Additionally, `Policy` is not a supported `kind` in `acpctl apply` despite having full CRUD in the API server (`plugins/policies/`) and SDK (`Policys()` client). Both gaps must be closed so that new deployments can declaratively configure sandbox policies and agent sandbox settings without manual API calls.

**Depends on:** Iteration 1 (gateway provisioning)

### Iteration 3: ConfigMap-Based Provider Declarations

**Scope:** Move provider credential management from the REST API Credential/RoleBinding system to namespace-scoped ConfigMap declarations.

**Delivers:**
- ConfigMap watching with `ambient.ai/kind: provider` label discovery
- Provider schema parsing with Secret reference resolution
- Create-or-refresh provider flow using ConfigMap-declared credentials instead of SDK Credential API
- Agents reference providers by name (string array) instead of relying on implicit Credential/RoleBinding resolution

**Depends on:** Iteration 2 (ConfigMap agent declarations)

### Iteration 4: ConfigMap-Based Policy Declarations and Enforcement

**Scope:** Implement namespace-scoped sandbox policies and platform minimum enforcement.

**Delivers:**
- ConfigMap watching with `ambient.ai/kind: policy` label discovery
- Policy resolution from `data` entries containing upstream OpenShell `SandboxPolicy` YAML
- Opaque passthrough to `CreateSandbox`
- Platform minimum enforcement (merge semantics to be defined in a future spec)

**Depends on:** Iteration 2 (ConfigMap agent declarations, to provide the `sandbox_policy` name reference)

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| ConfigMap is the primary agent definition format | Agents will be declared via ArgoCD-managed ConfigMaps in tenant namespaces. REST API-based agent creation is a potential follow-up offering an RBAC-scoped developer path for creating agents without GitOps, but not the primary onboarding flow. This aligns with GitOps workflows and the existing Application (GitOps sync) model in `data-model.spec.md`. |
| Providers are namespace-scoped shared resources | Providers are declared in their own ConfigMaps (labeled `ambient.ai/kind: provider`) at the tenant namespace level, not inline within agent declarations. Agents reference providers by name. This enables sharing providers across multiple agents in a namespace (e.g., a single `github` provider used by both `reviewer` and `builder` agents). The control plane handles create-or-refresh at sandbox creation time. |
| Provider declarations reference Secrets | Each provider declaration includes a `secret` field — the name of a Kubernetes Secret in the tenant namespace that holds the credential. This is a transitional mechanism — designed to be forward-compatible with OpenShell's planned native credential management ([NVIDIA/OpenShell#1882](https://github.com/NVIDIA/OpenShell/issues/1882)). Provider Secret references bypass the existing platform Credential/RoleBinding hierarchy. |
| Policies are namespace-scoped shared resources using upstream OpenShell format | Policies are declared in their own ConfigMaps (labeled `ambient.ai/kind: policy`) at the tenant namespace level as `data` entries containing the upstream OpenShell `SandboxPolicy` YAML format with a `name` field. The control plane treats policies as an opaque passthrough — no platform-specific schema on top. This guarantees compatibility with OpenShell and means new OpenShell policy fields work immediately without a platform update. Agents reference a single policy by name. |
| Single policy reference, not array | Agents reference one policy by name. Composing multiple policy concerns is handled via Kustomize overlays at apply time (see `agent-inheritance.spec.md` draft). This avoids merge-order ambiguity at the agent level. |
| Mixed field grouping | Flat fields for `entrypoint`, `providers`, `payloads`, `sandbox_policy`, `environment` (frequently accessed, simple types or name references). Nested JSONB for `sandbox_template` (complex structure that maps directly to OpenShell proto messages). |
| Configuration reuse via Kustomize overlays (draft) | See `specs/platform/agent-inheritance.spec.md`. Uses Kustomize bases and overlays for configuration composition rather than a custom `base_agent` merge engine in the control plane. Composition happens at apply time (`acpctl apply` / ArgoCD); the control plane only sees fully-resolved ConfigMaps. Kept as a separate draft spec — agents are fully self-contained at the cluster level. |
| Policy uses upstream OpenShell YAML verbatim | Policy declarations contain the exact OpenShell `SandboxPolicy` YAML — no platform wrapper or re-documented fields. This eliminates schema drift and ensures any OpenShell-compatible policy works without platform changes. `sandbox_template` fields continue to mirror OpenShell proto naming for consistency. |
| Unknown fields accepted with warning | Forward compatibility — newer agent YAML schemas can be applied to older control planes without hard failures. |
| ConfigMap is the source of truth; PostgreSQL is a projection | ConfigMap-declared agents are the authoritative source. The API server's `agents` table is a read-optimized projection for queries and status reporting. The control plane reconciles ConfigMap → database, not the reverse. API PATCH operations on ConfigMap-sourced agents are not supported — changes flow through the ConfigMap (git → ArgoCD → ConfigMap → control plane). |
| ConfigMap authorization delegates to Kubernetes RBAC | Who can create/modify agent declarations is governed by Kubernetes RBAC on the tenant namespace. The control plane trusts that any ConfigMap with the correct label in the correct namespace was applied by an authorized principal. |
| Sandbox policy minimums are platform-enforced (out of scope for this PR) | Agent-declared sandbox policies cannot weaken platform-level security minimums. The control plane merges agent policies with platform defaults, and platform constraints always win. Merge semantics and enforcement details are deferred to a future spec. |
| Feature flag gating | All ConfigMap-based agent declaration and OpenShell Gateway provisioning is gated behind `OPENSHELL_USE_GATEWAY=true`. When disabled, the existing runner-based lifecycle is unchanged. This allows incremental rollout and rollback. |

---

## Example: Complete Agent YAML

```yaml
name: security-reviewer
display_name: Security Reviewer
description: Reviews PRs for OWASP top 10 vulnerabilities
prompt: |
  You are a security review agent specializing in OWASP top 10
  vulnerabilities. Review every PR for injection, XSS, CSRF,
  and authentication bypass risks.
entrypoint: claude

providers:
  - github
  - anthropic

environment:
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1"

payloads:
  - sandbox_path: /sandbox/workspace
    repo_url: https://github.com/example/my-service.git
    ref: main
  - sandbox_path: /sandbox/.claude/CLAUDE.md
    content: |
      You are a security review agent. Focus on:
      - SQL injection in database queries
      - XSS in rendered templates
      - Authentication bypass in middleware
  - sandbox_path: /sandbox/.claude/settings.json
    content: |
      {
        "permissions": {"allow": ["Bash", "Read", "Edit"]},
        "model": "claude-sonnet-4-20250514"
      }
  - sandbox_path: /sandbox/.mcp.json
    content: |
      {
        "mcpServers": {}
      }

sandbox_template:
  image: ghcr.io/nvidia/openshell:sandbox-v0.2.0
  resources:
    cpu: "2"
    memory: 4Gi
  gpu:
    count: 0

sandbox_policy: restricted

labels:
  team: platform-security
  tier: review

annotations:
  owner: foo.bar@example.com
```

---

## Example: All Three ConfigMap Types Together

A minimal project setup with provider, policy, and agent ConfigMaps in a single tenant namespace:

```yaml
# Provider declaration — namespace: alpha
apiVersion: v1
kind: ConfigMap
metadata:
  name: providers
  namespace: alpha
  labels:
    ambient.ai/kind: provider
data:
  github: |
    name: github
    type: github
    # credential source kubernetes secret
    secret: github-pat
  anthropic: |
    name: anthropic
    type: anthropic
    # credential source kubernetes secret
    secret: anthropic-key
---
# Policy declaration — namespace: alpha
apiVersion: v1
kind: ConfigMap
metadata:
  name: policies
  namespace: alpha
  labels:
    ambient.ai/kind: policy
data:
  restricted: |
    name: restricted
    network_policies:
      github_api:
        endpoints:
          - host: api.github.com
            port: 443
            protocol: rest
    filesystem:
      read_write:
        - /sandbox
      read_only:
        - /etc/openshell
    process:
      run_as_user: sandbox
      run_as_group: sandbox
---
# Agent declaration — namespace: alpha
apiVersion: v1
kind: ConfigMap
metadata:
  name: agents
  namespace: alpha
  labels:
    ambient.ai/kind: agent
data:
  reviewer: |
    name: reviewer
    description: Reviews PRs for security issues
    prompt: Review this PR for security vulnerabilities.
    entrypoint: claude
    providers:
      - github
      - anthropic
    payloads:
      - sandbox_path: /sandbox/workspace
        repo_url: https://github.com/example/my-service.git
      - sandbox_path: /sandbox/.claude/CLAUDE.md
        content: |
          Review this PR for security vulnerabilities.
    sandbox_policy: restricted
    sandbox_template:
      image: ghcr.io/nvidia/openshell:sandbox-v0.2.0
      resources:
        cpu: "1"
        memory: 2Gi
    environment:
      LOG_LEVEL: info
```

For configuration reuse across projects via Kustomize overlays, see `specs/platform/agent-inheritance.spec.md`.

---
