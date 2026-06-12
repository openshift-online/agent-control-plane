---
title: "Architecture"
---

ACP is a PostgreSQL-backed REST API with a Kubernetes control plane. The API server is the source of truth; the control plane watches it over gRPC and reconciles session state into Kubernetes runner Pods.

## Session flow

```text
User
  -> UI / CLI / SDK / MCP
  -> ambient-api-server REST API
  -> PostgreSQL
  -> ambient-control-plane gRPC watch
  -> Kubernetes Pod, Service, ServiceAccount, and sidecars
  -> runner AG-UI server
  -> API server message/status/event paths
  -> UI / CLI / SDK / MCP
```

## API server

`components/ambient-api-server` is a Go service built on rh-trex-ai. It stores persistent state in PostgreSQL and exposes REST endpoints under `/api/ambient/v1/...`.

The base Deployment runs:

- REST API on port `8000`.
- gRPC on port `9000`.
- metrics on port `4433`.
- health checks on port `4434`.
- database migrations in an init container.

Important resources include projects, project settings, sessions, session messages, agents, inbox messages, credentials, roles, role bindings, users, and scheduled-session records.

## Control plane

`components/ambient-control-plane` is a Go service, not a controller-runtime operator. It loads configuration from environment variables, connects to the API server, opens gRPC watch streams, and registers handlers for projects, project settings, and sessions.

In kube mode, session reconciliation creates:

- project namespace infrastructure.
- a session ServiceAccount.
- credential token-reader bindings when needed.
- the runner Pod.
- a Service exposing the runner AG-UI port.
- optional platform MCP and credential MCP sidecars.

Important config includes:

- `AMBIENT_API_SERVER_URL`
- `AMBIENT_GRPC_SERVER_ADDR`
- `AMBIENT_GRPC_USE_TLS`
- `MODE`
- `RECONCILERS`
- `RUNNER_IMAGE`
- `MCP_IMAGE`
- `CP_TOKEN_URL`
- `CP_RUNTIME_NAMESPACE`

## Runner

`components/runners/ambient-runner` is a Python FastAPI AG-UI server. `RUNNER_TYPE` chooses the bridge:

| `RUNNER_TYPE` | Bridge |
| --- | --- |
| `claude-agent-sdk` | Claude Agent SDK |
| `gemini-cli` | Gemini CLI |
| `langgraph` | LangGraph |

The runner exposes run, interrupt, events, model, capabilities, feedback, repository, workflow, file, Git, task, and MCP status endpoints. It works in `/workspace` and uses `/workspace/repos`, `/workspace/workflows`, `/workspace/artifacts`, and `/workspace/file-uploads`.

## UI

`components/ambient-ui` is the Next.js frontend. It uses Shadcn components and React Query. It talks to ACP through UI API routes and forwards bearer-token identity to the API server.

## CLI and SDKs

`acpctl` uses generated SDK clients to manage projects, credentials, agents, sessions, scheduled-session records, inbox messages, and generic resources. The Go, Python, and TypeScript SDKs are generated from the OpenAPI spec.

## MCP

`components/ambient-mcp` is a Go MCP server with stdio and SSE transports. It calls the same REST API as other clients and can be run as a sidecar with control-plane token exchange.

## What ACP is not

- It is not a CRD-backed application database.
- It does not reconcile sessions from Kubernetes custom resources.
- It does not create Kubernetes Jobs for sessions in the current control plane.
- Scheduled-session automatic execution is not implemented in the current API service.
