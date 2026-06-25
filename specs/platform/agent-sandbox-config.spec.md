# Agent Sandbox Configuration

**Date:** 2026-06-25
**Status:** Draft
**Related:** `specs/platform/data-model.spec.md` (Agent entity), `specs/security/openshell-sandbox.spec.md` (file-mode sandbox isolation), `specs/security/credential-binding.spec.md` (credential resolution), `specs/platform/control-plane.spec.md` (session provisioning), `specs/platform/runner.spec.md` (runner lifecycle — being replaced)

---

## Purpose

Agent definitions SHALL be expressed as declarative YAML documents in ConfigMaps, applied by ArgoCD into tenant namespaces and reconciled by the ACP control plane. The YAML schema SHALL support the full range of OpenShell sandbox configuration: what binary runs inside the sandbox, what credentials it has access to, what network and filesystem policies constrain it, what content is pre-loaded, and what compute resources are allocated.

This spec extends the Agent concept from `data-model.spec.md` with sandbox-aware configuration fields aligned to NVIDIA OpenShell's `SandboxSpec`, `SandboxPolicy`, and `Provider` protobuf definitions. It supersedes the custom Python Runner model — agents are no longer executed via Kubernetes Jobs with a runner container but via OpenShell Gateway-managed sandboxes.

---

## Terminology

- **Agent Declaration** — a YAML document within a ConfigMap that defines an agent's identity, behavior, and sandbox configuration. The primary mechanism for creating and updating agents.
- **Provider** — an OpenShell Gateway-registered credential provider (e.g., `github`, `anthropic`, `jira`). The gateway's egress proxy resolves credential placeholders at the network boundary — credentials never enter the sandbox. Not to be confused with the `provider` field on the platform's `Credential` entity, which classifies the stored token type.
- **Payload** — content (file reference or inline text) uploaded into the sandbox filesystem at a declared path. Used for CLAUDE.md, settings, MCP configs, task files.
- **Entrypoint** — the CLI binary launched inside the sandbox (e.g., `claude`, `opencode`, `bash`).
- **Sandbox Policy** — an OpenShell `SandboxPolicy` governing network endpoints, filesystem paths, process identity, and Landlock constraints within the sandbox.
- **Credential Source** — a reference to an external secret store (Vault path or Kubernetes Secret) from which the control plane resolves credentials and creates OpenShell providers. This is a transitional mechanism — see [NVIDIA/OpenShell#1882](https://github.com/NVIDIA/OpenShell/issues/1882).
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
| `providers` | array of Provider | no | Provider profile references. Each entry declares a provider the agent requires on the OpenShell Gateway. |

**Provider object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Provider type identifier (e.g., `github`, `anthropic`, `jira`, `google-vertex-ai`). Maps to the OpenShell `Provider.type` field and to entries in `SandboxSpec.providers` (repeated string). |
| `env` | map[string]string | no | Per-provider environment variable overrides. Empty values are resolved from the host environment at deploy time. Platform-specific extension — not part of the OpenShell proto. |

> **Platform abstraction.** The `providers` array is a platform-level enrichment of OpenShell's `SandboxSpec.providers` (which is a flat `repeated string`). The `name` field maps to the string entries; the `env` field is handled by the control plane outside the OpenShell API. When a `credential_sources` entry and a `providers` entry reference the same provider type, the credential source creates the provider registration on the gateway and the provider entry supplies per-provider `env` overrides.

### Payloads

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `payloads` | array of Payload | no | Content to upload into the sandbox filesystem before the entrypoint launches. |

**Payload object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sandbox_path` | string | yes | Absolute path inside the sandbox where the content is mounted. |
| `local_path` | string | conditional | Path to a file on the host/source system. Mutually exclusive with `content`. |
| `content` | string | conditional | Inline string content. Mutually exclusive with `local_path`. |

Exactly one of `local_path` or `content` MUST be set per payload entry.

> **Path constraints.** `sandbox_path` MUST be an absolute path within the sandbox root (`/sandbox/`). The control plane SHALL reject paths containing `..` traversal segments or paths outside `/sandbox/`. `local_path` MUST be a relative path within the agent's source repository or payload directory — absolute paths and `..` traversal are rejected.

### Credential Sources

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `credential_sources` | array of CredentialSource | no | External secret references from which the control plane creates OpenShell providers. |

**CredentialSource object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | Source type: `vault` (production) or `k8s_secret` (local development only). |
| `path` | string | conditional | Vault secret path (e.g., `kv/data/agents/github-pat`). Required when `type=vault`. |
| `k8s_secret_ref` | string | conditional | Kubernetes Secret reference in `namespace/secret-name` format. Required when `type=k8s_secret`. |
| `provider_type` | string | yes | The OpenShell provider type to create from the resolved secret (e.g., `github`, `anthropic`, `claude`). |

> **Transitional mechanism.** The `credential_sources` field exists to bridge the gap until OpenShell supports native credential management ([NVIDIA/OpenShell#1882](https://github.com/NVIDIA/OpenShell/issues/1882)). The `k8s_secret` type is strictly for local development workflows where Vault is unavailable. When OpenShell natively handles credential resolution, `credential_sources` MAY be deprecated in favor of OpenShell-native configuration.

> **Scope restrictions.** For `k8s_secret` type: the control plane SHALL restrict access to secrets within the agent's own tenant namespace. Cross-namespace secret references (referencing a namespace other than the agent's tenant namespace) SHALL be rejected. For `vault` type: vault paths are scoped by the control plane's Vault policy — the control plane authenticates to Vault with a service identity whose policy governs which paths are readable. Agents cannot access vault paths outside the control plane's authorized scope.

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
| `sandbox_policy` | SandboxPolicy | no | Network, filesystem, and process constraints for the sandbox. When omitted, the platform's default policy applies. |

**SandboxPolicy object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | integer | no | Policy schema version. Managed by the control plane (not user-set). |
| `network_policies` | map[string]NetworkPolicyRule | no | Named network access rules. Keys are policy names (e.g., `github_api`, `inference`). |
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

### Gateway

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `gateway` | string | no | OpenShell Gateway name to target. For multi-gateway deployments. Defaults to the gateway discovered via Kubernetes Service DNS in the tenant namespace. |

### Inheritance

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `base_agent` | string | no | Reference to a base agent whose configuration this agent inherits from. Two scopes are supported: project-scoped (`agent-name`) resolves within the same project, platform-scoped (`platform/agent-name`) resolves from the platform-level base agent ConfigMap. |

> **Scope candidate.** Base agent inheritance is a requirement for fleet management (e.g., a global base providing `google-vertex-ai` and shared sandbox defaults). If implementation scope must be trimmed, this feature can be deferred without breaking the rest of the spec — agents without `base_agent` are fully self-contained.

**Merge semantics:**

| Field category | Merge behavior | Example |
|----------------|---------------|---------|
| Scalar fields | Child wins when set; base value used when child omits the field | `entrypoint`, `gateway`, `sandbox_template.image`, `prompt` |
| Array fields | Child entries appended after base entries; duplicates (by `name` or `sandbox_path`) are deduplicated with child winning | `providers`, `payloads`, `credential_sources` |
| Map fields | Merged key-by-key; child values take precedence on key collision | `environment`, `labels`, `annotations` |
| Nested objects | Merged field-by-field (same scalar/array/map rules apply recursively) | `sandbox_template`, `sandbox_policy` |

**Platform base agents** are declared in a ConfigMap labeled `ambient.ai/kind: base-agent` in the control plane namespace (not a tenant namespace). They are referenced via the `platform/` prefix:

```yaml
# Platform-level base agent ConfigMap (in control plane namespace)
apiVersion: v1
kind: ConfigMap
metadata:
  name: platform-base-agents
  namespace: ambient-code
  labels:
    ambient.ai/kind: base-agent
data:
  default.yaml: |
    name: default
    providers:
      - name: google-vertex-ai
      - name: anthropic
    sandbox_template:
      resources:
        cpu: "2"
        memory: 4Gi
    sandbox_policy:
      process:
        run_as_user: sandbox
        run_as_group: sandbox
      landlock:
        compatibility: best_effort
```

```yaml
# Project agent inheriting from platform base
name: security-reviewer
base_agent: platform/default
entrypoint: claude
providers:
  - name: github
# Inherits google-vertex-ai and anthropic from platform/default
# Inherits sandbox_template.resources, sandbox_policy.process, etc.
```

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

The agent YAML SHALL declare which providers the agent requires. The control plane SHALL register declared providers on the OpenShell Gateway before creating the sandbox.

#### Scenario: Provider registered on gateway

- GIVEN an agent declares `providers: [{name: github}]`
- AND a `github` provider is registered on the target gateway
- WHEN a session starts for this agent
- THEN the sandbox SHALL have access to the `github` provider's credentials via the gateway egress proxy

#### Scenario: Provider with per-provider env overrides

- GIVEN an agent declares:
  ```yaml
  providers:
    - name: github
      env:
        GITHUB_TOKEN:
  ```
- WHEN a session starts for this agent
- THEN the `GITHUB_TOKEN` environment variable SHALL be resolved from the host environment
- AND injected into the sandbox alongside the provider registration

#### Scenario: Provider not resolvable

- GIVEN an agent declares `providers: [{name: nonexistent-provider}]`
- AND no provider named `nonexistent-provider` is registered on the gateway
- WHEN a session starts for this agent
- THEN the session start SHALL fail
- AND the error SHALL identify the unresolvable provider by name

#### Scenario: Multiple providers

- GIVEN an agent declares providers `github` and `anthropic`
- WHEN a session starts
- THEN both providers SHALL be registered on the gateway for this sandbox

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

#### Scenario: File reference payload

- GIVEN an agent declares:
  ```yaml
  payloads:
    - sandbox_path: /sandbox/.claude/settings.json
      local_path: profiles/security-reviewer/settings.json
  ```
- WHEN a session starts
- THEN the content of `profiles/security-reviewer/settings.json` SHALL be uploaded to `/sandbox/.claude/settings.json` in the sandbox

#### Scenario: Both local_path and content set (validation error)

- GIVEN an agent declares a payload with both `local_path` and `content` set
- WHEN the control plane validates the agent YAML
- THEN the declaration SHALL be rejected
- AND the error SHALL indicate that `local_path` and `content` are mutually exclusive

#### Scenario: Missing sandbox_path (validation error)

- GIVEN an agent declares a payload without `sandbox_path`
- WHEN the control plane validates the agent YAML
- THEN the declaration SHALL be rejected

---

### Requirement: Credential Source Resolution

The agent YAML SHALL declare credential sources that the control plane resolves into OpenShell providers. Credential sources bypass the existing platform Credential/RoleBinding hierarchy — they create OpenShell providers directly on the gateway.

#### Scenario: Vault credential source

- GIVEN an agent declares:
  ```yaml
  credential_sources:
    - type: vault
      path: kv/data/agents/github-pat
      provider_type: github
  ```
- WHEN a session starts
- THEN the control plane SHALL read the secret from Vault at `kv/data/agents/github-pat`
- AND create an OpenShell provider of type `github` on the gateway with the resolved credentials

#### Scenario: Kubernetes Secret credential source (local dev)

- GIVEN an agent declares:
  ```yaml
  credential_sources:
    - type: k8s_secret
      k8s_secret_ref: dev-namespace/anthropic-key
      provider_type: anthropic
  ```
- WHEN a session starts
- THEN the control plane SHALL read the Kubernetes Secret `anthropic-key` in namespace `dev-namespace`
- AND create an OpenShell provider of type `anthropic` on the gateway

#### Scenario: Vault path not found

- GIVEN an agent declares a vault credential source with path `kv/data/nonexistent`
- WHEN a session starts
- THEN the session start SHALL fail
- AND the error SHALL identify the unresolvable vault path

#### Scenario: Kubernetes Secret not found

- GIVEN an agent declares a k8s_secret credential source referencing a non-existent secret
- WHEN a session starts
- THEN the session start SHALL fail
- AND the error SHALL identify the missing secret reference

#### Scenario: Multiple credential sources

- GIVEN an agent declares credential sources for `github` (vault) and `anthropic` (k8s_secret)
- WHEN a session starts
- THEN both providers SHALL be created on the gateway independently
- AND failure to resolve one credential source SHALL NOT prevent resolution of others

---

### Requirement: Sandbox Policy Application

The agent YAML SHALL declare sandbox policies governing network access, filesystem constraints, and process identity. The control plane SHALL pass the policy to OpenShell's `CreateSandbox` RPC.

#### Scenario: Inline network policy

- GIVEN an agent declares:
  ```yaml
  sandbox_policy:
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
  ```
- WHEN a session starts
- THEN the sandbox SHALL allow network access to `api.github.com:443` for the `git` binary
- AND all other network endpoints SHALL be blocked

#### Scenario: Filesystem policy

- GIVEN an agent declares:
  ```yaml
  sandbox_policy:
    filesystem:
      read_write:
        - /sandbox
        - /tmp
      read_only:
        - /usr
        - /etc
  ```
- WHEN the sandbox starts
- THEN the agent process SHALL be able to write to `/sandbox` and `/tmp`
- AND the agent process SHALL be able to read but not write to `/usr` and `/etc`

#### Scenario: Process policy

- GIVEN an agent declares:
  ```yaml
  sandbox_policy:
    process:
      run_as_user: sandbox
      run_as_group: sandbox
  ```
- WHEN the sandbox starts
- THEN the entrypoint process SHALL run as user `sandbox` and group `sandbox`

#### Scenario: No sandbox policy (default applied)

- GIVEN an agent declaration with no `sandbox_policy` field
- WHEN a session starts
- THEN the platform's default sandbox policy SHALL be applied
- AND the default policy SHALL restrict network access to the minimum required for the declared providers

#### Scenario: Deny rules take precedence

- GIVEN a network policy with an allow rule for `*.github.com:443` and a deny rule for `raw.githubusercontent.com:443`
- WHEN the agent attempts to connect to `raw.githubusercontent.com:443`
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

### Requirement: Base Agent Inheritance

The agent YAML SHALL support a `base_agent` field for configuration inheritance. Two scopes are supported:

- **Project-scoped**: `base_agent: agent-name` — resolves to a named agent within the same project (same tenant namespace).
- **Platform-scoped**: `base_agent: platform/agent-name` — resolves to a named base agent declared in the control plane namespace via a ConfigMap labeled `ambient.ai/kind: base-agent`.

Platform-scoped base agents enable fleet-wide defaults (e.g., a `default` base providing `google-vertex-ai` and `anthropic` providers to all agents across projects).

> **Scope candidate.** This requirement MAY be descoped to a follow-up if implementation bandwidth requires trimming. Agents without `base_agent` are fully self-contained and unaffected.

**Merge rules:**

| Category | Behavior |
|----------|----------|
| Scalar fields | Child wins when set; base value used when child omits the field |
| Array fields | Child entries appended after base entries; duplicates (by `name` or `sandbox_path`) are deduplicated with child winning |
| Map fields | Merged key-by-key; child values take precedence on key collision |
| Nested objects | Merged field-by-field recursively using the same scalar/array/map rules |

#### Scenario: Scalar field override

- GIVEN a platform base agent `default` declares `entrypoint: claude` and `gateway: primary`
- AND a child agent declares `base_agent: platform/default` and `gateway: secondary`
- WHEN the control plane resolves the effective configuration
- THEN the effective `entrypoint` SHALL be `claude` (inherited from base)
- AND the effective `gateway` SHALL be `secondary` (overridden by child)

#### Scenario: Array concatenation with deduplication

- GIVEN a platform base agent `default` declares:
  ```yaml
  providers:
    - name: google-vertex-ai
    - name: anthropic
  ```
- AND a child agent declares:
  ```yaml
  base_agent: platform/default
  providers:
    - name: github
    - name: anthropic
      env:
        ANTHROPIC_MODEL: claude-sonnet-4-20250514
  ```
- WHEN the control plane resolves the effective configuration
- THEN the effective `providers` SHALL be `[google-vertex-ai, github, anthropic]`
- AND the `anthropic` provider SHALL use the child's `env` overrides (child wins on duplicate by `name`)

#### Scenario: Map merging

- GIVEN a base agent declares:
  ```yaml
  environment:
    LOG_LEVEL: info
    TIMEOUT: "30"
  ```
- AND a child agent declares:
  ```yaml
  base_agent: shared-config
  environment:
    LOG_LEVEL: debug
    NEW_VAR: value
  ```
- WHEN the control plane resolves the effective configuration
- THEN the effective `environment` SHALL be `{LOG_LEVEL: debug, TIMEOUT: "30", NEW_VAR: value}`

#### Scenario: Nested object merging

- GIVEN a platform base agent declares:
  ```yaml
  sandbox_template:
    image: ghcr.io/nvidia/openshell:sandbox-v0.2.0
    resources:
      cpu: "2"
      memory: 4Gi
  ```
- AND a child agent declares:
  ```yaml
  base_agent: platform/default
  sandbox_template:
    resources:
      memory: 8Gi
  ```
- WHEN the control plane resolves the effective configuration
- THEN the effective `sandbox_template.image` SHALL be `ghcr.io/nvidia/openshell:sandbox-v0.2.0` (inherited)
- AND the effective `sandbox_template.resources.cpu` SHALL be `"2"` (inherited)
- AND the effective `sandbox_template.resources.memory` SHALL be `8Gi` (overridden)

#### Scenario: Platform base agent for shared providers

- GIVEN a platform base agent `default` is declared in the `ambient-code` namespace:
  ```yaml
  name: default
  providers:
    - name: google-vertex-ai
    - name: anthropic
  sandbox_policy:
    process:
      run_as_user: sandbox
      run_as_group: sandbox
    landlock:
      compatibility: best_effort
  ```
- AND multiple project agents across different namespaces reference `base_agent: platform/default`
- WHEN sessions start for any of these agents
- THEN each sandbox SHALL have `google-vertex-ai` and `anthropic` providers registered
- AND each sandbox SHALL inherit the shared process and landlock policies

#### Scenario: Circular inheritance detection

- GIVEN agent `alpha` declares `base_agent: beta`
- AND agent `beta` declares `base_agent: alpha`
- WHEN the control plane validates the agent declarations
- THEN both declarations SHALL be rejected with a circular inheritance error
- AND no sessions SHALL be created for either agent until the cycle is resolved

#### Scenario: Base agent not found

- GIVEN an agent declares `base_agent: platform/nonexistent`
- AND no base agent named `nonexistent` exists in the control plane namespace
- WHEN the control plane validates the agent declaration
- THEN the declaration SHALL be rejected with a clear error identifying the missing base agent
- AND no sessions SHALL be created for the agent

#### Scenario: Multi-level inheritance

- GIVEN a platform base agent `minimal` declares default sandbox policy
- AND a project agent `team-base` declares `base_agent: platform/minimal` and adds team-specific providers
- AND an agent `reviewer` declares `base_agent: team-base`
- WHEN the control plane resolves the effective configuration for `reviewer`
- THEN the merge SHALL apply at each level: `minimal` → `team-base` → `reviewer`
- AND scalar/array/map merge rules SHALL apply consistently at each level

#### Scenario: Multi-level inheritance depth limit

- GIVEN a chain of base agent references exceeds 5 levels deep
- WHEN the control plane validates the agent declaration
- THEN the declaration SHALL be rejected with a depth limit error
- AND the error SHALL identify the chain that exceeds the limit

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

The platform SHALL enforce minimum sandbox policy constraints regardless of what an agent declaration specifies. Agent-declared policies are additive on top of platform minimums — they cannot weaken them.

#### Scenario: Agent cannot disable network isolation

- GIVEN an agent declares a sandbox_policy with a wildcard network rule allowing all hosts on all ports
- WHEN the control plane applies the policy
- THEN the platform's minimum network restrictions SHALL still be enforced
- AND the agent SHALL NOT have unrestricted internet access

#### Scenario: Agent cannot escalate process privileges

- GIVEN an agent declares `sandbox_policy.process.run_as_user: root`
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

### Requirement: Credential Source Scope Isolation

Credential source references SHALL be scoped to prevent cross-tenant access.

#### Scenario: k8s_secret restricted to tenant namespace

- GIVEN an agent in project `alpha` (namespace `project-alpha`) declares a k8s_secret credential source referencing `project-beta/some-secret`
- WHEN the control plane validates the declaration
- THEN the declaration SHALL be rejected
- AND the error SHALL indicate that k8s_secret references must be within the agent's own tenant namespace

#### Scenario: k8s_secret within tenant namespace accepted

- GIVEN an agent in namespace `project-alpha` declares a k8s_secret credential source referencing `project-alpha/my-secret`
- WHEN the control plane validates
- THEN the reference SHALL be accepted

#### Scenario: Vault path scoped by control plane policy

- GIVEN the control plane authenticates to Vault with a service identity
- WHEN an agent declares a vault credential source with a path outside the control plane's Vault policy
- THEN Vault SHALL deny the read
- AND the session start SHALL fail with an error identifying the unauthorized vault path

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
      - name: github
      - name: anthropic
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

The control plane reads agent declarations from ConfigMaps as the source of truth. For API query and status reporting, the control plane MAY persist agent state in the API server's PostgreSQL database using the existing `agents` table.

When persisted, the new structured fields map to columns as follows:

| YAML Field | Column | Type | Notes |
|------------|--------|------|-------|
| `entrypoint` | `entrypoint` | TEXT | Nullable; default `claude` |
| `providers` | `providers` | JSONB | Array of provider objects |
| `payloads` | `payloads` | JSONB | Array of payload objects |
| `credential_sources` | `credential_sources` | JSONB | Array of credential source objects |
| `environment` | `environment` | JSONB | Map of string → string |
| `sandbox_template` | `sandbox_template` | JSONB | Nested object |
| `sandbox_policy` | `sandbox_policy` | JSONB | Nested object |
| `gateway` | `gateway` | TEXT | Nullable |
| `base_agent` | `base_agent` | TEXT | Nullable; `platform/name` or `name` |

Legacy fields (`resource_overrides`, `environment_variables` as TEXT) remain in the table for backward compatibility during migration but are not populated by ConfigMap-sourced agents.

---

## Migration

### Existing consumers

| Consumer | Current behavior | Required change |
|----------|-----------------|-----------------|
| Control plane reconciler | Watches API server for sessions, provisions K8s Jobs with runner containers | Watch ConfigMaps for agent declarations; provision OpenShell sandboxes via Gateway gRPC instead of K8s Jobs |
| API server (agents plugin) | Full CRUD for Agent resource via REST API | May become read-only consumer of ConfigMap-sourced agents; retain for status/query; add JSONB columns for new fields |
| CLI (`acpctl apply`) | Submits agent YAML to API server | May write ConfigMaps directly to tenant namespaces or continue via API |
| Runner (Python) | Executes Claude Code CLI in K8s Job pod | Removed — replaced by OpenShell sandbox |
| UI agent editor | Full CRUD via REST API | May become read-only view of ConfigMap-declared agents; editing requires ConfigMap update flow |
| Go/Python/TS SDKs | Generated from OpenAPI Agent schema | Regenerate if API schema changes to include new fields |
| ArgoCD | Not involved in agent lifecycle | Must be configured to sync agent declaration ConfigMaps into tenant namespaces (prerequisite) |

### Specs requiring amendment

| Spec | Amendment |
|------|-----------|
| `specs/platform/data-model.spec.md` | Update Agent entity fields; document ConfigMap as source of truth for agent declarations |
| `specs/platform/control-plane.spec.md` | Add ConfigMap watching; replace Job provisioning with OpenShell Gateway sandbox creation |
| `specs/platform/runner.spec.md` | Mark as superseded by OpenShell sandbox execution |
| `specs/security/openshell-sandbox.spec.md` | Extend from file-mode to gateway-mode; reference per-agent sandbox policies from this spec |

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| ConfigMap is the primary agent definition format | Agents will be declared via ArgoCD-managed ConfigMaps in tenant namespaces. REST API-based agent creation is a potential follow-up, not the primary path. This aligns with GitOps workflows and the existing Application (GitOps sync) model in `data-model.spec.md`. |
| Credential sources bypass the existing Credential/RoleBinding system | Vault credential paths create OpenShell providers directly on the gateway. The existing Credential/RoleBinding hierarchy (agent → project → global resolution) is designed for the platform's internal credential model. Credential sources are a separate, simpler pathway for declaring how sandbox credentials are sourced. |
| Credential sources are a transitional mechanism | The `k8s_secret` type is for local development only. The entire `credential_sources` field is designed to be forward-compatible with OpenShell's planned native credential management ([NVIDIA/OpenShell#1882](https://github.com/NVIDIA/OpenShell/issues/1882)). |
| Mixed field grouping | Flat fields for `entrypoint`, `providers`, `payloads`, `credential_sources`, `environment`, `gateway` (frequently accessed, simple types). Nested JSONB for `sandbox_template` and `sandbox_policy` (complex structures that map directly to OpenShell proto messages). |
| Base agent inheritance supports project and platform scope | Two resolution scopes: project-scoped (`agent-name`, same namespace) and platform-scoped (`platform/agent-name`, control plane namespace). Platform scope enables fleet-wide defaults such as shared providers (`google-vertex-ai`, `anthropic`) and security baselines. Merge semantics follow a scalar-override / array-concatenate / map-merge model applied recursively, with a depth limit of 5 levels. This requirement MAY be descoped to a follow-up if implementation bandwidth requires trimming — agents without `base_agent` are fully self-contained. |
| Field names align with OpenShell proto naming | `sandbox_policy.network_policies`, `sandbox_template.resources`, `sandbox_policy.filesystem` — these mirror the proto field names to minimize cognitive overhead when mapping between agent YAML and OpenShell API calls. |
| Unknown fields accepted with warning | Forward compatibility — newer agent YAML schemas can be applied to older control planes without hard failures. |
| ConfigMap is the source of truth; PostgreSQL is a projection | ConfigMap-declared agents are the authoritative source. The API server's `agents` table is a read-optimized projection for queries and status reporting. The control plane reconciles ConfigMap → database, not the reverse. API PATCH operations on ConfigMap-sourced agents are not supported — changes flow through the ConfigMap (git → ArgoCD → ConfigMap → control plane). |
| ConfigMap authorization delegates to Kubernetes RBAC | Who can create/modify agent declarations is governed by Kubernetes RBAC on the tenant namespace. The control plane trusts that any ConfigMap with the correct label in the correct namespace was applied by an authorized principal. |
| Sandbox policy minimums are platform-enforced | Agent-declared sandbox policies cannot weaken platform-level security minimums. The control plane merges agent policies with platform defaults, and platform constraints always win. |

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
  - name: github
    env:
      GITHUB_TOKEN:
  - name: anthropic

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
    local_path: profiles/security-reviewer/settings.json
  - sandbox_path: /sandbox/.mcp.json
    local_path: profiles/security-reviewer/mcp.json

credential_sources:
  - type: vault
    path: kv/data/agents/github-pat
    provider_type: github
  - type: k8s_secret
    k8s_secret_ref: dev-namespace/anthropic-key
    provider_type: anthropic

sandbox_template:
  image: ghcr.io/nvidia/openshell:sandbox-v0.2.0
  resources:
    cpu: "2"
    memory: 4Gi
  gpu:
    count: 0

sandbox_policy:
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
        - host: github.com
          port: 443
          rules:
            - allow:
                method: GET
                path: "/**/info/refs*"
            - allow:
                method: POST
                path: "/**/git-upload-pack"
          deny_rules:
            - method: POST
              path: "/**/git-receive-pack"
        - host: raw.githubusercontent.com
          port: 443
          enforcement: enforce
          deny_rules:
            - method: "*"
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

gateway: default

labels:
  team: platform-security
  tier: review

annotations:
  owner: kyle.squizzato@example.com
```

---

## Example: Platform Base Agent + Inheritance

A platform base agent declared in the control plane namespace providing shared providers and security defaults:

```yaml
# ConfigMap in ambient-code namespace, labeled ambient.ai/kind: base-agent
# data key: default.yaml
name: default
providers:
  - name: google-vertex-ai
  - name: anthropic

sandbox_template:
  image: ghcr.io/nvidia/openshell:sandbox-v0.2.0
  resources:
    cpu: "2"
    memory: 4Gi

sandbox_policy:
  process:
    run_as_user: sandbox
    run_as_group: sandbox
  landlock:
    compatibility: best_effort

environment:
  LOG_LEVEL: info
```

A project agent inheriting from the platform base — only declares what differs:

```yaml
name: security-reviewer
base_agent: platform/default
description: Reviews PRs for OWASP top 10 vulnerabilities
prompt: |
  You are a security review agent specializing in OWASP top 10.
entrypoint: claude

providers:
  - name: github

credential_sources:
  - type: vault
    path: kv/data/agents/github-pat
    provider_type: github

sandbox_template:
  resources:
    memory: 8Gi

sandbox_policy:
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

labels:
  team: platform-security
```

**Effective configuration** after merge:

- `providers`: `[google-vertex-ai, anthropic, github]` (base + child, no duplicates)
- `sandbox_template.image`: `ghcr.io/nvidia/openshell:sandbox-v0.2.0` (inherited)
- `sandbox_template.resources`: `{cpu: "2", memory: 8Gi}` (cpu inherited, memory overridden)
- `sandbox_policy.process`: inherited from base
- `sandbox_policy.network_policies`: from child (base had none)
- `environment`: `{LOG_LEVEL: info}` (inherited)

---
