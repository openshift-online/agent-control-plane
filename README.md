# Agent Control Plane

[![Lint](https://github.com/openshift-online/agent-control-plane/actions/workflows/lint.yml/badge.svg)](https://github.com/openshift-online/agent-control-plane/actions/workflows/lint.yml)
[![Unit Tests](https://github.com/openshift-online/agent-control-plane/actions/workflows/unit-tests.yml/badge.svg)](https://github.com/openshift-online/agent-control-plane/actions/workflows/unit-tests.yml)
[![Docs](https://github.com/openshift-online/agent-control-plane/actions/workflows/docs.yml/badge.svg)](https://openshift-online.github.io/agent-control-plane/)

> Kubernetes-native AI automation platform for orchestrating agentic sessions through containerized microservices

## Overview

The Agent Control Plane (ACP) lets teams create and manage AI agentic sessions — automated tasks that clone repos, run AI agents, and push results. Sessions are stored in PostgreSQL and reconciled into Kubernetes Jobs via gRPC watch streams.

### Key Capabilities

- **Agentic Sessions**: AI-powered automation for code review, bug fixes, research, and development tasks
- **Multi-Agent Workflows**: Agents organized in projects with inter-agent messaging via persistent inbox queues
- **Scheduled Sessions**: Cron-based recurring agent triggers with overlap policies and timezone support
- **GitOps Fleet Management**: Argo CD-style Applications that continuously sync agent fleet definitions from git repositories
- **AG-UI Event Streaming**: Real-time event streaming via the [AG-UI protocol](https://github.com/anthropics/ag-ui) with dual APIs (human-readable Messages API + comprehensive Events API with compression)
- **Credential Provider Support**: GitHub, GitLab, Jira, Google, Vertex AI, and Kubeconfig via isolated credential sidecars
- **SSO Authentication**: OpenID Connect with Red Hat SSO / Keycloak, BFF token relay, and Kubernetes user impersonation
- **RBAC**: Scope-aware authorization (global, project, agent, session, credential) with role bindings and permission matrix
- **Sandbox Isolation**: OpenShell-based defense-in-depth (network namespace, TLS proxy, Landlock, seccomp-BPF, OPA policy) for runner pods
- **CLI and SDK**: `acpctl` CLI and generated SDKs (Go, Python, TypeScript) for automation
- **MCP Integration**: Model Context Protocol server exposing platform resources as tools, deployed as sidecar or public endpoint

## Quick Start

```bash
make kind-up
make kind-port-forward           # ports shown in output
make kind-setup-openshell-cli    # optional: port-forward to OpenShell gateways
```

Once the cluster is running, see [examples/README.md](examples/README.md) to deploy starter agents and vTeam lab environments.

See [CONTRIBUTING.md](CONTRIBUTING.md#local-development-setup) for full local development setup.

### OpenShell Gateway (Kind)

The control plane delegates sandbox creation to an OpenShell gateway by default. `make kind-up` automatically installs all prerequisites: the tenant namespace, and the [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) CRD (v0.4.6). ACP will automatically install configuration similar to the [OpenShell gateway Helm chart](https://github.com/NVIDIA/OpenShell/tree/main/deploy/helm/openshell) when it is configured to manage a namespace.

Override defaults with:

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENSHELL_TENANT_NAMESPACE` | `tenant` | Namespace for the gateway and sandboxes |
| `AGENT_SANDBOX_VERSION` | `v0.4.6` | Agent Sandbox CRD release (must match gateway API version) |

After the sandbox reaches Ready, the control plane executes commands inside it via the `ExecSandbox` gRPC RPC — the runner starts through exec, not the container entrypoint.

See [OpenShell Sandbox Provisioning Spec](specs/platform/openshell-sandbox-provisioning.spec.md) for full details on gateway mode, CRD version compatibility, and configuration.

## vTeam Lab

The [examples/](examples/) directory contains starter agents and multi-agent virtual team definitions. See the [examples README](examples/README.md) for prerequisites, tenant setup, and the full vTeam catalog.

## Architecture

```
User Creates Session → API Server Persists to DB → Control Plane Creates Pod →
Runner Executes AI Agent → Results Stream to API Server → UI Displays Progress
```

### Components

| Component | Technology | Description |
|-----------|------------|-------------|
| **API Server** (`ambient-api-server`) | Go + rh-trex-ai | REST + gRPC API, PostgreSQL-backed. Source of truth for all platform state. |
| **Control Plane** (`ambient-control-plane`) | Go | Watches API server via gRPC streams, reconciles sessions into K8s Jobs, manages gateway provisioning |
| **UI** (`ambient-ui`) | NextJS + Shadcn | BFF-pattern web application with OIDC authentication for session management and agent authoring |
| **Runner** (`ambient-runner`) | Python + FastAPI | Executes AI agents inside pods; bridges AG-UI protocol to gRPC message store |
| **MCP Server** (`ambient-mcp`) | Go | MCP tool definitions for platform resources, deployed as credential sidecar or public API endpoint |
| **CLI** (`ambient-cli`) | Go | `acpctl` command-line tool with declarative `apply -f/-k` for fleet management |
| **SDK** (`ambient-sdk`) | Go, Python, TypeScript | Generated from the OpenAPI spec |
| **Credential Sidecars** | Per-provider containers | Isolated credential containers for GitHub, GitLab, Jira, Google, Kubernetes |
| **Manifests** | Kustomize | Deployment manifests with base and overlay structure |

### Data Model

The core domain model stored in PostgreSQL:

- **Project** — workspace grouping agents with shared context prompt
- **Agent** — project-scoped, mutable definition with configurable prompt, LLM model, repo, and sandbox settings
- **Session** — ephemeral Kubernetes execution run, created via agent start (one active per agent)
- **SessionMessage** — human-readable conversation summary (Messages API)
- **SessionEvent** — comprehensive AG-UI event stream with compression (Events API)
- **Inbox** — persistent message queue on agents, surviving across sessions
- **Credential** — global encrypted secret store for external provider tokens (GitHub, GitLab, Jira, Google, Vertex AI, Kubeconfig)
- **RoleBinding** — scope-aware RBAC binding (global, project, agent, session, credential)
- **ScheduledSession** — project-scoped cron trigger for recurring agent runs
- **Application** — GitOps binding that syncs agent fleet definitions from git (Argo CD pattern)

See [Data Model Spec](specs/platform/data-model.spec.md) for the full entity relationship diagram and field reference.

### Runner Bridges

The runner uses a bridge abstraction (`PlatformBridge` ABC) to support multiple AI backends:

| Bridge | Status | Description |
|--------|--------|-------------|
| `ClaudeBridge` | Production | Claude Code CLI via Claude Agent SDK subprocess |
| `GeminiCLIBridge` | Implemented | Gemini CLI bridge |
| `LangGraphBridge` | Stub | LangGraph bridge |

### Security

- **Identity Boundaries**: Six identity types — control plane SA, per-session SAs, user SSO tokens, global credentials, project-scoped build agents, pipeline SAs
- **SSO Authentication**: OIDC with Keycloak/Red Hat SSO, JWT validation, BFF token relay
- **RBAC Enforcement**: Scope-aware authorization on all API endpoints (HTTP and gRPC)
- **Credential Encryption**: AES-256-GCM at rest for all credential tokens in PostgreSQL
- **Credential Isolation**: Integration credentials confined to sidecar containers; runner never holds external provider tokens
- **Sandbox Isolation**: Five defense-in-depth layers via OpenShell Supervisor (network namespace, TLS proxy, Landlock LSM, seccomp-BPF, OPA policy)

See [Security Spec](specs/security/) for full details.

## Documentation

- **[Documentation site](https://openshift-online.github.io/agent-control-plane/)** — user-facing docs (Astro Starlight)
- **[docs/internal/](docs/internal/)** — developer and architecture docs
- **[CLAUDE.md](CLAUDE.md)** — development standards and conventions
- **[BOOKMARKS.md](BOOKMARKS.md)** — developer reference index
- **[specs/](specs/)** — desired state specifications (platform, security, UI, standards)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines, code standards, and local development setup.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
