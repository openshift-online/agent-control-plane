---
name: reconcile
description: >
  Top-level autonomous orchestrator that reconciles all specs against the codebase.
  Reads skills/RECONCILE.md for checkpoint state, runs field-level gap analysis,
  plans waves, and executes the full-stack-pipeline per wave. Idempotent: safe to
  run repeatedly -- produces the same result for the same spec+code state.
  Use when: "reconcile everything", "run full reconciliation", "what's the gap
  across all specs", "autonomous build", "just do it", "build everything",
  "reconcile specs to code", "spec coverage", "what's left to implement",
  "implementation status".
---

# Reconcile

Autonomous code reconciliation against the spec corpus. Orchestrates all other
skills into a single convergence loop.

## User Input

```text
$ARGUMENTS
```

Supported arguments:
- *(empty)* -- full reconciliation across all specs
- `--dry-run` -- gap analysis only, no code changes
- `--domain <platform < /dev/null | security|ui>` -- scope to a single spec domain
- `--spec <path>` -- scope to a single spec file
- `--wave <N>` -- start from a specific wave number
- `--auto-approve` -- skip human approval gates (for CI)

## Checkpoint: skills/RECONCILE.md

**Read `skills/RECONCILE.md` first.** This is the checkpoint file.

It contains:
- The skill directory overview
- The current coverage summary (domain × present/partial/missing)
- The full gap table with IDs, severity, spec references, and notes
- The wave plan grouping gaps by execution layer
- The reconciliation history (date, commit, coverage trend)
- Divergences requiring human decision

### Idempotency Rules

1. If `RECONCILE.md` has a gap table and `Last analyzed` matches the current
   HEAD commit, skip Phases 1-4. Jump to Phase 5 (wave planning) or Phase 6
   (execution) based on `$ARGUMENTS`.
2. If specs or code changed since `Last analyzed`, re-run Phase 3 (gap analysis)
   for affected specs only. Determine affected specs by diffing:
   ```bash
   git diff <last_analyzed_commit>..HEAD --name-only | grep -E '^specs/|^components/'
   ```
3. After each wave, update `RECONCILE.md` in-place: move completed gap IDs to
   the history section, update coverage numbers, update the date and commit.
4. Commit `RECONCILE.md` alongside code changes so the next session inherits state.

## Phases

### Phase 1-2: Spec Discovery & Dependency Graph

Read the Spec Registry in `specs/index.spec.md` and the dependency order in
`RECONCILE.md`. Only re-derive if specs were added or removed since last run.

### Phase 3: Gap Analysis

For each spec in topological order, check every requirement at field level:

| Layer | What to check | Where |
|-------|---------------|-------|
| API | Routes, schemas, `required[]` | `openapi/openapi.yaml` |
| SDK | Generated types, builders, clients | `components/ambient-sdk/` |
| BE | Models, DAOs, handlers, migrations | `components/ambient-api-server/` |
| CP | Middleware, interceptors, reconciler | `components/ambient-control-plane/` |
| CLI | Commands per spec CLI table | `components/ambient-cli/` |
| Runner | Events, credentials, gRPC push | `components/runners/ambient-runner/` |
| FE | Service layer, hooks, components | `components/ambient-ui/src/` |

Check three directions: Spec→Code, Code→Spec, OpenAPI→Spec.

### Phase 4: Update RECONCILE.md

Merge gap tables. Update coverage summary. Write to `skills/RECONCILE.md`.
If `--dry-run`, stop here.

### Phase 5: Wave Planning

Read the wave plan from `RECONCILE.md`. Waves follow `/full-stack-pipeline`
dependency order: API → SDK → BE+CP → CLI+Runner → FE → Integration.

### Phase 6: Execution Loop

For each wave:
1. Present wave plan (unless `--auto-approve`)
2. Dispatch subagents per gap item following `/full-stack-pipeline` patterns
3. Verify with layer-specific gate (lint, build, test)
4. Run `/align` for affected component scope
5. Re-gap analysis for this wave's items (max 3 retries)
6. Update `RECONCILE.md`: mark items done, update coverage, update date/commit
7. Commit `RECONCILE.md` with code changes

### Phase 7-8: Report & Self-Review

Run `/acp-review-guidance` checklist. Run `/align` full codebase. Present
reconciliation report showing coverage delta.

## Skill Interactions

| Skill | Role |
|-------|------|
| `/full-stack-pipeline` | Gap analysis methodology, wave structure, layer patterns |
| `/align` | Post-wave convention scoring |
| `/acp-review-guidance` | Pre-PR self-review |
| `/spec` | Suggest spec amendments when ambiguity found |
| `/dev-cluster` | Wave 7 integration testing |

## Constraints

- Never modify specs during reconciliation (code changes only)
- One wave at a time; downstream waits for upstream verification
- Max 3 retries per wave before human escalation
- Subagents stay in their layer
- Always update `skills/RECONCILE.md` after state changes
- Divergences (D-prefixed items) require human decision before execution
