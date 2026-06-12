---
title: "Workflows"
---

A workflow is optional Git-backed context for a session. It is not a separate scheduler or catalog in the API. It is session configuration that tells the runner where to clone an instruction bundle.

## How a session references a workflow

The sessions plugin exposes:

```text
POST /api/ambient/v1/sessions/{id}/workflow
```

The request body uses:

```json
{
  "git_url": "https://github.com/acme/agent-workflows.git",
  "branch": "main",
  "path": "bugfix"
}
```

The API stores this as session workflow configuration. The runner endpoint accepts the same idea internally with `gitUrl`, `branch`, and `path`.

## What the runner loads

When a workflow is active, the runner uses `/workspace/workflows/{workflow-name}` as its working directory. It can discover:

- `.ambient/ambient.json` for workflow metadata.
- `.claude/commands` for Claude command files.
- `.ambient/rubric.md` for rubric evaluation when the Claude bridge wires the rubric MCP tool.
- repository and artifact directories under `/workspace/repos`, `/workspace/artifacts`, and `/workspace/file-uploads`.

MCP server configuration is loaded from the runner's `MCP_CONFIG_FILE` plus project and session environment configuration. A `.mcp.json` inside a workflow repository is not automatically used unless your deployment points `MCP_CONFIG_FILE` at it.

The exact behavior depends on the bridge. The default runner type is `claude-agent-sdk`; other runner bridges may support fewer filesystem or MCP features.

## When to use workflows

Use a workflow when the process is repeatable:

- bug investigation.
- issue triage.
- release-note drafting.
- PRD/RFE review.
- security review.
- repository maintenance.

Use a normal session prompt when the instructions are one-off.

## Keep workflows portable

A good workflow repository should include:

- explicit task phases.
- expected inputs.
- output format.
- validation steps.
- any command files or MCP config needed by the runner.

Do not store secrets in workflow repos. Use ACP credentials and role bindings instead.
