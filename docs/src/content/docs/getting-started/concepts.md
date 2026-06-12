---
title: "Core Concepts"
---

ACP is easiest to understand as a REST-backed control loop: users create project resources in the API server, and the control plane turns runnable session state into Kubernetes runner Pods.

## Projects

Projects are the top-level boundary for work. They group agents, sessions, credentials, project settings, role bindings, and project-wide prompt context. The UI may call them workspaces; the API, CLI, database, and control plane call them projects.

## Agents

Agents are reusable project-scoped definitions. An agent stores a name, prompt, optional model settings, optional repository/workflow defaults, labels, and annotations. Starting an agent creates a session or returns the existing active session for that agent.

## Sessions

Sessions are individual runs. A session stores the task prompt, project, optional agent, lifecycle phase, message log, repository context, model settings, and Kubernetes namespace metadata. Pending sessions are reconciled into runner Pods.

## Messages and events

Session messages are stored by the API server and can be listed or streamed with Server-Sent Events. Runner AG-UI events are proxied while the runner Pod is available.

## Credentials

Credentials are API records with a provider, token, URL, email, labels, and annotations. Token access is controlled by role bindings. The control plane resolves visible credentials for a session and passes them to the runner through sidecars or environment-based fallback.

## Workflows

Workflows are optional Git-backed instruction bundles. A session can reference a workflow repository and path; the runner clones it into `/workspace/workflows/...` and loads files such as `.ambient/ambient.json` and `.claude/commands` when present. MCP config is loaded from runner/project/session configuration, not automatically from a workflow-local `.mcp.json`.

## Context and artifacts

The runner works inside `/workspace`. Depending on session configuration, it uses `/workspace/repos`, `/workspace/workflows`, `/workspace/artifacts`, and `/workspace/file-uploads`. The API server exposes runner-backed endpoints for files, Git state, repository status, and workspace state while the runner is running.

## Scheduled sessions

Scheduled sessions are project-scoped records with cron, timezone, agent, prompt, timeout, and runner-type fields. The current API and CLI can create, update, suspend, resume, trigger, and list runs, but the service implementation does not yet enqueue automatic runs.

## Interfaces

- **UI:** interactive project, agent, credential, and session management.
- **`acpctl`:** terminal and CI automation.
- **REST API:** `/api/ambient/v1/...` on the API server.
- **SDKs:** Go, Python, and TypeScript clients generated from OpenAPI.
- **MCP:** tools for project, agent, session, message, label, and annotation operations.
