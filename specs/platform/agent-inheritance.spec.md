# Agent Configuration Reuse via Kustomize Overlays

**Date:** 2026-06-25
**Status:** Draft
**Related:** `specs/platform/agent-sandbox-config.spec.md` (agent YAML schema), `specs/platform/data-model.spec.md` (Agent entity)

> **Draft — not in scope for current implementation.** This spec captures future thinking for agent configuration reuse. It is not a deliverable of the current agent sandbox configuration work and should not be referenced as committed design. It may be promoted to a full spec in a future iteration.

---

## Purpose

Agent configuration reuse enables teams to define shared baselines (providers, policies, sandbox templates, environment) and compose them with per-agent overrides. Rather than building a custom inheritance engine in the control plane, this spec uses Kustomize — the same tool already used by `acpctl apply` — to merge base and overlay YAML at apply time. The control plane only ever sees fully-resolved, flattened ConfigMaps.

This approach follows the existing project pattern of using Kustomize bases and overlays for manifest composition, and avoids adding merge logic to the control plane reconciler.

---

## How It Works

```
Git repo (base + overlays) → Kustomize merge → Flattened ConfigMaps → ArgoCD sync → Cluster → Control plane reads
```

1. Teams maintain agent, provider, and policy YAML in git using Kustomize directory structure
2. `acpctl apply` (or ArgoCD with Kustomize) runs `kustomize build`, which merges bases with overlays
3. The output is a set of fully-resolved ConfigMaps — no `base_agent` field, no merge semantics
4. ArgoCD syncs the ConfigMaps to tenant namespaces
5. The control plane reads the flattened ConfigMaps — it has no awareness of inheritance

The control plane never performs merge operations. All composition happens before the ConfigMap reaches the cluster.

---

## Directory Structure

### Platform base (shared across projects)

```
agents/
  base/
    kustomization.yaml
    agent-defaults.yaml       # Base agent YAML (shared entrypoint, sandbox_template, etc.)
    providers.yaml            # Shared provider declarations
    policies.yaml             # Shared policy declarations
```

```yaml
# agents/base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - agent-defaults.yaml
  - providers.yaml
  - policies.yaml
```

```yaml
# agents/base/agent-defaults.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: agent-defaults
  labels:
    ambient.ai/kind: agent
data:
  defaults: |
    name: defaults
    entrypoint: claude
    providers:
      - google-vertex-ai
      - anthropic
    sandbox_policy: standard
    sandbox_template:
      image: ghcr.io/nvidia/openshell:sandbox-v0.2.0
      resources:
        cpu: "2"
        memory: 4Gi
    environment:
      LOG_LEVEL: info
```

### Project overlay (per-team customization)

```
agents/
  overlays/
    project-alpha/
      kustomization.yaml
      security-reviewer.yaml  # Project-specific agent overrides
      providers.yaml          # Additional project providers
```

**Option A: `configMapGenerator` with `behavior: merge`** (preferred — overlay only declares the delta)

```yaml
# agents/overlays/project-alpha/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: alpha
resources:
  - ../../base
  - providers.yaml
configMapGenerator:
  - name: agent-defaults
    behavior: merge
    labels:
      ambient.ai/kind: agent
    files:
      - security-reviewer=agents/security-reviewer.yaml
```

```yaml
# agents/overlays/project-alpha/agents/security-reviewer.yaml
name: security-reviewer
description: Reviews PRs for OWASP top 10 vulnerabilities
prompt: |
  You are a security review agent specializing in OWASP top 10.
providers:
  - google-vertex-ai
  - anthropic
  - github
sandbox_policy: restricted
sandbox_template:
  resources:
    memory: 8Gi
environment:
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1"
labels:
  team: platform-security
```

With `behavior: merge`, Kustomize merges the overlay's data keys into the base ConfigMap. The overlay agent file only declares what differs — `entrypoint`, `sandbox_template.image`, `sandbox_template.resources.cpu`, and `LOG_LEVEL` are inherited from the base.

**Option B: JSON patch `op: replace`** (valid but requires repeating the full agent YAML)

```yaml
# agents/overlays/project-alpha/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: alpha
resources:
  - ../../base
  - providers.yaml
patches:
  - target:
      kind: ConfigMap
      name: agent-defaults
    patch: |
      - op: replace
        path: /data/defaults
        value: |
          name: security-reviewer
          description: Reviews PRs for OWASP top 10 vulnerabilities
          prompt: |
            You are a security review agent specializing in OWASP top 10.
          entrypoint: claude
          providers:
            - google-vertex-ai
            - anthropic
            - github
          sandbox_policy: restricted
          sandbox_template:
            image: ghcr.io/nvidia/openshell:sandbox-v0.2.0
            resources:
              cpu: "2"
              memory: 8Gi
          environment:
            LOG_LEVEL: info
            CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1"
          labels:
            team: platform-security
```

> **Tradeoff.** JSON patch `op: replace` on a ConfigMap data key replaces the entire string value — the overlay must repeat every field, not just the delta. This works but defeats the purpose of "only declare what differs." `configMapGenerator` with `behavior: merge` or strategic merge patches are cleaner when the goal is true overlay semantics. JSON patch is appropriate when the overlay intentionally replaces the entire agent definition rather than extending a base.

### What `kustomize build` produces

Running `kustomize build agents/overlays/project-alpha/` outputs fully-resolved ConfigMaps with all values merged. The control plane sees only the final result — no `base_agent` field, no layering metadata.

```yaml
# $ kustomize build agents/overlays/project-alpha/
---
apiVersion: v1
kind: ConfigMap
metadata:
  labels:
    ambient.ai/kind: agent
  name: agent-defaults
  namespace: alpha
data:
  security-reviewer: |
    name: security-reviewer
    description: Reviews PRs for OWASP top 10 vulnerabilities
    prompt: |
      You are a security review agent specializing in OWASP top 10.
    entrypoint: claude
    providers:
      - google-vertex-ai
      - anthropic
      - github
    sandbox_policy: restricted
    sandbox_template:
      image: ghcr.io/nvidia/openshell:sandbox-v0.2.0
      resources:
        cpu: "2"
        memory: 8Gi
    environment:
      LOG_LEVEL: info
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1"
    labels:
      team: platform-security
---
apiVersion: v1
kind: ConfigMap
metadata:
  labels:
    ambient.ai/kind: provider
  name: shared-providers
  namespace: alpha
data:
  google-vertex-ai: |
    name: google-vertex-ai
    type: google-vertex-ai
    secret: google-vertex-ai-key
  anthropic: |
    name: anthropic
    type: anthropic
    secret: anthropic-key
---
apiVersion: v1
kind: ConfigMap
metadata:
  labels:
    ambient.ai/kind: provider
  name: project-providers
  namespace: alpha
data:
  github: |
    name: github
    type: github
    secret: github-pat
```

---

## Patterns

### Pattern: Shared providers across projects

Define provider ConfigMaps in a Kustomize base. Each project overlay inherits the base providers and can add project-specific ones.

```yaml
# agents/base/providers.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: shared-providers
  labels:
    ambient.ai/kind: provider
data:
  google-vertex-ai: |
    name: google-vertex-ai
    type: google-vertex-ai
    secret: google-vertex-ai-key
  anthropic: |
    name: anthropic
    type: anthropic
    secret: anthropic-key
```

```yaml
# agents/overlays/project-alpha/providers.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: project-providers
  labels:
    ambient.ai/kind: provider
data:
  github: |
    name: github
    type: github
    secret: github-pat
```

The project overlay's `kustomization.yaml` includes both — `kustomize build` produces two ConfigMaps, both applied to the namespace.

### Pattern: Shared policies across projects

Same approach — define policy ConfigMaps in the base, override or add in overlays.

### Pattern: Local development overrides

For local development, use a dev-specific overlay that swaps provider secrets to dev-specific ones:

```yaml
# agents/overlays/dev/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../project-alpha
patches:
  - target:
      kind: ConfigMap
      name: shared-providers
    patch: |
      - op: replace
        path: /data/anthropic
        value: |
          name: anthropic
          type: anthropic
          secret: dev-anthropic-key
```

### Pattern: Policy composition

To compose multiple policy concerns (e.g., base network restrictions + agent-specific endpoints), define separate policy files in the base and merge them in the overlay using Kustomize's ConfigMapGenerator or JSON patches. The final ConfigMap delivered to the cluster contains the fully-merged policy YAML.

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Kustomize over custom merge engine | The project already uses Kustomize for manifest composition and `acpctl apply` invokes it. Building a `base_agent` merge engine in the control plane duplicates functionality, adds complexity (circular detection, depth limits, merge semantics), and creates a divergent composition model. Kustomize is a known tool with established patterns. |
| Composition happens at apply time, not runtime | The control plane reads fully-resolved ConfigMaps — no merge logic, no base agent resolution, no additional watch scopes. This simplifies the control plane reconciler and makes agent configurations inspectable via `kubectl get configmap`. |
| No `base_agent` field in agent schema | With Kustomize handling composition, agents don't need a `base_agent` field. The agent YAML schema remains flat and self-contained. Inheritance is a property of the git repo structure, not the agent declaration format. |
| Git repo structure encodes the hierarchy | Platform base → team overlay → agent overlay maps naturally to Kustomize's base/overlay directory structure. Teams can see exactly what they inherit by reading the `kustomization.yaml`. |

---

## Comparison with Custom Inheritance

| Aspect | Custom `base_agent` field | Kustomize overlays |
|--------|--------------------------|-------------------|
| Merge engine | Built into control plane | Kustomize (external, well-tested) |
| Control plane complexity | Must resolve inheritance chains, detect cycles, enforce depth limits | Reads flat ConfigMaps only |
| Debuggability | Must reconstruct effective config from chain | `kustomize build` shows the exact output |
| Tooling | Custom — must build resolution logic | Standard — Kustomize, `acpctl apply`, ArgoCD |
| Watch scope | Control plane must watch base agent ConfigMaps in its own namespace | No additional watch scopes |
| Policy composition | Custom merge rules for policy fields | Kustomize patches on policy ConfigMaps |

---
