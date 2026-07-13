# Spec Authoring Standards

Cross-cutting standards for writing specifications that serve as machine-readable desired-state declarations for autonomous agentic reconciliation.

## Purpose

Specs are the source of truth for desired system behavior. Code is the actual state. The development lifecycle reconciles the two through automated gap analysis, wave planning, and code generation. This standard defines how to write specs that agents can reliably parse, diff, and reconcile — enabling hands-free software delivery from intent to production.

## Context: Spec-Driven Development in an Agentic SDLC

Spec-driven development inverts the traditional workflow. Instead of humans writing code and documenting it afterward, specs declare the desired end state and autonomous agents reconcile code to match. This model draws from three established disciplines:

1. **Declarative reconciliation** (Kubernetes controllers) — desired state vs. actual state, with a control loop that converges the two. Specs are the CustomResource; code is the running system.
2. **Design by contract** (Eiffel, DbC) — preconditions, postconditions, and invariants expressed as behavioral contracts rather than implementation instructions.
3. **Behavior-Driven Development** (BDD/Gherkin) — Given/When/Then scenarios as executable specifications that double as acceptance tests.

The agentic SDLC adds a fourth dimension: **machine parseability**. Specs must be structured consistently enough that an agent can extract requirements, build a dependency graph, search for implementations, classify gaps, and generate code — all without human intervention.

### Industry Standards Referenced

| Standard | Application |
|----------|-------------|
| RFC 2119 (Key words for use in RFCs) | Requirement strength keywords: SHALL, MUST, SHOULD, MAY |
| IEEE 830 (Software Requirements Specifications) | Requirement attributes: unambiguous, complete, consistent, verifiable, traceable |
| Gherkin (Cucumber BDD) | Scenario format: Given/When/Then with And/But |
| RFC 6648 (Deprecating X- prefix) | No invented prefixes; use established terminology |
| OpenAPI 3.x | API contract co-evolution with specs |
| Kubernetes Declarative Model | Desired state + reconciler pattern |

## Requirements

### Requirement: Spec File Naming

Every spec file SHALL use the naming convention `<descriptive-kebab-case-title>.spec.md` and SHALL be placed in `specs/{domain}/` where domain is one of the established capability domains (platform, security, ui, cli, standards).

New domains MAY be introduced when existing domains become too broad, but SHALL NOT be created preemptively.

#### Scenario: New platform feature spec

- GIVEN a developer writes a spec for session timeout behavior
- WHEN the spec is placed in the repository
- THEN the filename is `session-timeout.spec.md`
- AND the file is located at `specs/platform/session-timeout.spec.md`

#### Scenario: Domain boundary decision

- GIVEN a spec covers both API behavior and RBAC policy
- WHEN the primary concern is authorization enforcement
- THEN the spec is placed in `specs/security/`
- AND cross-references to the platform data model use relative links

### Requirement: Document Structure

Every spec SHALL contain the following top-level sections in order:

1. `# Title` — a single H1 heading
2. Introductory paragraph(s) — prose overview of what this spec covers and why
3. `## Terminology` (if domain-specific terms are introduced) — definitions of terms used in the spec
4. `## Dependencies` (if cross-spec dependencies exist) — references to other specs this depends on
5. `## Requirements` — one or more `### Requirement: <Name>` subsections
6. `## Migration` (if changing existing behavior) — consumer impact table and amendment list
7. `## Design Decisions` (if non-obvious choices were made) — decision/rationale table

Optional metadata MAY appear immediately after the H1:

```markdown
**Date:** YYYY-MM-DD
**Status:** Active | Draft
**Issue:** [#N](url)
```

#### Scenario: Minimal valid spec

- GIVEN an author creates a new spec
- WHEN the spec contains an H1, introductory prose, and at least one Requirement with at least one Scenario
- THEN the spec is structurally valid

#### Scenario: Spec missing Requirements section

- GIVEN an author submits a spec for review
- WHEN the spec contains no `## Requirements` section
- THEN the spec is rejected as structurally invalid

### Requirement: Requirement Format

Each requirement SHALL be a level-3 heading under `## Requirements` using the format `### Requirement: <Descriptive Name>`. The body SHALL contain one or more declarative statements using RFC 2119 keywords (SHALL, MUST, SHOULD, MAY) to express the strength of each behavioral obligation.

Requirements SHALL describe observable behavior — inputs, outputs, error conditions, and constraints. Requirements SHALL NOT describe internal implementation details (class names, function signatures, library choices).

**Quick test:** if the implementation can change without changing externally visible behavior, it does not belong in the requirement.

#### Scenario: Well-formed requirement

- GIVEN a requirement states "The API server SHALL return 404 when a session does not exist"
- WHEN an agent parses this requirement
- THEN the agent can identify the subject (API server), the obligation (SHALL), and the observable behavior (return 404)
- AND the agent can search for implementation code that handles this case

#### Scenario: Requirement with implementation detail

- GIVEN a requirement states "The `handleGetSession` function SHALL query PostgreSQL using a LEFT JOIN"
- WHEN a reviewer evaluates this requirement
- THEN it is flagged as containing implementation details (function name, SQL join type)
- AND the author is asked to rewrite as observable behavior

### Requirement: Scenario Format

Every requirement SHALL have at least one scenario. Scenarios SHALL follow the Given/When/Then format with each clause on its own line, prefixed with a dash and the keyword in uppercase:

```markdown
#### Scenario: <Descriptive Name>

- GIVEN <precondition>
- AND <additional precondition>
- WHEN <action or event>
- THEN <expected observable outcome>
- AND <additional outcome>
```

Scenarios SHALL be concrete enough to derive automated tests. A scenario that cannot be validated through testing or explicit observation is too vague.

#### Scenario: Testable scenario

- GIVEN a scenario states "GIVEN credential A is bound to project P, WHEN a session starts in project P, THEN credential A is injected"
- WHEN an agent reads this scenario
- THEN the agent can derive a test: create a binding, start a session, assert credential presence

#### Scenario: Untestable scenario rejected

- GIVEN a scenario states "GIVEN the system is configured correctly, WHEN something happens, THEN it works"
- WHEN a reviewer evaluates this scenario
- THEN it is rejected for vagueness
- AND the author is asked to specify concrete preconditions, actions, and assertions

### Requirement: RFC 2119 Keyword Discipline

Specs SHALL use RFC 2119 keywords consistently and exclusively for requirement strength:

| Keyword | Meaning | Agent interpretation |
|---------|---------|---------------------|
| SHALL / MUST | Absolute requirement. Deviation is a gap. | G-type gap if missing, T-type gap if untested |
| SHALL NOT / MUST NOT | Absolute prohibition. Presence is a gap. | G-type gap if violated |
| SHOULD | Recommended. Exceptions require documented rationale. | Reported but not blocking |
| MAY | Optional. Implementation is at discretion. | Informational only |

These keywords SHALL appear in UPPERCASE when used normatively. Lowercase "should" or "must" in prose does not carry normative weight.

#### Scenario: Keyword strength determines gap severity

- GIVEN a spec states "The system SHALL validate input"
- AND no validation code exists
- WHEN gap analysis runs
- THEN a G-type gap is classified with at minimum HIGH priority

#### Scenario: SHOULD violation reported but not blocking

- GIVEN a spec states "The system SHOULD cache responses"
- AND no caching code exists
- WHEN gap analysis runs
- THEN the gap is reported as an advisory, not a blocker

### Requirement: Dependency Declaration

Every spec that depends on concepts, entities, or behaviors defined in another spec SHALL declare those dependencies explicitly, either in a `## Dependencies` section or in the Spec Registry (`specs/index.spec.md`).

Dependencies enable topological ordering for safe reconciliation — a spec's requirements cannot be implemented until its dependencies are satisfied.

#### Scenario: Spec with undeclared dependency

- GIVEN a spec references "credential bindings" without depending on `credential-binding.spec.md`
- WHEN a reviewer evaluates the spec
- THEN the missing dependency is flagged
- AND the author is asked to add it to the Dependencies section and the Spec Registry

#### Scenario: Circular dependency detected

- GIVEN spec A depends on spec B
- AND spec B depends on spec A
- WHEN the dependency graph is constructed
- THEN the circular dependency is flagged as a structural error
- AND one of the specs must be refactored to break the cycle

### Requirement: Spec Registry Entry

Every spec SHALL have a corresponding entry in `specs/index.spec.md` in the Spec Registry table. The entry SHALL include:

| Field | Description |
|-------|-------------|
| Path | Relative path from `specs/` |
| Domain | Capability domain (platform, security, ui, cli, standards) |
| Primary Entities | Domain objects this spec governs |
| Components | Which system components are affected (API, SDK, BE, CLI, CP, FE, Runner, MCP) |
| Depends On | Other specs this spec depends on (by short name) |

#### Scenario: New spec without registry entry

- GIVEN a new spec is created at `specs/platform/session-timeout.spec.md`
- WHEN the spec is submitted for review
- AND no corresponding entry exists in `specs/index.spec.md`
- THEN the review flags the missing registry entry as a blocker

### Requirement: Component Scope Declaration

Every spec SHALL identify which components it affects. This enables agents to know which source directories to search during gap analysis and which build/test targets to verify after reconciliation.

Component identifiers follow the established set: API, SDK, BE, CLI, CP, FE, Runner, MCP.

#### Scenario: Spec with clear component scope

- GIVEN a spec declares `Components: CP, Runner`
- WHEN an agent performs gap analysis
- THEN the agent searches only `components/ambient-control-plane/` and `components/runners/ambient-runner/`
- AND build verification targets only those components

### Requirement: Migration Path Completeness

Any spec that changes existing behavior SHALL include a `## Migration` section with two subsections:

1. **Existing consumers** — a table listing every consumer of the changed behavior, its current behavior, and the required change
2. **Specs requiring amendment** — a table listing other specs that must be updated to remain consistent

#### Scenario: Behavioral change without migration section

- GIVEN a spec changes the credential resolution algorithm
- WHEN the spec omits a Migration section
- THEN the review flags it as incomplete
- AND the author must enumerate all consumers (control plane, sidecars, runner, UI)

#### Scenario: Complete migration table

- GIVEN a spec includes a Migration section
- AND every known consumer is listed with current behavior and required change
- WHEN an agent reads the migration table
- THEN the agent can plan implementation waves that update all consumers

### Requirement: Observable Behavior Only

Specs SHALL describe externally observable behavior — what the system does — not how it does it internally. Acceptable spec content includes: API responses, error codes, state transitions, user-visible outcomes, security constraints, data schemas, and protocol contracts.

Unacceptable spec content includes: internal function names, class hierarchies, specific SQL queries, library or framework choices, and code structure.

#### Scenario: Spec with acceptable code examples

- GIVEN a spec includes a protobuf definition showing the wire format of a gRPC message
- WHEN a reviewer evaluates the code example
- THEN it is acceptable because it describes a protocol contract (externally observable)

#### Scenario: Spec with unacceptable implementation detail

- GIVEN a spec states "The `SessionRepository` class SHALL use a `sync.Map` for caching"
- WHEN a reviewer evaluates this requirement
- THEN it is flagged as over-specified implementation detail
- AND the author is asked to restate as observable behavior (e.g., "concurrent session lookups SHALL be safe")

### Requirement: Design Decision Documentation

When a spec makes non-obvious design choices, those choices SHALL be documented in a `## Design Decisions` section using a table with at minimum `Decision` and `Rationale` columns.

Design decisions are critical for agents and future authors to understand why a particular approach was chosen, preventing unnecessary re-litigation of settled questions.

#### Scenario: Design decision with rationale

- GIVEN a spec chooses hierarchical resolution over flat lookup for credential binding
- WHEN the Design Decisions table documents this choice
- THEN future agents and authors understand the rationale
- AND do not propose alternative approaches that were already considered and rejected

### Requirement: Living Document Maintenance

Specs SHALL be maintained as living documents. When system behavior changes, the spec SHALL be updated to reflect the new desired state. Specs SHALL NOT be archived, superseded, or moved to a historical directory. A spec that no longer reflects desired behavior SHALL be deleted, not deprecated.

#### Scenario: Feature removed from system

- GIVEN a feature described in a spec is permanently removed
- WHEN the desired state no longer includes this feature
- THEN the spec file is deleted from the repository
- AND the Spec Registry entry is removed from `specs/index.spec.md`

#### Scenario: Feature behavior changed

- GIVEN a spec describes credential resolution as flat lookup
- AND the system now uses hierarchical resolution
- WHEN the desired state changes
- THEN the spec is amended in place to describe hierarchical resolution
- AND a changelog note is added to the header metadata

### Requirement: Cross-Reference Integrity

Specs SHALL use relative markdown links when referencing other specs. Links SHALL point to specific sections when referencing a particular requirement or concept.

#### Scenario: Valid cross-reference

- GIVEN a spec references the token-reader role defined in `credential-binding.spec.md`
- WHEN the reference is written
- THEN it uses the format `[credential-binding](../security/credential-binding.spec.md#requirement-credential-token-reader-grant-lifecycle)`

#### Scenario: Broken cross-reference detected

- GIVEN a spec links to a heading that does not exist in the target spec
- WHEN a reviewer checks cross-reference integrity
- THEN the broken link is flagged for correction

### Requirement: Spec Size and Decomposition

A spec that exceeds approximately 300 words of prose (excluding scenarios, tables, and code blocks) or covers multiple distinct capabilities SHOULD be decomposed into multiple spec files within a containing directory.

#### Scenario: Oversized spec covering multiple concerns

- GIVEN a single spec file covers data model, API behavior, RBAC policy, and UI rendering
- WHEN a reviewer evaluates the scope
- THEN the spec is flagged for decomposition into domain-appropriate files

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| RFC 2119 keywords as normative vocabulary | Industry standard, unambiguous, machine-parseable. Agents can classify gap severity directly from keyword strength |
| Given/When/Then scenario format | Maps directly to automated tests. Agents can generate test scaffolding from scenarios without interpretation |
| Mandatory Spec Registry entry | Enables topological ordering for reconciliation waves. Without registry entries, agents cannot determine safe execution order |
| Observable behavior only | Specs that describe internals create false gaps when implementation changes. Observable-only specs remain stable across refactors |
| Living documents over versioned archives | Archived specs create ambiguity about current desired state. Single source of truth eliminates staleness |
| Migration path requirement | The most common spec gap is forgetting to update existing consumers. Mandatory migration tables force completeness |
| Component scope declaration | Bounds the search space for gap analysis. Without scope, agents must search the entire codebase for every requirement |
