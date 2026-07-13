---
name: spec-review
description: >
  Review a spec file for adherence to the project's spec authoring standards.
  Validates structure, RFC 2119 keyword usage, scenario completeness, dependency
  declarations, registry entry, and reconcilability. Use before merging any new
  or modified spec. Triggers on: "review spec", "spec review", "check spec",
  "validate spec format", "spec standards", "is this spec valid", "spec quality".
---

# Spec Review

Validate a spec file against the spec authoring standards defined in `specs/standards/specs/specs.spec.md`. Produces a structured review with pass/fail verdicts per check and actionable feedback.

## Usage

```text
/spec-review specs/platform/session-timeout.spec.md
/spec-review specs/security/new-rbac-policy.spec.md
```

## User Input

```text
$ARGUMENTS
```

## Before Anything Else

Load the spec authoring standards:

1. Read `specs/standards/specs/specs.spec.md`
2. Read `specs/index.spec.md` (Spec Registry)
3. Read the target spec file provided in `$ARGUMENTS`

If no file path is provided, ask the user which spec to review.

## Steps

### Phase 1 — Structural Validation

Check the spec against the required document structure. For each item, classify as PASS, FAIL, or WARN:

 < /dev/null |  # | Check | Severity | Rule |
|---|-------|----------|------|
| S1 | Single H1 heading exists | FAIL | Exactly one `#` heading |
| S2 | Introductory prose follows H1 | FAIL | At least one paragraph before any `##` section |
| S3 | `## Requirements` section exists | FAIL | Mandatory section |
| S4 | Requirements use `### Requirement: <Name>` format | FAIL | Every H3 under Requirements must match pattern |
| S5 | Every requirement has at least one `#### Scenario:` | FAIL | No requirement without a scenario |
| S6 | `## Terminology` present if domain-specific terms introduced | WARN | Terms used but not defined |
| S7 | `## Dependencies` present if cross-spec references exist | WARN | References other specs without declaring dependency |
| S8 | `## Migration` present if changing existing behavior | FAIL | Behavioral change without migration plan |
| S9 | `## Design Decisions` present if non-obvious choices made | WARN | Complex design without rationale |
| S10 | File naming follows `<descriptive-title>.spec.md` | FAIL | Kebab-case with `.spec.md` extension |
| S11 | File placed in correct domain directory | WARN | Path matches `specs/{domain}/` |

### Phase 2 — Semantic Validation

Check the content quality of requirements and scenarios:

| # | Check | Severity | Rule |
|---|-------|----------|------|
| M1 | RFC 2119 keywords used in requirements | FAIL | Every requirement must contain at least one normative keyword |
| M2 | Keywords appear in UPPERCASE | WARN | Lowercase "shall" or "must" in normative context |
| M3 | No implementation details in requirements | FAIL | Internal function names, class names, SQL queries, library choices |
| M4 | Requirements describe observable behavior | FAIL | Inputs, outputs, error codes, state transitions — not internals |
| M5 | Scenarios are concrete and testable | FAIL | No vague preconditions or outcomes |
| M6 | Scenarios follow Given/When/Then format | FAIL | `- GIVEN`, `- WHEN`, `- THEN` with optional `- AND` |
| M7 | Every GIVEN has a corresponding WHEN and THEN | FAIL | Incomplete scenario structure |
| M8 | No reserved term collisions | WARN | Check against Ambient domain model terms |

### Phase 3 — Reconcilability Validation

Check that an autonomous agent can use this spec for gap analysis and code generation:

| # | Check | Severity | Rule |
|---|-------|----------|------|
| R1 | Spec Registry entry exists in `specs/index.spec.md` | FAIL | Every spec must be registered |
| R2 | Registry entry has all required fields | FAIL | Path, Domain, Primary Entities, Components, Depends On |
| R3 | Component scope declared | FAIL | Agent must know where to search |
| R4 | Dependencies match cross-spec references in body | WARN | Body references a spec not listed in Dependencies or Registry |
| R5 | No circular dependencies | FAIL | Check the dependency graph for cycles |
| R6 | Scenarios can derive test assertions | WARN | Each THEN clause maps to a verifiable assertion |
| R7 | Migration table covers all affected consumers | WARN | Verify completeness against Component scope |

### Phase 4 — Cross-Reference Integrity

| # | Check | Severity | Rule |
|---|-------|----------|------|
| X1 | All relative markdown links resolve to existing files | FAIL | No broken links |
| X2 | Section-level links resolve to existing headings | WARN | Link targets exist in referenced file |
| X3 | Specs referenced in Dependencies section exist | FAIL | No phantom dependencies |

### Phase 5 — Generate Review Report

```markdown
# Spec Review: <Spec Title>

**Date:** YYYY-MM-DD
**Spec:** `<path>`
**Reviewer:** spec-review skill

## Verdict: PASS | FAIL | WARN

## Results

### Structural Validation
| Check | Result | Detail |
|-------|--------|--------|

### Semantic Validation
| Check | Result | Detail |
|-------|--------|--------|

### Reconcilability Validation
| Check | Result | Detail |
|-------|--------|--------|

### Cross-Reference Integrity
| Check | Result | Detail |
|-------|--------|--------|

## Summary
- **Passed:** N/M checks
- **Failed:** N checks (must fix)
- **Warnings:** N checks (should fix)
- **Blockers:** <list of FAIL items>

## Recommendations
<actionable fixes for each FAIL and WARN>
```

### Verdict Rules

- **PASS** — zero FAILs
- **FAIL** — one or more FAILs
- **WARN** — zero FAILs, one or more WARNs (reported as PASS with advisory)

Present the report to the user. If the verdict is FAIL, offer to help fix the issues.

## Heuristics

- **Read the spec, not just the headings.** Structurally valid specs can have semantic problems.
- **Implementation detail is the most common antipattern.** Authors instinctively write how they plan to build something. Redirect to observable behavior.
- **Migration completeness is the highest-value check.** Missing consumers cause cascading failures during reconciliation waves.
- **Registry entry is a hard gate.** Without it, `/reconcile` cannot discover or order the spec.
- **Don't flag style preferences as failures.** Prose quality and heading capitalization are not structural violations.
- **Favor explanation over rejection.** When a check fails, explain why the standard exists and what specific change would fix it.
