---
title: GitHub Action
---

import { Badge } from '@astrojs/starlight/components';

<Badge text="Beta" variant="caution" />

Use GitHub Actions to start ACP work from issues, pull requests, schedules, or manual workflow dispatch. The reliable integration point in this repository is the ACP REST API or `acpctl`.

## Required secrets

Use deployment-specific secret names, but keep the values separate:

- `AMBIENT_API_URL`: ACP base URL, without `/api/ambient/v1`.
- `AMBIENT_TOKEN`: bearer token with access to the target project and agent.
- `AMBIENT_PROJECT`: project ID or name.
- `AMBIENT_AGENT`: agent ID or name.

## Start an agent

This is the simplest pattern because `agent start` is idempotent.

```yaml
name: Start ACP agent

on:
  workflow_dispatch:
    inputs:
      prompt:
        required: true
        type: string

jobs:
  start:
    runs-on: ubuntu-latest
    steps:
      - name: Start ACP session
        env:
          AMBIENT_API_URL: ${{ secrets.AMBIENT_API_URL }}
          AMBIENT_TOKEN: ${{ secrets.AMBIENT_TOKEN }}
          AMBIENT_PROJECT: ${{ secrets.AMBIENT_PROJECT }}
          AMBIENT_AGENT: ${{ secrets.AMBIENT_AGENT }}
          PROMPT: ${{ inputs.prompt }}
        run: |
          curl -fsS \
            -X POST \
            -H "Authorization: Bearer ${AMBIENT_TOKEN}" \
            -H "Content-Type: application/json" \
            -d "$(jq -nc --arg prompt "$PROMPT" '{prompt: $prompt}')" \
            "${AMBIENT_API_URL}/api/ambient/v1/projects/${AMBIENT_PROJECT}/agents/${AMBIENT_AGENT}/start"
```

## Create a one-off session

Use direct sessions when you do not have a reusable agent.

```yaml
- name: Create session
  env:
    AMBIENT_API_URL: ${{ secrets.AMBIENT_API_URL }}
    AMBIENT_TOKEN: ${{ secrets.AMBIENT_TOKEN }}
    AMBIENT_PROJECT: ${{ secrets.AMBIENT_PROJECT }}
    PROMPT: "Review this PR and summarize risks."
    REPO_URL: ${{ github.server_url }}/${{ github.repository }}.git
  run: |
    session_json=$(curl -fsS \
      -X POST \
      -H "Authorization: Bearer ${AMBIENT_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$(jq -nc \
        --arg project_id "$AMBIENT_PROJECT" \
        --arg prompt "$PROMPT" \
        --arg repo_url "$REPO_URL" \
        '{project_id: $project_id, prompt: $prompt, repo_url: $repo_url}')" \
      "${AMBIENT_API_URL}/api/ambient/v1/sessions")

    session_id=$(printf '%s' "$session_json" | jq -r '.id')

    curl -fsS \
      -X POST \
      -H "Authorization: Bearer ${AMBIENT_TOKEN}" \
      "${AMBIENT_API_URL}/api/ambient/v1/sessions/${session_id}/start"
```

## Scheduled workflows

Because automatic scheduled-session execution is not wired in the API service yet, use GitHub Actions cron when you need recurring work:

```yaml
on:
  schedule:
    - cron: "0 14 * * 1-5"
```

Have the job call the agent start endpoint with the task prompt for that run.

## About `ambient-action`

Some workflows in this repository reference an external `ambient-code/ambient-action`. That action is not implemented in this repository. If your organization uses it, check that action's own README and pin it to a commit SHA.
