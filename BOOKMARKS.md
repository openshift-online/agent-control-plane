# Bookmarks

Progressive disclosure for task-specific documentation and references.

## Table of Contents

- [Specs](#specs)
- [Standards](#standards)
- [Governance](#governance)
- [Architecture Decisions](#architecture-decisions)
- [Component Guides](#component-guides)
- [Development Environment](#development-environment)
- [Testing](#testing)
- [Observability](#observability)
- [Design Documents](#design-documents)
- [Dependency Automation](#dependency-automation)
- [Amber Automation](#amber-automation)

---

## Specs

Desired state of the system. Three consolidated specs plus engineering standards.

| Spec | Covers |
|------|--------|
| [Platform](specs/platform/) | Data model, API, CLI, control plane, runner, MCP server |
| [Security](specs/security/) | Identity boundaries, SSO, RBAC, credential binding/encryption, sandbox |
| [UI](specs/ui/) | Operations dashboard, agent authoring, annotations, live preview |
| [Spec Index](specs/index.spec.md) | Bookmark page for all spec domains |

## Standards

Component-specific conventions loaded by review agents on demand.

| Standard | Domain | Scope |
|----------|--------|-------|
| [Operator Conventions](specs/standards/control-plane/conventions.spec.md) | control-plane | OwnerReferences, reconciliation patterns, SecurityContext, resource limits |
| [Security Standards](specs/standards/security/security.spec.md) | security | Auth flows, RBAC, token handling, container security |
| [Cross-Cutting Conventions](specs/standards/platform/cross-cutting.spec.md) | platform | Image consistency, reconciliation, error propagation, namespace-scoped keys |

## Governance

| Document | Purpose |
|----------|---------|
| Runner Constitution | Version pinning, automated freshness, image discipline, schema sync, bridge modularity (now in [platform/runner-constitution.md](specs/platform/runner-constitution.md)) |
| [SDD Preflight](.github/workflows/sdd-preflight.yml) | CI workflow enforcing constitution compliance on PRs |

## Architecture Decisions

| ADR | Decision |
|-----|----------|
| [ADR-0001](docs/internal/adr/0001-kubernetes-native-architecture.md) | CRDs, operators, and Job-based execution over traditional API |
| [ADR-0002](docs/internal/adr/0002-user-token-authentication.md) | User tokens for API ops instead of service accounts |
| [ADR-0003](docs/internal/adr/0003-multi-repo-support.md) | Multi-repository support in a single session |
| [ADR-0004](docs/internal/adr/0004-go-backend-python-runner.md) | Go for backend/operator, Python for runner |
| [ADR-0005](docs/internal/adr/0005-nextjs-shadcn-react-query.md) | NextJS + Shadcn + React Query frontend stack |
| [ADR-0006](docs/internal/adr/0006-ambient-runner-sdk-architecture.md) | Runner SDK design and architecture |
| [ADR-0007](docs/internal/adr/0007-unleash-feature-flags.md) | Unleash with workspace-scoped overrides |
| [ADR-0008](docs/internal/adr/0008-automate-code-reviews.md) | Automated inner-loop code review |
| [ADR-0009](docs/internal/adr/0009-rest-api-postgresql-trex-foundation.md) | REST API + PostgreSQL via rh-trex-ai |

## Component Guides

| Guide | Purpose |
|-------|---------|
| [Control Plane](components/ambient-control-plane/) | Kubernetes controller, reconciliation loop |
| [Runner README](components/runners/ambient-runner/README.md) | Python runner, Claude Code SDK integration |
| [API Server Guide](components/ambient-api-server/CLAUDE.md) | rh-trex-ai REST API, plugin system, code generation |
| [SDK Guide](components/ambient-sdk/CLAUDE.md) | Go + Python client libraries for the public API |
| [CLI README](components/ambient-cli/README.md) | acpctl CLI for managing agentic sessions |
| [CodeRabbit Integration](docs/src/content/docs/features/coderabbit.md) | Setup, review gate, session credentials, `.coderabbit.yaml` config |

## Development Environment

| Guide | Purpose |
|-------|---------|
| [Kind](docs/internal/developer/local-development/kind.md) | Recommended local dev setup (Kubernetes in Docker) |
| [OpenShift](docs/internal/developer/local-development/openshift.md) | OpenShift Local (CRC) setup for OCP-specific features |
| [Hybrid](docs/internal/developer/local-development/hybrid.md) | Run components locally with breakpoint debugging |
| [Manifests](components/manifests/README.md) | Kustomize overlay structure and deployment |

## Testing

| Guide | Purpose |
|-------|---------|
| [E2E Testing Guide](docs/internal/testing/e2e-guide.md) | Writing and running Cypress E2E tests |

## Observability

| Guide | Purpose |
|-------|---------|
| [Overview](docs/internal/observability/README.md) | Monitoring, metrics, and tracing architecture |
| [Langfuse](docs/internal/observability/observability-langfuse.md) | LLM tracing with privacy-preserving defaults |
| [Operator Metrics](docs/internal/observability/operator-metrics-visualization.md) | Grafana dashboards for operator metrics |

## Design Documents

| Document | Purpose |
|----------|---------|
| [Agent Runtime Registry](docs/internal/design/agent-runtime-registry-plan.md) | Agent runtime registry architecture |
| [CLI Runners](docs/internal/design/cli-runners-plan.md) | CLI runner design and implementation |

## Dependency Automation

| Resource | Purpose |
|----------|---------|
| [SDK Version Bump Workflow](.github/workflows/sdk-version-bump.yml) | Daily check for claude-agent-sdk + anthropic updates, auto-PR |
| [SDK Version Bump Script](scripts/sdk-version-bump.py) | PyPI version check, pyproject.toml update, changelog fetch |
| [SDK Feature Report Generator](scripts/sdk_report.py) | Parse release notes into structured feature data |

## Amber Automation

| Resource | Purpose |
|----------|---------|
| [Amber Config](.claude/amber-config.yml) | Automation policies and label mappings |
