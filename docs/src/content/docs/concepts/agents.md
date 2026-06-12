---
title: "Agents"
---

An agent is a persistent AI configuration within a project. It defines who the AI is and how it behaves — the prompt, model, repo, workflow, and environment. Sessions are started from agents.

## What an agent contains

| Field | Purpose |
|-------|---------|
| `name` | Unique identifier within the project |
| `prompt` | System prompt defining the agent's role and behavior |
| `repo_url` | Git repository the agent works on |
| `llm_model` | Model to use (e.g. `claude-sonnet-4-20250514`) |
| `workflow_id` | Optional workflow to follow |
| `environment_variables` | Extra env vars injected into sessions |
| `resource_overrides` | CPU/memory limits for the runner pod |
| `bot_account_name` | Git identity for commits |

## Agent lifecycle

```
Create agent → Configure prompt/repo/model → Start agent → Session runs → Agent idle
                                                ↓
                                          Start again → New session
```

Agents belong to a project. Starting an agent creates a session that inherits the agent's configuration.

## API

```
GET    /api/ambient/v1/projects/{id}/agents
POST   /api/ambient/v1/projects/{id}/agents
GET    /api/ambient/v1/projects/{id}/agents/{agent_id}
PATCH  /api/ambient/v1/projects/{id}/agents/{agent_id}
DELETE /api/ambient/v1/projects/{id}/agents/{agent_id}
POST   /api/ambient/v1/projects/{id}/agents/{agent_id}/start
GET    /api/ambient/v1/projects/{id}/agents/{agent_id}/sessions
```

## CLI

```bash
acpctl agent list --project my-project
acpctl agent create --project my-project --name reviewer --prompt "Review PRs for security issues"
acpctl agent start --project my-project reviewer
```
