---
name: ci-workflows
description: >
  Maintain and troubleshoot CI/CD workflows for the Agent Control Plane.
  Covers component detection, auto-labeling, job gating, and adding new
  components to the pipeline. Use when adding components, debugging why
  tests don't run, fixing label issues, or modifying workflow behavior.
  Triggers on: "add component to CI", "tests not running", "PR labels",
  "build pipeline", "CI workflow", "auto-merge", "detect-components".
---

# CI Workflows

Maintain the GitHub Actions CI/CD pipeline. Component path detection is centralized in `.github/component-paths.json` — that is the single source of truth.

## User Input

```text
$ARGUMENTS
```

## Key Files

| File | Purpose |
|------|---------|
| `.github/component-paths.json` | Component → path + label mapping (single source of truth) |
| `.github/scripts/detect-components.sh` | Reads the JSON, outputs flags or applies labels |
| `.github/workflows/auto-merge.yml` | PR labeling + merge queue |
| `.github/workflows/unit-tests.yml` | Integration tests per component |
| `.github/workflows/lint.yml` | Go lint per component |
| `.github/workflows/components-build-deploy.yml` | Container builds (uses dorny — see below) |

## How It Works

`detect-components.sh` has two modes:

- **`--outputs`**: writes `component=true/false` to `$GITHUB_OUTPUT` for job gating. Used by `unit-tests.yml` and `lint.yml`.
- **`--label PR_NUMBER`**: applies `component/*` labels to a PR. Used by `auto-merge.yml`.

Both read from `component-paths.json`. The glob matching converts `**` to `.*` and `*` to `[^/]*`.

`components-build-deploy.yml` still uses `dorny/paths-filter` because it needs per-sidecar granularity (`credential-github`, `credential-jira`, etc.) for building individual container images. The shared JSON groups all sidecars as one entry.

## Adding a New Component

1. Add to `.github/component-paths.json`:
   ```json
   "my-component": {
     "paths": ["components/my-component/**"],
     "label": "component/my-component"
   }
   ```

2. Add test job in `unit-tests.yml` gated on `needs.detect-changes.outputs.my-component == 'true'`

3. If it builds a container: also add dorny filter + `ALL_COMPONENTS` entry in `components-build-deploy.yml`

4. Test locally:
   ```bash
   CHANGED_FILES="components/my-component/main.go" bash .github/scripts/detect-components.sh --outputs
   ```

## Troubleshooting

**Tests not running**: Check `component-paths.json` has the entry. Check the output key name matches the `unit-tests.yml` job's `if:` condition. Test with `CHANGED_FILES=... bash .github/scripts/detect-components.sh --outputs`.

**No PR labels**: Labeling runs in `auto-merge.yml` → `label-eligible`. Only fires on non-draft PRs from the same repo. Check the `component/*` label exists.

**Build not triggering**: `components-build-deploy.yml` uses its own dorny config, NOT `component-paths.json`. Add your component to both dorny and `ALL_COMPONENTS` in that file.

**Glob not matching**: `**` matches any depth. `*` stays within one directory. Trailing `**` (e.g., `foo/**`) matches all files recursively under `foo/`.

## Workflow Flow

```text
PR opened/synced
  ├─ auto-merge.yml → detect-components.sh --label → component/* labels
  ├─ unit-tests.yml → detect-components.sh --outputs → run changed tests
  ├─ lint.yml → detect-components.sh --outputs → lint changed Go code
  └─ components-build-deploy.yml → dorny → build changed images

All checks pass → auto-merge.yml enqueue → gh pr merge (direct enqueue)
```

## Auto-Merge Enqueue

The auto-merge workflow has two jobs:

- **`label-eligible`** (`pull_request`): checks author, adds `auto-merge-pending` label, applies component labels
- **`enqueue`** (`workflow_run`): fires when Unit Tests, Lint, Build, or CodeQL complete. Finds PRs with `auto-merge-pending`, waits for all 4 gate checks, enqueues.

### Critical: `gh pr merge` vs `gh pr merge --auto`

On a merge-queue-protected branch:
- `gh pr merge` (no flags) → **enqueues directly** when checks passed
- `gh pr merge --auto` → only sets auto-merge flag, does NOT enqueue

Always use `gh pr merge` (no `--auto`) in the enqueue step.

### Check polling

Waits for all 4 gate checks by name (`Lint CI Gate`, `Unit Tests CI Gate`, `SDD boundary check`, `Build CI Gate`) to be reported AND passing. Prevents false "all passed" when gates haven't started.

### Merge queue strategy

Uses `ALLGREEN` (every entry gets its own `merge_group` CI). `HEADGREEN` was removed — it skips `merge_group` events for PRs already up-to-date with main.
