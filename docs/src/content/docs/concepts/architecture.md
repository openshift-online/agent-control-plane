---
title: "Architecture"
---

ACP is a Kubernetes-native platform that orchestrates AI agent sessions through a set of cooperating microservices. The API server holds all persistent state in PostgreSQL, the control plane watches for changes and reconciles them into Kubernetes resources, and the runner executes agent workloads inside sandboxed pods.

## Components

| Component | Role |
|-----------|------|
| **API Server** | REST and gRPC API backed by PostgreSQL. Source of truth for projects, agents, sessions, credentials, and RBAC. |
| **Control Plane** | Watches the API server over gRPC streams. When a session is created, it provisions the Kubernetes resources needed to run it. |
| **Runner** | Python process that executes the AI agent inside a pod. Bridges the AG-UI event protocol back to the API server. |
| **UI** | Next.js web application for managing projects, agents, and sessions. Authenticates users via OIDC and forwards identity to the API server. |
| **CLI** | `acpctl` command-line tool for managing resources, applying YAML definitions, and automating workflows. |
| **MCP Server** | Model Context Protocol server that exposes platform resources as tools, deployed as a sidecar or standalone endpoint. |
| **SDKs** | Generated Go, Python, and TypeScript clients for programmatic access to the API. |

## Session lifecycle

This is what happens when you start an agent session:

```
You (UI, CLI, SDK, or MCP)
  |
  v
API Server --- persists session to PostgreSQL
  |
  v
Control Plane --- detects new session via gRPC watch
  |
  v
Kubernetes --- creates namespace resources:
                - ServiceAccount for the session
                - Credential bindings and provider sidecars
                - Runner pod with the agent process
                - Service exposing the AG-UI port
  |
  v
Runner --- executes the AI agent inside the pod
  |
  v
API Server --- receives streamed messages, events, and status updates
  |
  v
You --- observe progress in real time (UI, CLI, SDK, or MCP)
```

1. You create a session through any client (UI, CLI, SDK, or MCP).
2. The API server stores the session in PostgreSQL and emits a change event.
3. The control plane detects the event and provisions Kubernetes resources in the project namespace.
4. The runner pod starts, executes the AI agent, and streams results back through the API server.
5. You see messages and events as they arrive. Multiple users can watch the same session.

## Data model

ACP organizes resources in a hierarchy:

| Resource | Scope | Purpose |
|----------|-------|---------|
| **Project** | Global | Workspace for a team, with a shared context prompt and isolated namespace |
| **Agent** | Project | Definition of an AI agent -- prompt, model, providers, sandbox policy |
| **Session** | Project | A single execution run of an agent, with its messages and events |
| **Credential** | Global or project | Encrypted token for an external service (GitHub, Jira, Vertex AI) |
| **Provider** | Project | Binds a credential to an agent so it can reach an external service |
| **Gateway** | Project | OpenShell proxy that manages sandbox creation and network policy |
| **Scheduled Session** | Project | Cron-based trigger for recurring agent runs |
| **Application** | Project | GitOps binding that syncs agent definitions from a git repository |

## How access works

ACP uses OpenID Connect (OIDC) for authentication and scope-aware RBAC for authorization. When you log in through the UI, your identity token is forwarded to the API server on every request. The API server checks your role bindings to determine what you can see and do.

| Scope | What it controls |
|-------|-----------------|
| Global | Platform-wide operations (create projects, manage global credentials) |
| Project | All resources within a project |
| Agent | Operations on a specific agent and its sessions |
| Session | Read or interact with a specific session |
| Credential | Access to a specific credential record |

## Sandbox execution

Agent code does not run directly on the cluster. Each session runs inside an OpenShell sandbox -- an isolated environment with controlled filesystem and network access. The sandbox is created by a gateway deployed in the project namespace.

The sandbox provides five layers of isolation:

- **Network namespace** -- the agent can only reach endpoints allowed by its sandbox policy.
- **TLS proxy** -- all outbound connections are inspected and controlled.
- **Landlock LSM** -- kernel-level filesystem access restriction.
- **seccomp-BPF** -- system call filtering.
- **OPA policy** -- runtime policy enforcement.

Credentials are injected into sidecar containers, not the agent process. The agent uses MCP tools to interact with external services, and the sidecar handles authentication transparently.

## Runner bridges

The runner supports multiple AI backends through a bridge abstraction:

| Bridge | Backend |
|--------|---------|
| `claude-agent-sdk` | Claude via the Agent SDK |
| `gemini-cli` | Gemini CLI |
| `langgraph` | LangGraph |

The bridge is selected by the agent definition. All bridges expose the same AG-UI event protocol, so the rest of the platform works the same regardless of which AI backend is used.

## API paths

All API endpoints are served under:

```
/api/ambient/v1/projects
/api/ambient/v1/projects/{id}/agents
/api/ambient/v1/projects/{id}/sessions
/api/ambient/v1/credentials
```

The gRPC watch interface is available on port `9000` for control plane synchronization.
