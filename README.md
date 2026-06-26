# Agent Control Plane

[![Lint](https://github.com/openshift-online/agent-control-plane/actions/workflows/lint.yml/badge.svg)](https://github.com/openshift-online/agent-control-plane/actions/workflows/lint.yml)
[![Unit Tests](https://github.com/openshift-online/agent-control-plane/actions/workflows/unit-tests.yml/badge.svg)](https://github.com/openshift-online/agent-control-plane/actions/workflows/unit-tests.yml)
[![Docs](https://github.com/openshift-online/agent-control-plane/actions/workflows/docs.yml/badge.svg)](https://openshift-online.github.io/agent-control-plane/)

> AI automation platform for orchestrating agentic sessions on Kubernetes

## Overview

The Agent Control Plane (ACP) lets teams create and manage AI agentic sessions - automated tasks that clone repos, run AI agents, and push results. Sessions are stored in PostgreSQL and reconciled into Kubernetes pods via gRPC.

### Key Capabilities

- **Agentic Sessions**: AI-powered automation for code review, bug fixes, research, and development tasks
- **Multi-Agent Workflows**: Specialized AI agents with configurable prompts, models, and repos
- **Git Provider Support**: GitHub and GitLab (SaaS and self-hosted) via credential sidecars
- **Kubernetes Execution**: Sessions run as pods with RBAC, resource limits, and namespace isolation
- **CLI and SDK**: `acpctl` CLI and generated SDKs (Go, Python, TypeScript) for automation

## Quick Start

```bash
make kind-up
make kind-port-forward   # ports shown in output
```

See [CONTRIBUTING.md](CONTRIBUTING.md#local-development-setup) for full local development setup.

### OpenShell Gateway Mode (Kind)

When running with `OPENSHELL_USE_GATEWAY=true`, the control plane delegates sandbox creation to an OpenShell gateway instead of creating pods directly.

```bash
make kind-up OPENSHELL_USE_GATEWAY=true
```

This automatically installs all prerequisites: the tenant namespace, the [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) CRD (v0.4.6), and the [OpenShell gateway Helm chart](https://github.com/NVIDIA/OpenShell/tree/main/deploy/helm/openshell). It also patches the control plane deployment with `OPENSHELL_USE_GATEWAY=true`.

Override defaults with:

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENSHELL_TENANT_NAMESPACE` | `tenant` | Namespace for the gateway and sandboxes |
| `AGENT_SANDBOX_VERSION` | `v0.4.6` | Agent Sandbox CRD release (must match gateway API version) |

After the sandbox reaches Ready, the control plane executes commands inside it via the `ExecSandbox` gRPC RPC — the runner starts through exec, not the container entrypoint.

See [OpenShell Sandbox Provisioning Spec](specs/platform/openshell-sandbox-provisioning.spec.md) for full details on gateway mode, CRD version compatibility, and configuration.

## Architecture

| Component | Technology | Description |
|-----------|------------|-------------|
| **API Server** (`ambient-api-server`) | Go + rh-trex-ai | REST + gRPC API, PostgreSQL-backed. Source of truth. |
| **Control Plane** (`ambient-control-plane`) | Go | Watches API server via gRPC streams, creates K8s pods |
| **UI** (`ambient-ui`) | NextJS + Shadcn | Web interface for managing sessions and agents |
| **Runner** (`ambient-runner`) | Python | Executes AI agents inside pods (Claude, Gemini, LangGraph bridges) |
| **MCP Server** (`ambient-mcp`) | Go | MCP tool definitions, deployed as credential sidecars |

```
User Creates Session → API Server Persists to DB → Control Plane Creates Pod →
Runner Executes AI Agent → Results Stream to API Server → UI Displays Progress
```

## Documentation

- **[Documentation site](https://openshift-online.github.io/agent-control-plane/)** - user-facing docs (Astro Starlight)
- **[docs/internal/](docs/internal/)** - developer and architecture docs
- **[CLAUDE.md](CLAUDE.md)** - development standards and conventions
- **[BOOKMARKS.md](BOOKMARKS.md)** - developer reference index

## Components

- [API Server](components/ambient-api-server/) - REST + gRPC API (rh-trex-ai, PostgreSQL)
- [Control Plane](components/ambient-control-plane/) - gRPC-driven session reconciler
- [UI](components/ambient-ui/) - NextJS web application
- [Runner](components/runners/ambient-runner/) - AI agent execution
- [MCP Server](components/ambient-mcp/) - MCP tool integration
- [CLI](components/ambient-cli/) - `acpctl` command-line tool
- [SDK](components/ambient-sdk/) - generated from the OpenAPI spec (Go, Python, TypeScript)
- [Manifests](components/manifests/) - Kustomize deployment resources

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines, code standards, and local development setup.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
