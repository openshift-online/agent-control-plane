# Agent Base Inheritance

**Date:** 2026-06-25
**Status:** Draft
**Related:** `specs/platform/agent-sandbox-config.spec.md` (agent YAML schema), `specs/platform/data-model.spec.md` (Agent entity)

---

## Purpose

Base agent inheritance enables configuration reuse across agent declarations. An agent MAY reference a `base_agent` whose fields are merged with the child agent's declaration. This supports fleet-wide defaults (e.g., a global base providing `google-vertex-ai` and `anthropic` providers to all agents across projects) and team-level configuration baselines.

This spec is a draft extension to `agent-sandbox-config.spec.md`. Agents without `base_agent` are fully self-contained and unaffected by this feature.

---

## Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `base_agent` | string | no | Reference to a base agent whose configuration this agent inherits from. Two scopes are supported: project-scoped (`agent-name`) resolves within the same project, platform-scoped (`platform/agent-name`) resolves from the platform-level base agent ConfigMap. |

**Merge semantics:**

| Field category | Merge behavior | Example |
|----------------|---------------|---------|
| Scalar fields | Child wins when set; base value used when child omits the field | `entrypoint`, `gateway`, `sandbox_template.image`, `prompt` |
| Array fields | Child entries appended after base entries; duplicates (by `name` or `sandbox_path`) are deduplicated with child winning | `providers`, `payloads`, `credential_sources` |
| Map fields | Merged key-by-key; child values take precedence on key collision | `environment`, `labels`, `annotations` |
| Nested objects | Merged field-by-field (same scalar/array/map rules apply recursively) | `sandbox_template`, `sandbox_policy` |

### Platform Base Agents

Platform base agents are declared in a ConfigMap labeled `ambient.ai/kind: base-agent` in the control plane namespace (not a tenant namespace). They are referenced via the `platform/` prefix:

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

### Storage

When persisted to the API server's `agents` table:

| YAML Field | Column | Type | Notes |
|------------|--------|------|-------|
| `base_agent` | `base_agent` | TEXT | Nullable; `platform/name` or `name` |

---

## Requirements

### Requirement: Base Agent Inheritance

The agent YAML SHALL support a `base_agent` field for configuration inheritance. Two scopes are supported:

- **Project-scoped**: `base_agent: agent-name` — resolves to a named agent within the same project (same tenant namespace).
- **Platform-scoped**: `base_agent: platform/agent-name` — resolves to a named base agent declared in the control plane namespace via a ConfigMap labeled `ambient.ai/kind: base-agent`.

Platform-scoped base agents enable fleet-wide defaults (e.g., a `default` base providing `google-vertex-ai` and `anthropic` providers to all agents across projects).

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

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Two resolution scopes (project and platform) | Project scope enables team-level baselines; platform scope enables fleet-wide defaults such as shared providers (`google-vertex-ai`, `anthropic`) and security baselines. |
| Merge model: scalar override / array concatenate / map merge | Matches intuitive "child overrides base" semantics. Array deduplication by `name` or `sandbox_path` prevents duplicate providers or payloads. Recursive merge for nested objects enables granular overrides (e.g., override only `sandbox_template.resources.memory` while inheriting the rest). |
| Depth limit of 5 levels | Prevents unbounded recursion and keeps configuration traceable. Five levels accommodates platform → team → role → agent chains with room to spare. |

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
