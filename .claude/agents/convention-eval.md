---
name: convention-eval
description: >
  Runs all convention checks across the full codebase and produces a scored
  alignment report. Dispatched by the /align skill.
tools:
  - Read
  - Grep
  - Glob
  - Bash
---

# Convention Evaluation Agent

Evaluate codebase adherence to documented conventions. Produce a scored report.

## Context Files

Load these before running checks:

1. `specs/standards/control-plane/conventions.spec.md`
2. `specs/standards/security/security.spec.md`

## Checks by Category

### Operator (7 checks, weight: 30%)

| # | Check | Severity |
|---|-------|----------|
| O1 | OwnerReferences on child resources | Blocker |
| O2 | Proper reconciliation patterns | Critical |
| O3 | SecurityContext on Job pods | Critical |
| O4 | Resource limits/requests | Major |
| O5 | No `panic()` in production | Blocker |
| O6 | Status condition updates | Critical |
| O7 | No `context.TODO()` | Minor |

### Runner (4 checks, weight: 15%)

| # | Check | Severity |
|---|-------|----------|
| R1 | Proper async patterns | Major |
| R2 | Credential handling | Blocker |
| R3 | Error propagation | Critical |
| R4 | No hardcoded secrets | Blocker |

### Security (7 checks, weight: 25%)

| # | Check | Severity |
|---|-------|----------|
| S1 | User token for user ops | Blocker |
| S2 | RBAC before resource access | Critical |
| S3 | Token redaction | Blocker |
| S4 | Input validation | Major |
| S5 | SecurityContext on pods | Critical |
| S6 | OwnerReferences on Secrets | Critical |
| S7 | No hardcoded credentials | Blocker |

## Scoring

- Each check: Pass (1) or Fail (0)
- Category score: passes / total
- Overall score:
  - Full scope: weighted average across all categories
  - Scoped runs: renormalize weights to selected categories (e.g., backend-only uses 100% backend weight)

## Output Format

```markdown
# Convention Alignment Report

**Scope:** [full | backend | frontend | ...]
**Date:** [ISO date]
**Overall Score:** [X%]

## Category Scores

| Category | Score | Pass | Fail | Blockers |
|----------|-------|------|------|----------|
| Operator | X/7   | X    | X    | X        |
| Runner   | X/4   | X    | X    | X        |
| Security | X/7   | X    | X    | X        |

## Failures

### Blockers
[List with file:line references]

### Critical
[List with file:line references]

### Major / Minor
[List]

## Recommendations
[Top 3 priorities to improve alignment]
```
