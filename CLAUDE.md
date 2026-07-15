# Agent Control Plane

Kubernetes-native AI automation platform that orchestrates agentic sessions through containerized microservices. Built with Go (API server, control plane), NextJS + Shadcn (UI), and Python (runner). PostgreSQL is the source of truth; the control plane reconciles via gRPC watch streams.

> Some RBAC manifests still reference the `vteam.ambient-code` API group for backward compatibility.

## Structure

- `components/ambient-api-server/` - Go REST API microservice (rh-trex-ai framework), PostgreSQL-backed
- `components/ambient-control-plane/` - Go service, watches API server via gRPC and reconciles sessions into K8s Jobs
- `components/ambient-ui/` - NextJS + Shadcn web UI for session management and monitoring
- `components/ambient-mcp/` - MCP server integration
- `components/runners/ambient-runner/` - Python runner executing Claude Code CLI in Job pods
- `components/ambient-cli/` - Go CLI (`acpctl`), manages agentic sessions from the command line
- `components/ambient-sdk/` - Go, Python, and TypeScript client SDKs generated from the OpenAPI spec
- `components/credential-sidecars/` - Per-provider credential sidecar containers (GitHub, Jira, K8s, Google)
- `components/manifests/` - Kustomize-based deployment manifests and overlays
- `docs/` - Astro Starlight documentation site
- `specs/` - Desired state of the system ([platform](specs/platform/), [security](specs/security/), [ui](specs/ui/), [standards](specs/standards/))
- `skills/` - Agent skills: [reconcile](skills/build/reconcile), [spec](skills/plan/spec), [full-stack-pipeline](skills/build/full-stack-pipeline), [dev-cluster](skills/build/dev-cluster), [pr-test](skills/test/pr-test), [deploy-cluster](skills/deploy/deploy-cluster), [review](skills/review/acp-review-guidance), [tooling](skills/tooling/)
- `apm.yml` - APM manifest declaring upstream skill dependencies (fleet-sdlc)
- `.claude/skills/` - APM-installed upstream skills (gitignored, run `apm install`)
- `.claude/commands/` - APM-installed upstream commands (gitignored)

## Key Files

- Control plane reconciler: `components/ambient-control-plane/internal/reconciler/kube_reconciler.go`
- K8s client init: `components/ambient-control-plane/internal/config/config.go`
- Runner entry point: `components/runners/ambient-runner/main.py`
- RBAC: ClusterRoles in `components/manifests/base/rbac/` grant `vteam.ambient-code` API group access (legacy CRs created as side-effects, not used as source of truth)

## Session Flow

```
User Creates Session → API Server Persists to DB → Control Plane Spawns Job →
Pod Runs AI Agent → Results Stream to API Server → UI Displays Progress
```

## SDLC Workflow

The development lifecycle follows 6 steps, each backed by a skill:

```
0. /reconcile             — autonomous spec-to-code reconciliation (build/reconcile)
1. /spec                  — define desired state (plan/spec)
2. /full-stack-pipeline   — build the feature (build/full-stack-pipeline)
3. /dev-cluster           — test locally in Kind (build/dev-cluster)
4. /pr-test               — deploy PR to OpenShift (test/pr-test)
5. /deploy-cluster        — ship to production (deploy/deploy-cluster)
```

`/reconcile` is the top-level entrypoint. It reads `skills/RECONCILE.md` for checkpoint
state (coverage summary, gap table, wave plan), then executes waves to close gaps.
Idempotent: safe to run repeatedly. See `skills/RECONCILE.md` for current spec coverage
and the full gap table. Use individual skills for targeted work.

Support skills available at any point:
- `/acp-review-guidance` — PR review checklist
- `/pr-fixer` — auto-fix PR from review comments
- `/align` — convention health check
- `/memory` — project memory management

## Commands

```shell
make build-all                # Build all container images
make deploy                   # Deploy to cluster
make test-all                 # Run all tests
make lint                     # Lint code
make kind-up                  # Start local Kind cluster
make kind-rebuild              # Rebuild images + redeploy to running cluster
make kind-login                # Set kubectl context + configure acpctl
make dev-bootstrap             # Bootstrap developer workspace
make benchmark                # Run component benchmark harness
```

### Per-Component

```shell
# Control Plane (Go)
cd components/ambient-control-plane && gofmt -l . && go vet ./... && golangci-lint run

# API Server (Go)
cd components/ambient-api-server && gofmt -l . && go vet ./... && golangci-lint run

# Runner (Python)
cd components/runners/ambient-runner && uv venv && uv pip install -e .

# Docs
cd docs && npm run dev  # http://localhost:4321
```

### Benchmarking

```shell
# Human-friendly summary
make benchmark

# Agent / automation friendly output
make benchmark FORMAT=tsv

# Single component
make benchmark COMPONENT=ambient-control-plane MODE=cold
```

Benchmark notes:

- `FORMAT=tsv` is preferred for agents to minimize token usage
- `warm` measures rebuild proxies, not browser-observed hot reload latency
- See `scripts/benchmarks/README.md` for semantics and caveats

## Local Development SSO

`make kind-up` automatically configures Keycloak with OpenID Connect authentication:

**Default users:**
- Developer: `developer` / `developer` (ambient-users group)
- Admin: `admin` / `admin` (ambient-users, ambient-admins groups)

**Access URLs** (fixed ports, overridable via Make variables):
- Frontend: `http://localhost:14080`
- Keycloak admin: `http://localhost:11880` (admin/admin)
- API Server: `http://localhost:13080`

Run `make kind-status` to see ports.

**How it works:**
- `scripts/setup-kind-sso.sh` runs during `kind-up` to patch `sso-credentials` secret with port-specific URLs
- UI uses **dual-issuer pattern**: fetches OIDC from backend (cluster DNS), rewrites browser URLs to frontend (localhost)
- Each worktree gets deterministic unique ports to avoid conflicts

**Troubleshooting:**
- Login redirects fail → Verify port forwards: `make kind-port-forward`
- Token exchange fails → Check UI logs: `kubectl logs -l app=ambient-ui -n ambient-code`
- Realm not found → Wait for Keycloak: `kubectl get pods -l app=keycloak -n ambient-code`

## Critical Conventions

Cross-cutting rules that apply across ALL components. Component-specific conventions live in
[specs/standards/](specs/standards/) (see [BOOKMARKS.md](BOOKMARKS.md) > Component Standards).

- **User token auth required**: All user-facing API ops use `GetK8sClientsForRequest(c)`, never the backend service account
- **No tokens in logs/errors/responses**: Use `len(token)` for logging, generic messages to users
- **OwnerReferences on all child resources**: Jobs, Secrets, PVCs must have controller owner refs
- **No `panic()` in production**: Return explicit `fmt.Errorf` with context
- **No `any` types in frontend**: Use proper types, `unknown`, or generic constraints
- **Feature flags strongly recommended**: Gate new features behind Unleash flags. Use `/unleash-flag` to set up
- **PostgreSQL for persistent storage**: Sessions, projects, and settings live in the API server's database. For new persistent storage, confirm with the user whether to use repo files or PostgreSQL
- **Conventional commits**: Squashed on merge to `main`
- **Design for extensibility before adding items**: When building infrastructure that will have
  things added to it (menus, config schemas, API surfaces), build the extensibility mechanism
  first — conditional rendering, feature-flag gating, discovery. Retrofitting causes rework.
- **Verify contracts and references**: Before building on an assumption (env var exists, path is
  correct, URL is reachable), verify the contract. After moving anything, grep scripts, workflows,
  manifests, and configs — not just source code.
- **CI/CD security**: Never use `pull_request_target` (grants write access to forked PR code).
  Never hardcode tokens — use `actions/create-github-app-token`. For automated pipelines:
  discovery → validation → PR → auto-merge.
- **Full-stack awareness**: Before building a new pipeline, check if an existing one can be
  reused. Auth/credential/API changes must update ALL consumers (backend, CLI, SDK, runner,
  sidecar) in the same PR.
- **Separate configuration from code**: Config changes must not require code changes. Externalize
  via env vars, ConfigMaps, manifests, or feature flags. If a value varies across environments
  or changes over time, it's config, not code.
- **Image references must match across the stack**: After changing an image name or tag, grep all overlays, workflows, and ConfigMaps
- **Reconcile, don't create-or-skip**: Use update-or-create patterns, not create-and-ignore-`AlreadyExists`
- **Never silently swallow partial failures**: Every error path must propagate or be collected, not discarded
- **Namespace-scope shared state keys**: Cache keys and status entries must include namespace/project prefix
- **Restricted SecurityContext on all containers**: `runAsNonRoot`, drop `ALL` capabilities, `readOnlyRootFilesystem`

Component-specific conventions:
- Control Plane: [conventions](specs/standards/control-plane/conventions.spec.md)
- Security: [security standards](specs/standards/security/security.spec.md)

## Pre-commit Hooks

Configured in `.pre-commit-config.yaml`. Install: `make setup-hooks`. Run all: `make lint`.

- Go lint wrappers (`scripts/pre-commit/`) skip gracefully if the toolchain is not installed
- `tsc --noEmit` and `npm run build` are **not** in pre-commit (slow; CI gates on them)
- Branch/push protection blocks commits and pushes to main/master/production

## PR Review Gate

Before running `gh pr create`, agents MUST self-review their changes:

1. Review the diff against conventions in this file and [BOOKMARKS.md](BOOKMARKS.md)
2. Verify the changes follow patterns documented in `specs/standards/`
3. Check that no `panic()` calls exist in production Go code (use `fmt.Errorf`)
4. Check that no `any` types exist in frontend TypeScript (use proper types, `unknown`, or generics)
5. Ensure all new API endpoints have corresponding frontend proxy routes
6. Verify owner references on any new K8s child resources

A PreToolUse hook (`scripts/hooks/pr-review-gate.sh`) enforces mechanical checks (lint, format, secrets) and runs `coderabbit review --agent --base main` for AI-powered review (security, performance, K8s safety per `.coderabbit.yaml`). The hook will block `gh pr create` if any check fails. The self-review above covers what the hook cannot — architectural fit, convention adherence, and design quality.

When both the self-review and the hook pass, apply the `ambient-code:self-reviewed` label to the PR if the changes were authored and reviewed without human involvement.

## Testing

- **Runner tests**: `cd components/runners/ambient-runner && python -m pytest tests/`

## Convention Authority
