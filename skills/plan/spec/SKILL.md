---
name: spec
description: >
  Create or modify a spec following the project's spec format and conventions.
  Use when the user wants to write a new spec, add requirements or scenarios
  to an existing spec, or restructure spec content. Triggers on: "write a spec",
  "create a spec", "add a requirement", "spec this out", "define the behavior",
  "what should the spec look like", "new spec for", "update the spec".
---

# Write or Modify a Spec

Help the user create or change a spec that describes desired system behavior.

## User Input

```text
$ARGUMENTS
```

## Before Anything Else

Read the [Spec Format Reference](#spec-format-reference) below, then follow the phases in order.

## Steps

### Phase 1 — Frame

Establish the framing before writing anything:

- **Desired state only.** Ask the user what the system should do, not what's currently broken. If they describe a bug, redirect: "What should the correct behavior be?"
- **Scope boundary.** Which components does this change touch? (schema, gRPC, runner, operator, CLI, frontend, SDK, RBAC)
- **Reserved terms check.** Verify no collision with Ambient domain model terms (Inbox, Session, Agent, Project, Credential, SessionMessage, etc.)

### Phase 2 — Ground in the codebase

Read actual code and existing specs in the affected areas. Confirm your understanding without wasting the user's time:

- Read existing specs in the target domain
- Grep the components identified in Phase 1
- Summarize back in 3–5 sentences: what you found, what you believe they want, what's ambiguous
- Ask only where the codebase doesn't give a clear answer

Do not proceed to drafting until the user confirms.

### Phase 3 — Draft the Spec

Follow the [Spec Format Reference](#spec-format-reference) below:

- **Purpose section** — one paragraph describing the domain or feature
- **Requirements** — each states an observable behavior using RFC 2119 keywords (SHALL, MUST, SHOULD, MAY)
- **Scenarios** — concrete Given/When/Then examples for each requirement that could be turned into tests

Include: data model, write paths, read paths, RBAC, migration plan for all existing consumers.

### Phase 4 — Critic Pass

Spawn critics in parallel per the workflow. Standard critics (every spec change):
- Schema / migration
- RBAC / auth
- Ambient terminology

Plus scope-driven critics based on the components identified in Phase 1.

### Phase 5–6 — Synthesize and Present

Separate findings into factual errors (fix directly) and design decisions (present to user with 2–3 concrete options each, one at a time).

### Phase 7 — Apply and Verify

Apply all fixes. Run a second critic pass (Phase 8). Stop when only MINORs remain.

### Final — Name and Place the File

- Filename: `<descriptive-title>.spec.md`
- If the spec exceeds ~300 words or covers multiple distinct topics, split into a directory with multiple files
- Place in `specs/{domain}/`

## Heuristics

- **Critics should outnumber reviewers.** Ten parallel critics for 45 minutes beats one sequential review over a day.
- **The author's time is for design decisions only.** Everything with a right answer should never reach them.
- **"Desired state" framing eliminates the largest class of false positives** (current code ≠ spec). Establish it before the first critic pass, not after.
- **The Ambient domain model is a minefield of reserved terms.** A dedicated terminology critic is cheaper than discovering the collision during implementation.
- **Migration path completeness is the most common gap:** for every existing consumer of what you're changing, the spec must say what happens to it.

## Spec Format Reference

Specs describe the **desired state** of the system. Code is the actual state. Development work reconciles the two.

### Principles

1. **Desired state, not issue tracking.** A spec says "the system SHALL do X" — not "here's a bug, here's my proposed fix." If the system doesn't match the spec, the code is wrong.
2. **Living documents.** Specs are never archived or superseded. They are amended, replaced, or deleted. A spec that no longer reflects desired behavior is removed, not moved to a graveyard.
3. **Behavior contracts, not implementation plans.** Specs describe observable behavior — inputs, outputs, error conditions, constraints. Implementation details belong in `skills/`.
4. **Organized by capability domain.** Add domains when existing ones become too broad, not preemptively.
5. **Named descriptively.** Filenames follow `<descriptive-title>.spec.md`. Specs exceeding ~300 words or covering multiple distinct topics should be split into files within a containing directory.

### Required Format

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
