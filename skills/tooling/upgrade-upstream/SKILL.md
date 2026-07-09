---
name: upgrade-upstream
description: >
  Upgrade the rh-trex-ai upstream framework dependency in ambient-api-server.
  Handles version bump, compilation verification, breaking change detection,
  test execution, and go.sum cleanup. Use when: "upgrade rh-trex-ai",
  "bump upstream", "update trex", "new upstream version", "upgrade framework",
  "pull in upstream changes", "update rh-trex-ai to latest".
---

# Upgrade Upstream (rh-trex-ai)

Upgrade the `github.com/openshift-online/rh-trex-ai` framework dependency
used by `components/ambient-api-server/`.

## User Input

```text
$ARGUMENTS
```

Parse `$ARGUMENTS` for:
- A target version (e.g. `v0.0.31`, `latest`, a commit SHA, or a branch name)
- `--dry-run` flag: analyze only, do not modify files
- If empty, default to `latest` (the newest tagged release)

## Scope

`rh-trex-ai` is consumed exclusively by `ambient-api-server`. No other
component (control-plane, CLI, SDK, MCP, runners, credential-sidecars)
depends on it. The upgrade is confined to:

```
components/ambient-api-server/
  go.mod     # version pin
  go.sum     # checksums
  **/*.go    # ~160 files across 20 import paths
```

## Upstream Import Surface

The API server imports 20 packages from `rh-trex-ai` across four groups:

 < /dev/null |  Group | Packages |
|-------|----------|
| Core API & data | `pkg/api`, `pkg/api/presenters`, `pkg/db`, `pkg/db/db_session`, `pkg/errors` |
| Server infra | `pkg/server`, `pkg/server/grpcutil`, `pkg/handlers`, `pkg/config`, `pkg/environments`, `pkg/auth`, `pkg/controllers`, `pkg/registry` |
| Utilities | `pkg/logger`, `pkg/util`, `pkg/services`, `pkg/testutil` |
| Plugins | `plugins/events`, `plugins/generic` |

Breaking changes in any of these packages require code fixes in this repo.

## Workflow

### Phase 1 -- Resolve Target Version

Record the current version, then resolve the target.

```bash
cd components/ambient-api-server
grep 'rh-trex-ai' go.mod
```

For `latest` or empty args, query the newest tag:
```bash
go list -m -versions github.com/openshift-online/rh-trex-ai | tr ' ' '\n' | tail -1
```

For a commit SHA or branch, resolve to a pseudo-version:
```bash
GOPROXY=direct go list -m github.com/openshift-online/rh-trex-ai@<ref>
```

If current == target, report "already at target version" and stop.
If `--dry-run`, proceed through Phase 2 only, then stop.

### Phase 2 -- Analyze Upstream Changes

Fetch the upstream commit log between versions to anticipate breakage:

```bash
gh api repos/openshift-online/rh-trex-ai/compare/<current>...<target> \
  --jq '.commits[] | "\(.sha[0:8]) \(.commit.message | split("\n")[0])"'
```

Look for renamed/removed exports, changed function signatures, moved
packages, new required config fields, or changed migration helpers.

Produce a change summary with commit count, risk level (low/medium/high),
affected upstream packages, and potential breakage notes.

### Phase 3 -- Bump the Version

```bash
cd components/ambient-api-server
go get github.com/openshift-online/rh-trex-ai@<target>
go mod tidy
grep 'rh-trex-ai' go.mod   # verify
```

### Phase 4 -- Verify Compilation

```bash
cd components/ambient-api-server && go build ./...
```

If compilation fails, read each error and fix it. Common patterns:

- **Removed/renamed type**: find the new name upstream, update imports
- **Changed signature**: adapt callers to the new signature
- **New required interface method**: implement it on conforming types
- **Moved package**: update import paths

Rebuild until clean. Do not suppress errors with `//nolint` or unsafe casts.

### Phase 5 -- Lint

```bash
cd components/ambient-api-server
go vet ./...
golangci-lint run
```

Fix any new lint issues introduced by the upgrade.

### Phase 6 -- Run Tests

```bash
cd components/ambient-api-server && make test
```

Distinguish **upstream behavioral changes** (adapt the code) from
**pre-existing failures** (note but do not block the upgrade).

### Phase 7 -- Cross-Component Spot Check

The API server's behavior affects all consumers. Quick checks:

- **gRPC**: if `pkg/server/grpcutil` changed, verify the interceptor chain
  still works (the control plane connects via gRPC)
- **OpenAPI**: if `pkg/api/presenters` or `pkg/handlers` changed, run
  `make generate` and verify no drift
- **Migrations**: if `pkg/db` changed, verify `make run` still migrates

### Phase 8 -- Report

```
UPGRADE COMPLETE: v0.0.30 -> v0.0.31
-------------------------------------
Files modified:     go.mod, go.sum [, any .go fixes]
Compilation:        PASS
Lint:               PASS
Tests:              PASS (N passed, M skipped)
Breaking changes:   none | <list>
```

## Rollback

If the upgrade cannot be completed, restore the previous version:

```bash
cd components/ambient-api-server
go get github.com/openshift-online/rh-trex-ai@<previous>
go mod tidy && go build ./...
```

Never leave `go.mod` in a half-upgraded state.

## Local Development Shortcut

For testing against an unreleased upstream branch:

```bash
cd components/ambient-api-server
go mod edit -replace github.com/openshift-online/rh-trex-ai=../../../openshift-online/rh-trex-ai
go mod tidy
```

**Never commit the replace directive.** Remove before PR:

```bash
go mod edit -dropreplace github.com/openshift-online/rh-trex-ai
go mod tidy
```

## Constraints

- Only `components/ambient-api-server/` is affected
- Never commit a `replace` directive for `rh-trex-ai`
- Code changes must follow existing conventions (no `panic()`, proper `fmt.Errorf`)
- `make test` and `golangci-lint run` must pass after upgrade
- Prefer upstream replacements over local workarounds for removed functions
