---
title: "Contributing"
---

This repository contains the API server, control plane, UI, runner, CLI, SDKs, MCP server, credential sidecars, manifests, docs, specs, and workflows for ACP.

## Main components

| Component | Path | Stack |
| --- | --- | --- |
| API server | `components/ambient-api-server` | Go, rh-trex-ai, PostgreSQL, REST, gRPC |
| Control plane | `components/ambient-control-plane` | Go, Kubernetes client, gRPC watches |
| UI | `components/ambient-ui` | Next.js, Shadcn, React Query |
| Runner | `components/runners/ambient-runner` | Python, FastAPI, AG-UI bridges |
| CLI | `components/ambient-cli` | Go, generated SDK |
| SDKs | `components/ambient-sdk` | Generated Go, Python, TypeScript |
| MCP server | `components/ambient-mcp` | Go, mark3labs/mcp-go |
| Manifests | `components/manifests` | Kustomize |

## Common commands

```bash
make dev-bootstrap
make kind-up
make kind-login
make kind-rebuild
make test-all
make lint
make benchmark
```

For benchmark output that is easier for automation to parse:

```bash
make benchmark FORMAT=tsv
make benchmark COMPONENT=ambient-control-plane MODE=cold
```

## Component checks

```bash
cd components/ambient-api-server
gofmt -l .
go vet ./...
golangci-lint run

cd components/ambient-control-plane
gofmt -l .
go vet ./...
golangci-lint run

cd components/runners/ambient-runner
python -m pytest tests/

cd docs
npm run dev
```

## Development rules that matter

- PostgreSQL is the source of truth for projects, agents, sessions, credentials, and settings.
- The control plane watches the API server over gRPC and creates Kubernetes Pods, not Jobs.
- Do not introduce CRDs as the persistent data model.
- User-facing API operations must use user-scoped auth.
- Never log, return, or echo tokens.
- Do not use `panic()` in production Go code.
- Do not use `any` in frontend TypeScript.
- New Kubernetes child resources need owner references where applicable.
- Containers must use restricted security contexts.
- New persistent storage should be PostgreSQL unless the change explicitly calls for repo files.

## PR readiness

Before opening a PR:

1. Review the diff against `CLAUDE.md`, `BOOKMARKS.md`, and `specs/standards/`.
2. Check API, CLI, SDK, runner, UI, and manifest consumers when changing contracts.
3. Run targeted tests and formatting.
4. Confirm no secrets were added.
5. Confirm docs match implemented behavior.

The PR review hook runs mechanical checks and CodeRabbit review when the CLI is available.
