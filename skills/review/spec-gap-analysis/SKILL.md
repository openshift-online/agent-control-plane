---
name: spec-gap-analysis
description: >
  Validate a spec against the actual codebase. Reads a *.spec.md file, searches
  for its implementation and test coverage, then writes a *.spec-gaps.md report
  alongside it. Run this on every spec before a release, after major refactors,
  or when you suspect spec drift. Triggers on: "gap analysis", "spec gaps",
  "validate spec", "spec coverage", "what's missing", "audit spec", "find gaps",
  "spec vs implementation", "untested requirements", "spec drift".
---

# Spec Gap Analysis

Validate one spec file against implementation and tests. Writes a sibling `*.spec-gaps.md`.

## Usage

```text
/spec-gap-analysis specs/platform/control-plane.spec.md
/spec-gap-analysis specs/security/rbac-enforcement.spec.md
```

## User Input

```text
$ARGUMENTS
```

## Steps

### Phase 1 — Parse the Spec

Read the spec file. Extract every requirement (statements using SHALL, MUST, SHOULD, MAY) and every scenario (GIVEN/WHEN/THEN blocks). Assign IDs: R1, R2, ... for requirements; S1, S2, ... for scenarios. Note which components the spec touches — use `CLAUDE.md` `## Structure` to map domains to source directories.

Summarize: "This spec covers N requirements and M scenarios across components X, Y, Z."

### Phase 2 — Search the Implementation

For each requirement, grep the codebase for key terms (function names, env vars, API paths, K8s resource kinds, error strings). Read matching files. Classify each requirement:

- **Implemented** — code matches the spec
- **Partial** — some aspects present, others missing
- **Deviation** — implemented differently than spec describes
- **Missing** — no implementation found

Also note **Impl Extras** — implementation behavior the spec doesn't cover.

### Phase 3 — Search the Tests

For each requirement, grep test directories for the same terms. Read matching test files. Classify coverage:

- **Full** — all scenarios have corresponding tests
- **Partial** — some scenarios tested
- **None** — no tests found

### Phase 4 — Classify Gaps

Produce four gap types:

- **G-type (Implementation Gap)** — spec requirement with no or partial implementation
- **T-type (Test Gap)** — implemented but untested. Priority: CRITICAL for security, HIGH for core paths, MEDIUM for secondary, LOW for edge cases
- **D-type (Drift)** — spec and implementation disagree. Needs human decision: update spec or fix code
- **E-type (Undocumented)** — implementation exists but spec doesn't describe it. Note for spec update consideration

### Phase 5 — Propose Tests

For each T-type gap, propose concrete test names and what they validate. Group by test file. Follow the project's existing test conventions.

### Phase 6 — Write the Report

Write to `<spec-path>.replace('.spec.md', '.spec-gaps.md')`. Follow the output format below.

## Output Format

```markdown
# <Spec Title> — Gap Analysis

**Date:** YYYY-MM-DD
**Spec:** `<path>`
**Components:** <source dirs>
**Tests:** <test dirs>

---

## Methodology
<brief description>

## Requirement Coverage Matrix

 < /dev/null |  ID | Requirement | Impl Status | Test Coverage | Priority |
|----|-------------|-------------|---------------|----------|

## Implementation Gaps (G-type)

### G1: <title>
- **Requirement:** R<n>
- **Spec says:** <quote>
- **Current state:** <description>
- **Risk:** <impact>

## Test Gaps (T-type)

### T1: <title>
- **Requirement:** R<n>
- **Implementation:** <file:line>
- **Current tests:** None / partial
- **Risk:** CRITICAL / HIGH / MEDIUM / LOW
- **Proposed tests:** `test_<name>` — <validates what>

## Drift (D-type)

### D1: <title>
- **Spec says:** <quote>
- **Implementation does:** <actual behavior>
- **Resolution:** Update spec / Fix code

## Undocumented Behavior (E-type)

### E1: <title>
- **Implementation:** <file:line>
- **Behavior:** <description>
- **Recommendation:** Add to spec / Remove / Keep internal

## Summary
- **Requirements:** N total (N impl, N partial, N missing)
- **Test coverage:** N full, N partial, N none
- **Top risks:** <ranked list>
```

## Heuristics

- Security requirements (auth, RBAC, tokens, paths) are always CRITICAL priority.
- SHALL/MUST with no test = T-type gap, always.
- Deviations need human judgment — flag, don't fix.
- Read actual code. Never guess from file names.
- One spec at a time. Run repeatedly for the full suite.
- Favor explanation over rigidity — if a requirement is ambiguous, say so rather than forcing a classification.
