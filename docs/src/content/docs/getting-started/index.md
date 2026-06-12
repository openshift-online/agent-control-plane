---
title: "What is ACP?"
---

Agent Control Plane (ACP) is a Kubernetes-native platform for running AI agents as isolated, observable sessions. A developer describes the work, ACP stores the request in PostgreSQL, the control plane sees the change over gRPC, and Kubernetes runs a dedicated runner Pod for the session.

The platform is built for developer automation: code fixes, repo analysis, issue triage, project agents, and repeatable workflows. It gives agents project context and credentials without making Kubernetes CRDs the source of truth.

## How work runs

1. A user, script, or MCP client creates a project, agent, or session through `/api/ambient/v1/...`.
2. The API server persists the resource in PostgreSQL and emits watch events.
3. The control plane watches the API server over gRPC and reconciles pending sessions.
4. For each runnable session, the control plane creates a Kubernetes Pod, Service, ServiceAccount, and any credential sidecars needed by that session.
5. The Python runner starts an AG-UI server, loads the configured bridge, clones repos or workflow context, and streams messages/events back through the API surface.

## Main resources

- **Projects** are the API object behind UI workspaces. They group agents, sessions, credentials, and settings.
- **Agents** are reusable project-scoped definitions with standing prompts and optional model/runtime settings.
- **Sessions** are individual runs. They have prompts, phases, messages, repo context, Kubernetes namespace metadata, and runner-facing endpoints.
- **Credentials** store external service tokens. Role bindings decide who or what can read the token.
- **Scheduled sessions** are API records for recurring work. The current service stores and manages schedule metadata; automatic execution is not wired in yet.

## Ways to use ACP

- Use the **web UI** for project setup, agents, sessions, credentials, chat, and session inspection.
- Use **`acpctl`** for terminal workflows, CI jobs, and automation scripts.
- Use the **REST API or generated SDKs** for application integration.
- Use the **MCP server** when another agent or MCP client should create sessions, inspect projects, or send messages.

## What you need

- An ACP deployment URL and a bearer token or SSO login.
- A project to work in.
- A Git credential if the agent needs private repositories.
- An agent prompt or one-off session prompt that says what done looks like.
