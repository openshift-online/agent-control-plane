# Specs

Specs describe the **desired state** of the system. Code is the actual state. Development work reconciles the two.

## Principles

1. **Desired state, not issue tracking.** A spec says "the system SHALL do X" — not "here's a bug, here's my proposed fix." If the system doesn't match the spec, the code is wrong.

2. **Living documents.** Specs are never archived or superseded. They are amended, replaced, or deleted. A spec that no longer reflects desired behavior is removed, not moved to a graveyard.

3. **Behavior contracts, not implementation plans.** Specs describe observable behavior — inputs, outputs, error conditions, constraints. Implementation invariants, such as library choices, etc. (NOTE: NOT IMPLEMENTATION PLANS. THIS IS A DEVELOPMENT CONCERN.) belong in `skills/`.

4. **Organized by capability domain.** Add domains when existing ones become too broad, not preemptively.

5. **Named descriptively.** Filenames follow `<descriptive-title>.spec.md`. Specs exceeding ~300 words or covering multiple distinct topics should be split into files within a containing directory.

## Format

Specs contain requirements, and each requirement has scenarios.

```markdown
# <Domain> Specification

## Purpose
High-level description of this spec's domain.

## Requirements

### Requirement: <Name>
The system SHALL <observable behavior>.

#### Scenario: <Name>
- GIVEN <precondition>
- WHEN <action>
- THEN <expected outcome>
- AND <additional outcome>
```

### Elements

| Element | Purpose |
|---------|---------|
| `## Purpose` | High-level description of the spec's domain |
| `### Requirement:` | A specific behavior the system must have |
| `#### Scenario:` | A concrete example of the requirement in action |
| `SHALL` / `MUST` | Absolute requirement (RFC 2119) |
| `SHOULD` | Recommended, but exceptions exist |
| `MAY` | Optional |

### What belongs in a spec

- Observable behavior users or downstream systems rely on
- Inputs, outputs, and error conditions
- External constraints (security, privacy, reliability, compatibility)
- Scenarios that can be tested or explicitly validated

### What does not belong in a spec

- Internal class/function names
- Library or framework choices
- Step-by-step implementation details

**Quick test:** if the implementation can change without changing externally visible behavior, it does not belong in the spec.

## Directory Structure

```
specs/
  index.spec.md          # This file
  platform/              # Data model, API, session lifecycle, control plane, runner, MCP
    index.spec.md        # Bookmarks and brief descriptions
    data-model.spec.md
    control-plane.spec.md
    runner.spec.md
    runner-constitution.md
    mcp-server.spec.md
  security/              # Identity boundaries, SSO, RBAC, credentials, encryption, sandbox
    index.spec.md
    identity-boundaries.spec.md
    sso-authentication.spec.md
    rbac-enforcement.spec.md
    credential-binding.spec.md
    credential-encryption.spec.md
    openshell-sandbox.spec.md
    references.spec.md
  ui/                    # Operations dashboard, session management, agent authoring
    index.spec.md
    architecture.spec.md
    views.spec.md
    annotations.spec.md
    live-preview.spec.md
  standards/             # Cross-cutting engineering constraints (TODO: upstream via APM)
    control-plane/
    platform/
    security/
```

### Specs

| Spec | Covers |
|------|--------|
| [`platform/`](platform/) | Data model, API, CLI, control plane, runner, MCP server |
| [`security/`](security/) | Identity boundaries, SSO, RBAC, credential binding/encryption, sandbox |
| [`ui/`](ui/) | Operations dashboard, agent authoring, annotations, live preview |
| `standards/` | Cross-cutting engineering constraints by component |
