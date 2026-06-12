---
title: "Scheduled Sessions"
---

:::caution[Not yet automated]
Scheduled sessions are **CRUD-only** right now. You can create and manage schedule records, but nothing evaluates the cron expressions or starts sessions automatically. The `trigger` endpoint is a stub that returns success without creating a session. Use an external scheduler (GitHub Actions, CronJob) to call `acpctl agent start` on your own schedule until this is implemented.
:::

## API shape

Scheduled sessions live under projects:

```text
GET    /api/ambient/v1/projects/{id}/scheduled-sessions
POST   /api/ambient/v1/projects/{id}/scheduled-sessions
GET    /api/ambient/v1/projects/{id}/scheduled-sessions/{ss_id}
PATCH  /api/ambient/v1/projects/{id}/scheduled-sessions/{ss_id}
DELETE /api/ambient/v1/projects/{id}/scheduled-sessions/{ss_id}
POST   /api/ambient/v1/projects/{id}/scheduled-sessions/{ss_id}/suspend
POST   /api/ambient/v1/projects/{id}/scheduled-sessions/{ss_id}/resume
POST   /api/ambient/v1/projects/{id}/scheduled-sessions/{ss_id}/trigger
GET    /api/ambient/v1/projects/{id}/scheduled-sessions/{ss_id}/runs
```

## Fields

Important fields are:

- `name`
- `description`
- `project_id`
- `agent_id`
- `schedule`
- `timezone`
- `enabled`
- `session_prompt`
- `timeout`
- `inactivity_timeout`
- `stop_on_run_finished`
- `runner_type`
- `last_run_at`
- `next_run_at`

The service requires `name` and `schedule` on create.

## CLI

```bash
acpctl scheduled-session create \
  --name weekday-triage \
  --agent-id api-maintainer \
  --schedule "0 9 * * 1-5" \
  --timezone America/New_York \
  --prompt "Triage new issues and summarize priorities."

acpctl scheduled-session list
acpctl scheduled-session update weekday-triage --schedule "0 10 * * 1-5"
acpctl scheduled-session suspend weekday-triage
acpctl scheduled-session resume weekday-triage
acpctl scheduled-session trigger weekday-triage
acpctl scheduled-session runs weekday-triage
```

## Current automation pattern

Until automatic firing is implemented, use an external scheduler such as GitHub Actions, Kubernetes CronJob, or another CI system to call `acpctl agent start` or the REST API on a schedule.
