---
title: "Context & Artifacts"
---

Context is what the runner receives. Artifacts are files and results the runner creates while doing the work.

## Workspace layout

Runner Pods use `/workspace`.

Depending on session configuration, the runner uses:

- `/workspace/repos` for cloned repositories.
- `/workspace/workflows` for workflow repositories.
- `/workspace/artifacts` for generated outputs.
- `/workspace/file-uploads` for uploaded files.
- `/workspace/.google_workspace_mcp/credentials` for Google Workspace MCP credentials when configured.

The active working directory depends on available context. If a workflow is active, the runner works inside the workflow directory. If repositories are configured without a workflow, it works in the main repo. Otherwise it falls back to the artifacts directory.

## Repository context

A session can use a single `repo_url` or a structured `repos` JSON value. The runner clones repositories into `/workspace/repos/{name}` and can report repository status through runner-backed endpoints.

The session API also exposes repository subresources:

```text
POST   /api/ambient/v1/sessions/{id}/repos
DELETE /api/ambient/v1/sessions/{id}/repos/{repoName}
GET    /api/ambient/v1/sessions/{id}/repos/status
```

The add-repo handler accepts URL, branch, and name data and updates the session's repo configuration. Branch defaults to `main` when omitted.

## Files and Git

The API server proxies runner endpoints for file and Git operations:

```text
GET    /api/ambient/v1/sessions/{id}/workspace
GET    /api/ambient/v1/sessions/{id}/files
GET    /api/ambient/v1/sessions/{id}/files/{path}
GET    /api/ambient/v1/sessions/{id}/git/status
POST   /api/ambient/v1/sessions/{id}/git/configure-remote
GET    /api/ambient/v1/sessions/{id}/git/branches
```

These endpoints are available only when the runner Pod is reachable.

## Prompt context

Session start context can include:

- project prompt.
- agent prompt.
- peer agent summaries for agent starts.
- unread inbox messages for agent starts.
- the session or agent-start task prompt.
- workflow files.
- repository files and metadata.

Keep stable instructions in the project or agent prompt. Put the current task in the session prompt.

## Artifacts

Artifacts are ordinary files under `/workspace/artifacts`. Ask the agent to write reports, summaries, patches, or generated assets there when you need durable output beyond chat messages.

Example prompt:

```text
Analyze the failing auth tests. Write a concise report to artifacts/auth-test-findings.md
with root cause, changed files, and tests run.
```

Use the file endpoints or UI file panels to inspect artifacts while the runner is active.
