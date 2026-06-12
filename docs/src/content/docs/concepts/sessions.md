---
title: "Sessions"
---

A session is one run of an agent. It is stored by the API server, reconciled by the control plane, and executed by a Kubernetes runner Pod.

## What a session contains

A session can include:

- `project_id`: the project boundary for auth, settings, credentials, and namespace selection.
- `agent_id`: optional reusable agent definition.
- `prompt`: the task for this run.
- `repo_url` or `repos`: Git repositories to clone into the runner workspace.
- `workflow_id`: optional workflow configuration stored as JSON.
- model settings such as `llm_model`, `llm_temperature`, and `llm_max_tokens`.
- runtime settings such as `timeout`, labels, annotations, environment variables, and resource overrides.
- status fields such as `phase`, `start_time`, `completion_time`, `conditions`, and `kube_namespace`.

The API path is `/api/ambient/v1/sessions`.

## Lifecycle

Common phases are:

| Phase | Meaning |
| --- | --- |
| `Pending` | The session should run and is waiting for reconciliation. |
| `Creating` | Kubernetes resources are being created or runner setup is in progress. |
| `Running` | The runner Pod is available and processing work. |
| `Stopping` | The control plane should remove runner resources. |
| `Stopped` | The run was stopped. |
| `Completed` | The run finished successfully. |
| `Failed` | The run failed. |

Creating a session does not have to start it. `POST /sessions/{id}/start` transitions an empty, stopped, failed, or completed session to `Pending`. `POST /sessions/{id}/stop` transitions an active session to `Stopping`.

## What the control plane creates

For a pending session, the control plane:

- verifies the project exists through the generated SDK client.
- provisions or resolves the project namespace.
- creates a session ServiceAccount.
- resolves visible credentials from global, project, and agent bindings.
- creates the runner Pod and a Service that exposes the runner's AG-UI port.
- optionally injects the platform MCP sidecar and credential MCP sidecars.
- updates the session status with the Kubernetes namespace and running phase.

The control plane creates Pods, not Jobs, and it does not watch a session CRD as the source of truth.

## Messages

Session messages are stored at `/api/ambient/v1/sessions/{id}/messages`.

```bash
acpctl session messages <session-id>
acpctl session messages <session-id> -f
acpctl session send <session-id> "Use the smaller fix." -f
```

The messages endpoint supports normal JSON listing and Server-Sent Events when the request accepts `text/event-stream`.

## Runner-backed endpoints

While the runner Pod is reachable, the API server proxies operational endpoints for:

- AG-UI events, run, interrupt, feedback, tasks, and capabilities.
- workspace and file operations.
- Git status, remote configuration, and branch listing.
- repository add/remove/status operations.
- workflow metadata.
- MCP status.

If the runner is not running or cannot be reached, these endpoints may return fallback data or an error depending on the endpoint.

## Agent starts

Starting an agent is different from directly starting a session. `POST /projects/{id}/agents/{agent_id}/start` is idempotent:

- if the agent has an active session, the API returns that session.
- otherwise it creates a new session, builds a start prompt from project context, agent prompt, peer agents, unread inbox messages, and the run prompt, then starts the session.

Use agents when the same role should run repeatedly.

## Clone and export

The sessions plugin exposes clone and export endpoints. Clone copies the source session configuration into a new session with `parent_session_id`; it does not copy messages or automatically start the clone. Export returns a JSON envelope with session metadata, export time, and version.
