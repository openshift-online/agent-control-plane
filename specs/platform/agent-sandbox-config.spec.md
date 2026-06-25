# Agent Sandbox Configuration

**Date:** 2026-06-25
**Status:** Proposed
**Related:** `specs/platform/data-model.spec.md` (Agent entity), `specs/security/openshell-sandbox.spec.md` (file-mode sandbox isolation), `specs/security/credential-binding.spec.md` (credential resolution), `specs/platform/control-plane.spec.md` (session provisioning), `specs/platform/runner.spec.md` (runner lifecycle — being replaced)

---

## Purpose

Agent definitions SHALL be expressed as declarative YAML documents in ConfigMaps, applied by ArgoCD into tenant namespaces and reconciled by the ACP control plane. The YAML schema SHALL support the full range of OpenShell sandbox configuration: what binary runs inside the sandbox, what credentials it has access to, what network and filesystem policies constrain it, what content is pre-loaded, and what compute resources are allocated.

This spec extends the Agent concept from `data-model.spec.md` with sandbox-aware configuration fields aligned to NVIDIA OpenShell's `SandboxSpec`, `SandboxPolicy`, and `Provider` protobuf definitions. When gateway mode is enabled (`OPENSHELL_ENABLED=true` and `OPENSHELL_GATEWAY_ENABLED=true`), agents using this schema are executed via OpenShell Gateway-managed sandboxes instead of the existing Kubernetes Job runner model.

---

## Terminology

- **Agent Declaration** — a YAML document within a ConfigMap that defines an agent's identity, behavior, and sandbox configuration. The primary mechanism for creating and updating agents.
- **Provider** — an OpenShell Gateway-registered credential provider (e.g., `github`, `anthropic`, `jira`). The gateway's egress proxy resolves credential placeholders at the network boundary — credentials never enter the sandbox. Not to be confused with the `provider` field on the platform's `Credential` entity, which classifies the stored token type.
- **Payload** — content (file reference or inline text) uploaded into the sandbox filesystem at a declared path. Used for CLAUDE.md, settings, MCP configs, task files.
- **Entrypoint** — the CLI binary launched inside the sandbox (e.g., `claude`, `opencode`, `bash`).
- **Sandbox Policy** — an OpenShell `SandboxPolicy` governing network endpoints, filesystem paths, process identity, and Landlock constraints within the sandbox. Declared as a namespace-scoped resource in a Policy ConfigMap and referenced by agents by name.
- **Policy Declaration** — a YAML document within a ConfigMap (labeled `ambient.ai/kind: policy`) that defines a named sandbox policy with network, filesystem, process, and Landlock constraints. Policy declarations are namespace-scoped and shared across agents in the tenant namespace.
- **Credential Source** — a reference to an external secret store (Vault path or Kubernetes Secret) attached to a provider declaration, from which the control plane resolves credentials and creates or refreshes OpenShell providers. This is a transitional mechanism — see [NVIDIA/OpenShell#1882](https://github.com/NVIDIA/OpenShell/issues/1882).
- **Provider Declaration** — a YAML document within a ConfigMap (labeled `ambient.ai/kind: provider`) that defines a named provider with its type and credential source. Provider declarations are namespace-scoped and shared across agents in the tenant namespace.
- **Sandbox Template** — compute and runtime configuration for the sandbox container: image, CPU/memory/GPU resources, runtime class, driver config.
- **Agent Declaration** vs **Agent** — an Agent Declaration is the YAML input format (the ConfigMap data); an Agent is the reconciled platform entity in the API server's database. The control plane reconciles declarations into agents.
- **Tenant Namespace** — a Kubernetes namespace scoped to a project, named `project-{project_name}` by convention. ConfigMaps containing agent declarations are applied here by ArgoCD.
- **Base Agent** — *(future)* an agent definition from which other agents inherit configuration via overlay semantics.

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

Providers are namespace-scoped resources declared separately from agents (see [Provider Declarations](#provider-declarations)). Agents reference them by name. At sandbox creation time, the control plane resolves each referenced provider, reads its credential source, and creates or refreshes the provider on the OpenShell Gateway.

### Payloads

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `payloads` | array of Payload | no | Content to upload into the sandbox filesystem before the entrypoint launches. |

**Payload object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sandbox_path` | string | yes | Absolute path inside the sandbox where the content is mounted. |
| `content` | string | yes | Inline string content to place at the sandbox path. |

Since agent declarations live in ConfigMaps (reconciled by ArgoCD from git), payloads use inline `content` only. For binary content, use the ConfigMap's `binaryData` field.

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
> **Initial support.** Not all sandbox template fields may be supported in the initial platform implementation. The schema includes them for forward compatibility with OpenShell capabilities. Fields like `gpu`, `runtime_class_name`, and `driver_config` may be accepted but ignored until the platform adds support.

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

Policies are namespace-scoped resources declared separately from agents (see [Policy Declarations](#policy-declarations)). Agents reference them by name. At sandbox creation time, the control plane resolves the referenced policy and passes it to OpenShell's `CreateSandbox` RPC, merged with platform minimums.

> **Policy merging via inheritance.** Agents reference a single policy by name. Composing multiple policies (e.g., combining a base network policy with an agent-specific overlay) is deferred to the inheritance spec (`agent-inheritance.spec.md`), where merge semantics for policy fields are defined.

### Gateway

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `gateway` | string | no | OpenShell Gateway name to target. For multi-gateway deployments. Defaults to the gateway discovered via Kubernetes Service DNS in the tenant namespace. |

---

## Provider Declarations

Providers are namespace-scoped resources declared in their own ConfigMaps, separate from agent declarations. A provider binds a name to a credential source. Multiple agents in the same namespace can reference the same provider.

### Discovery

The control plane SHALL discover provider declarations by watching ConfigMaps with the label `ambient.ai/kind: provider` in tenant namespaces.

### Structure

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: provider-declarations
  namespace: project-{project_name}
  labels:
    ambient.ai/kind: provider
data:
  github.yaml: |
    name: github
    type: github
    credential_source:
      type: vault
      path: kv/data/agents/github-pat
  anthropic.yaml: |
    name: anthropic
    type: anthropic
    credential_source:
      type: vault
      path: kv/data/agents/anthropic-key
  anthropic-dev.yaml: |
    name: anthropic-dev
    type: anthropic
    credential_source:
      type: k8s_secret
      k8s_secret_ref: anthropic-key
```

### Provider Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique provider name within the namespace. This is the name agents use to reference the provider. |
| `type` | string | yes | OpenShell provider type (e.g., `github`, `anthropic`, `claude`, `jira`, `google-vertex-ai`, `generic`). Maps to the OpenShell `Provider.type` field. |
| `credential_source` | CredentialSource | yes | Where the credentials for this provider come from. |

**CredentialSource object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | Source type: `vault` (production) or `k8s_secret` (local development only). |
| `path` | string | conditional | Vault secret path (e.g., `kv/data/agents/github-pat`). Required when `type=vault`. |
| `k8s_secret_ref` | string | conditional | Kubernetes Secret name within the tenant namespace (e.g., `anthropic-key`). Required when `type=k8s_secret`. |

> **Transitional mechanism.** The credential source model exists to bridge the gap until OpenShell supports native credential management ([NVIDIA/OpenShell#1882](https://github.com/NVIDIA/OpenShell/issues/1882)). The `k8s_secret` type is strictly for local development workflows where Vault is unavailable. When OpenShell natively handles credential resolution, credential sources MAY be deprecated in favor of OpenShell-native configuration.

> **Scope restrictions.** For `k8s_secret` type: references are scoped to the tenant namespace — only secrets within the same namespace as the provider ConfigMap can be referenced. For `vault` type: vault paths are scoped by the control plane's Vault policy — the control plane authenticates to Vault with a service identity whose policy governs which paths are readable.

### Sandbox Creation Flow

When a sandbox session starts for an agent:

1. The control plane reads the agent's `providers` list (array of names)
2. For each provider name, the control plane looks up the provider declaration in the namespace
3. The control plane reads the credential from the declared source (Vault or k8s Secret)
4. If the provider already exists on the gateway → refresh the provider credential
5. If the provider does not exist on the gateway → create the provider with the resolved credential
6. The control plane calls `CreateSandbox` with all resolved provider names attached

---

## Policy Declarations

Policies are namespace-scoped resources declared in their own ConfigMaps, separate from agent declarations. A policy defines network, filesystem, process, and Landlock constraints for sandboxes. Multiple agents in the same namespace can reference the same policy.

### Discovery

The control plane SHALL discover policy declarations by watching ConfigMaps with the label `ambient.ai/kind: policy` in tenant namespaces.

### Structure

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: policy-declarations
  namespace: project-{project_name}
  labels:
    ambient.ai/kind: policy
data:
  restricted.yaml: |
    name: restricted
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
  permissive.yaml: |
    name: permissive
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

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique policy name within the namespace. This is the name agents use to reference the policy. |
| `version` | integer | no | Policy schema version. Managed by the control plane (not user-set). |
| `network_policies` | map[string]NetworkPolicyRule | no | Named network access rules. Keys are descriptive names (e.g., `github_api`, `inference`). |
| `filesystem` | FilesystemPolicy | no | Filesystem access constraints. |
| `process` | ProcessPolicy | no | Process identity constraints. |
| `landlock` | LandlockPolicy | no | Landlock LSM configuration. |

**NetworkPolicyRule object** (maps to OpenShell `NetworkPolicyRule` proto):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | no | Display name for audit logs. If omitted, the map key is used. |
| `endpoints` | array of NetworkEndpoint | no | Network endpoints this rule governs. |
| `binaries` | array of NetworkBinary | no | Binaries allowed to use this rule. |

**NetworkEndpoint object** (maps to OpenShell `NetworkEndpoint` proto):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | yes | Hostname or glob pattern (e.g., `api.github.com`, `*.example.com`). |
| `port` | integer | no | Single port number. |
| `ports` | array of integer | no | Multiple port numbers. Takes precedence over `port`. |
| `protocol` | string | no | L7 protocol: `rest`, `websocket`, `graphql`, `sql`, or empty for L4-only. |
| `tls` | string | no | TLS handling: `terminate` or `passthrough`. Default: `passthrough`. |
| `enforcement` | string | no | `enforce` or `audit`. Default: `enforce`. |
| `access` | string | no | Shorthand: `read-only`, `read-write`, `full`. Mutually exclusive with `rules`. |
| `rules` | array of L7Rule | no | Explicit allow rules. Mutually exclusive with `access`. |
| `deny_rules` | array of L7DenyRule | no | Explicit deny rules. Take precedence over allow rules. |
| `allowed_ips` | array of string | no | IP/CIDR allowlist. |
| `path` | string | no | HTTP path glob for scoping on shared host:port. |
| `allow_encoded_slash` | boolean | no | Preserve `%2F` in path segments (needed for GitLab-style URLs). |
| `websocket_credential_rewrite` | boolean | no | Rewrite credentials in WebSocket messages. |
| `request_body_credential_rewrite` | boolean | no | Rewrite credentials in HTTP request bodies. |

**L7Rule object** (wraps an `allow` sub-object matching OpenShell `L7Allow` proto):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `allow.method` | string | no | HTTP method or `*`. |
| `allow.path` | string | no | URL path glob pattern. |
| `allow.command` | string | no | SQL command or `*`. |
| `allow.query` | map[string]QueryMatcher | no | Query parameter matchers. |
| `allow.operation_type` | string | no | GraphQL operation type or `*`. |
| `allow.operation_name` | string | no | GraphQL operation name glob. |
| `allow.fields` | array of string | no | GraphQL root field globs. |

**L7DenyRule object:** Top-level fields (not nested under `deny`). Same fields as `L7Rule.allow`: `method`, `path`, `command`, `query`, `operation_type`, `operation_name`, `fields`.

**NetworkBinary object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | yes | Absolute path to the binary (e.g., `/usr/bin/git`). |

**FilesystemPolicy object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `include_workdir` | boolean | no | Whether to include the working directory in the filesystem scope. |
| `read_only` | array of string | no | Paths the sandbox can read but not write. |
| `read_write` | array of string | no | Paths the sandbox can read and write. |

**ProcessPolicy object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `run_as_user` | string | no | User identity for the sandbox process. |
| `run_as_group` | string | no | Group identity for the sandbox process. |

**LandlockPolicy object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `compatibility` | string | no | `best_effort` (degrade gracefully if kernel lacks support) or `hard_requirement` (fail if unsupported). |

### Policy Resolution at Sandbox Creation

When building the `CreateSandbox` request:

1. The control plane reads the agent's `sandbox_policy` field (a policy name)
2. The control plane looks up the policy declaration in the tenant namespace
3. The control plane merges the declared policy with the platform's minimum policy (platform constraints always win — see Requirement: Sandbox Policy Minimum Enforcement)
4. The merged policy is passed to OpenShell's `CreateSandbox` RPC

---

## Requirements

### Requirement: Agent Declaration via ConfigMap

Agent definitions SHALL be expressed as YAML documents within ConfigMaps in tenant namespaces. The control plane SHALL watch for ConfigMap changes and reconcile agent state.

#### Scenario: Single agent in a ConfigMap

- GIVEN a ConfigMap with label `ambient.ai/kind: agent` exists in tenant namespace `project-alpha`
- AND the ConfigMap's `data` contains a key `security-reviewer.yaml` with a valid agent YAML document
- WHEN the control plane reconciles the namespace
- THEN an agent named `security-reviewer` SHALL be created in project `alpha`
- AND the agent's sandbox configuration SHALL reflect the YAML document

#### Scenario: Multiple agents in a single ConfigMap

- GIVEN a ConfigMap with label `ambient.ai/kind: agent` exists in tenant namespace `project-alpha`
- AND the ConfigMap's `data` contains keys `reviewer.yaml` and `builder.yaml`
- WHEN the control plane reconciles the namespace
- THEN agents `reviewer` and `builder` SHALL both be created in project `alpha`

#### Scenario: ConfigMap update triggers reconciliation

- GIVEN an agent `reviewer` was created from a ConfigMap
- WHEN the ConfigMap's `reviewer.yaml` data key is updated with a new `entrypoint` value
- THEN the control plane SHALL update the agent's configuration to match
- AND no running session SHALL be affected (changes apply to the next session start)

#### Scenario: ConfigMap deletion removes agent

- GIVEN an agent `reviewer` was created from a ConfigMap
- WHEN the ConfigMap is deleted
- THEN the agent SHALL be removed from the project
- AND any running session for that agent SHALL NOT be terminated (it completes normally)

#### Scenario: Invalid YAML rejected

- GIVEN a ConfigMap contains a data key with invalid agent YAML (e.g., missing `name`)
- WHEN the control plane attempts to reconcile
- THEN the invalid entry SHALL be rejected with a clear error in the control plane logs
- AND valid entries in the same ConfigMap SHALL still be reconciled

---

### Requirement: Entrypoint Declaration

The agent YAML SHALL declare which binary runs inside the sandbox. The entrypoint defaults to `claude` when not specified.

#### Scenario: Custom entrypoint

- GIVEN an agent declaration with `entrypoint: opencode`
- WHEN a session starts for this agent
- THEN the sandbox SHALL launch `opencode` as its primary process

#### Scenario: Default entrypoint

- GIVEN an agent declaration with no `entrypoint` field
- WHEN a session starts for this agent
- THEN the sandbox SHALL launch `claude` as its primary process

#### Scenario: Invalid entrypoint

- GIVEN an agent declaration with `entrypoint: /nonexistent/binary`
- WHEN a session starts for this agent
- THEN the sandbox SHALL fail to start
- AND the session SHALL transition to `Failed` with a clear error message

---

### Requirement: Provider Reference Resolution

The agent YAML SHALL declare which providers the agent requires as an array of provider name strings. The control plane SHALL resolve each name to a provider declaration in the tenant namespace and execute the sandbox creation flow (see Provider Declarations § Sandbox Creation Flow) before creating the sandbox.

#### Scenario: Provider declaration exists in namespace

- GIVEN an agent declares `providers: [github]`
- AND a provider declaration named `github` exists in the tenant namespace (ConfigMap labeled `ambient.ai/kind: provider`)
- WHEN a session starts for this agent
- THEN the control plane SHALL read the `github` provider's credential source
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
- THEN the control plane SHALL read the current credential from the provider declaration's credential source
- AND refresh the provider's credential on the gateway (not create a duplicate)

#### Scenario: Multiple providers

- GIVEN an agent declares `providers: [github, anthropic]`
- AND both `github` and `anthropic` provider declarations exist in the tenant namespace
- WHEN a session starts
- THEN both providers SHALL be resolved and registered on the gateway
- AND failure to resolve one provider SHALL fail the session start (all declared providers are required)

#### Scenario: Provider shared across agents

- GIVEN provider declaration `github` exists in namespace `project-alpha`
- AND agents `reviewer` and `builder` both declare `providers: [github]`
- WHEN sessions start for both agents
- THEN both sessions SHALL use the same `github` provider on the gateway
- AND each session SHALL trigger a credential refresh for the shared provider

---

### Requirement: Payload Injection

The agent YAML SHALL declare payloads (file references or inline content) to upload into the sandbox before the entrypoint launches.

#### Scenario: Inline content payload

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

#### Scenario: Missing sandbox_path (validation error)

- GIVEN an agent declares a payload without `sandbox_path`
- WHEN the control plane validates the agent YAML
- THEN the declaration SHALL be rejected

---

### Requirement: Sandbox Policy Application

The agent YAML SHALL reference a sandbox policy by name. The control plane SHALL resolve the named policy from the tenant namespace and pass it to OpenShell's `CreateSandbox` RPC, merged with platform minimum constraints.

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

- GIVEN policy declaration `restricted` exists in namespace `project-alpha`
- AND agents `reviewer` and `builder` both declare `sandbox_policy: restricted`
- WHEN sessions start for both agents
- THEN both sessions SHALL use the same resolved policy constraints

#### Scenario: Deny rules take precedence

- GIVEN a policy declaration with a network policy containing an allow rule for `*.github.com:443` and a deny rule for `raw.githubusercontent.com:443`
- WHEN an agent referencing this policy attempts to connect to `raw.githubusercontent.com:443`
- THEN the connection SHALL be blocked (deny rule takes precedence)

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

### Requirement: Sandbox Policy Minimum Enforcement

The platform SHALL enforce minimum sandbox policy constraints regardless of what a policy declaration specifies. Policy declarations are additive on top of platform minimums — they cannot weaken them.

**Enforcement mechanism:** The control plane SHALL maintain a platform-level default sandbox policy (loaded from configuration or a ConfigMap in the control plane namespace). When building the `CreateSandbox` request, the control plane merges the resolved policy declaration with the platform default. For fields where the declared value is less restrictive than the platform default, the platform value wins. For network policies, the declared endpoints are intersected with the platform's allowed set — policies cannot grant access to endpoints the platform does not permit.

#### Scenario: Policy cannot disable network isolation

- GIVEN a policy declaration contains a wildcard network rule allowing all hosts on all ports
- AND an agent references this policy
- WHEN the control plane applies the policy
- THEN the platform's minimum network restrictions SHALL still be enforced
- AND the agent SHALL NOT have unrestricted internet access

#### Scenario: Policy cannot escalate process privileges

- GIVEN a policy declaration contains `process.run_as_user: root`
- AND an agent references this policy
- WHEN the control plane applies the policy
- THEN the control plane SHALL reject the declaration or override to the platform default
- AND the sandbox SHALL NOT run as root

---

### Requirement: ConfigMap Authorization

Access control for agent declarations relies on Kubernetes RBAC for the tenant namespace. Only principals with write access to ConfigMaps in a tenant namespace can create or modify agent declarations.

#### Scenario: Authorized user creates agent declaration

- GIVEN user A has RBAC permission to create/update ConfigMaps in namespace `project-alpha`
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

- GIVEN `OPENSHELL_ENABLED=true` AND `OPENSHELL_GATEWAY_ENABLED=true` in the control plane configuration
- WHEN the control plane starts
- THEN the control plane SHALL watch for agent declaration ConfigMaps in tenant namespaces
- AND provision sandboxes via the OpenShell Gateway for sessions using ConfigMap-declared agents

#### Scenario: Gateway mode disabled (default)

- GIVEN `OPENSHELL_ENABLED=false` OR `OPENSHELL_GATEWAY_ENABLED=false` (or unset) in the control plane configuration
- WHEN the control plane starts
- THEN the control plane SHALL NOT watch for agent declaration ConfigMaps
- AND the existing runner-based session provisioning SHALL remain the active path

#### Scenario: Mixed mode

- GIVEN `OPENSHELL_ENABLED=true` AND `OPENSHELL_GATEWAY_ENABLED=true`
- AND agents created via the existing REST API still exist in the database
- WHEN a session starts for a REST API-created agent
- THEN the control plane SHALL use the existing runner-based provisioning path for that agent
- AND ConfigMap-declared agents SHALL use the gateway path

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
  namespace: project-{project_name}
  labels:
    ambient.ai/kind: agent
data:
  security-reviewer.yaml: |
    name: security-reviewer
    description: Reviews PRs for security vulnerabilities
    entrypoint: claude
    prompt: |
      You are a security review agent.
    providers:
      - github
      - anthropic
    # ... (full agent YAML)
  builder.yaml: |
    name: builder
    # ... (another agent YAML)
```

### Conventions

- Each data key is a YAML filename: `{agent-name}.yaml`
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
| `gateway` | `gateway` | TEXT | Nullable |

Legacy fields (`resource_overrides`, `environment_variables` as TEXT) remain in the table for backward compatibility during migration but are not populated by ConfigMap-sourced agents.

---

## Migration

### Existing consumers

| Consumer | Current behavior | Required change |
|----------|-----------------|-----------------|
| Control plane reconciler | Watches API server for sessions, provisions K8s Jobs with runner containers | Watch ConfigMaps for agent declarations; provision OpenShell sandboxes via Gateway gRPC instead of K8s Jobs |
| API server (agents plugin) | Full CRUD for Agent resource via REST API | May become read-only consumer of ConfigMap-sourced agents; retain for status/query; add JSONB columns for new fields |
| CLI (`acpctl apply`) | Submits agent YAML to API server | May write ConfigMaps directly to tenant namespaces or continue via API |
| Runner (Python) | Executes Claude Code CLI in K8s Job pod | Bypassed when `OPENSHELL_ENABLED` and `OPENSHELL_GATEWAY_ENABLED` are true — sessions for ConfigMap-declared agents use OpenShell sandboxes instead. Runner remains active for REST API-created agents and when gateway mode is disabled. |
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

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| ConfigMap is the primary agent definition format | Agents will be declared via ArgoCD-managed ConfigMaps in tenant namespaces. REST API-based agent creation is a potential follow-up offering an RBAC-scoped developer path for creating agents without GitOps, but not the primary onboarding flow. This aligns with GitOps workflows and the existing Application (GitOps sync) model in `data-model.spec.md`. |
| Providers are namespace-scoped shared resources | Providers are declared in their own ConfigMaps (labeled `ambient.ai/kind: provider`) at the tenant namespace level, not inline within agent declarations. Agents reference providers by name. This enables sharing providers across multiple agents in a namespace (e.g., a single `github` provider used by both `reviewer` and `builder` agents). The control plane handles create-or-refresh at sandbox creation time. |
| Credential sources are attached to provider declarations | Each provider declaration includes a `credential_source` specifying where credentials come from (Vault in production, k8s Secret for local dev). This is a transitional mechanism — designed to be forward-compatible with OpenShell's planned native credential management ([NVIDIA/OpenShell#1882](https://github.com/NVIDIA/OpenShell/issues/1882)). Credential sources bypass the existing platform Credential/RoleBinding hierarchy. |
| Policies are namespace-scoped shared resources | Policies are declared in their own ConfigMaps (labeled `ambient.ai/kind: policy`) at the tenant namespace level, not inline within agent declarations. Agents reference a single policy by name. This enables sharing policies across multiple agents and keeps policy definitions DRY. Policy merging/composition is deferred to the inheritance spec. |
| Single policy reference, not array | Agents reference one policy by name. Composing multiple policies (base network + agent-specific overlay) is deferred to the inheritance draft spec where merge semantics are already defined. This avoids merge-order ambiguity at the agent level. |
| Mixed field grouping | Flat fields for `entrypoint`, `providers`, `payloads`, `sandbox_policy`, `environment`, `gateway` (frequently accessed, simple types or name references). Nested JSONB for `sandbox_template` (complex structure that maps directly to OpenShell proto messages). |
| Base agent inheritance deferred to draft spec | See `specs/platform/agent-inheritance.spec.md`. Covers project-scoped and platform-scoped inheritance with merge semantics, including policy composition. Kept as a separate draft spec to allow independent scoping — agents without `base_agent` are fully self-contained. |
| Field names align with OpenShell proto naming | Policy declaration fields (`network_policies`, `filesystem`, `process`, `landlock`) and `sandbox_template.resources` mirror the OpenShell proto field names to minimize cognitive overhead when mapping between declarations and OpenShell API calls. |
| Unknown fields accepted with warning | Forward compatibility — newer agent YAML schemas can be applied to older control planes without hard failures. |
| ConfigMap is the source of truth; PostgreSQL is a projection | ConfigMap-declared agents are the authoritative source. The API server's `agents` table is a read-optimized projection for queries and status reporting. The control plane reconciles ConfigMap → database, not the reverse. API PATCH operations on ConfigMap-sourced agents are not supported — changes flow through the ConfigMap (git → ArgoCD → ConfigMap → control plane). |
| ConfigMap authorization delegates to Kubernetes RBAC | Who can create/modify agent declarations is governed by Kubernetes RBAC on the tenant namespace. The control plane trusts that any ConfigMap with the correct label in the correct namespace was applied by an authorized principal. |
| Sandbox policy minimums are platform-enforced | Agent-declared sandbox policies cannot weaken platform-level security minimums. The control plane merges agent policies with platform defaults, and platform constraints always win. |
| Feature flag gating | All ConfigMap-based agent declaration and OpenShell Gateway provisioning is gated behind `OPENSHELL_ENABLED=true` and `OPENSHELL_GATEWAY_ENABLED=true`. When disabled, the existing runner-based lifecycle is unchanged. This allows incremental rollout and rollback. |

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

gateway: default

labels:
  team: platform-security
  tier: review

annotations:
  owner: foo.bar@example.com
```

---
