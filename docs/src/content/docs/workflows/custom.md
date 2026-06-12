---
title: "Custom Workflows"
---

Custom workflows are Git repositories that the runner can clone into a session. Use them when prompt text alone is not enough and you want versioned instructions, commands, agents, or rubrics.

## Repository layout

```text
my-workflows/
  bugfix/
    .ambient/
      ambient.json
      rubric.md
    .claude/
      commands/
        investigate.md
        verify.md
      agents/
        reviewer.md
```

The `path` you send to the workflow endpoint can point at a subdirectory such as `bugfix`.

## ambient.json

The runner reads `.ambient/ambient.json` from the active workflow directory when present.

```json
{
  "name": "bugfix",
  "description": "Reproduce, diagnose, fix, and verify defects.",
  "systemPrompt": "Follow the bugfix process and keep changes narrow.",
  "startupPrompt": "Start by restating the bug and the verification plan.",
  "artifactsDir": "artifacts",
  "rubric": "A good result includes root cause, focused fix, test evidence, and risks."
}
```

The workflow metadata endpoint returns `name`, `description`, `systemPrompt`, `artifactsDir`, and `rubric`. The runtime workflow endpoint can send `startupPrompt` as a user message after a workflow change.

## Claude commands and agents

The runner metadata endpoint scans:

- `.claude/commands/*.md`
- `.claude/agents/*.md`

Command files can include frontmatter such as `displayName`, `description`, `icon`, and `order`. Agent files can include `name`, `description`, and `tools`.

These files provide workflow UI/metadata and Claude-side instructions when the Claude bridge uses them. Other runner bridges may ignore them.

## MCP configuration

MCP config is loaded from the runner's `MCP_CONFIG_FILE`, `PROJECT_MCP_SERVERS`, and `CUSTOM_MCP_SERVERS`. A `.mcp.json` committed inside the workflow directory is not automatically loaded unless your deployment points `MCP_CONFIG_FILE` at that path or injects it through session/project environment configuration.

## Attach a workflow

Create or identify a session, then call:

```bash
curl -fsS \
  -X POST \
  -H "Authorization: Bearer $AMBIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "git_url": "https://github.com/acme/my-workflows.git",
    "branch": "main",
    "path": "bugfix"
  }' \
  "$AMBIENT_API_URL/api/ambient/v1/sessions/$SESSION_ID/workflow"
```

The API stores the workflow configuration on the session. The runner-side workflow endpoint clones the repository under `/workspace/workflows/{repo-name}` and copies the selected subpath when `path` is set.

## Design checklist

- Keep instructions short and specific.
- Put durable team rules in project or agent prompts when they apply outside this workflow.
- Keep secrets out of the workflow repository.
- Write outputs to `artifacts/` when humans or automation need to consume them.
- Include verification commands and stop conditions.
