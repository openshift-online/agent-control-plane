---
title: "Session Config"
---

A session-config repo is a Git repository that bundles shared instructions, skills, and context for agents. It acts as a team harness: the work repo stays focused on the code being changed while the session-config repo supplies the reusable tooling the agent needs to do its job.

## What a session-config contains

A typical session-config repo has the following structure:

```text
.
|-- AGENTS.md
|-- .claude/
|   `-- skills/
|       `-- release-reviewer/
|           `-- SKILL.md
`-- .ambient/
    `-- ambient.json
```

| Item | Purpose |
|------|---------|
| `AGENTS.md` | Top-level instructions loaded by the runner |
| `.claude/skills/` | Claude skills activated by prompt intent |
| `.claude/commands/` | Claude slash commands available during the session |
| `.ambient/ambient.json` | Metadata describing the harness |

You can include any combination of these. A session-config with a single `AGENTS.md` is valid; so is one that only provides skills.

## How it is mounted

The session-config repo is attached to an agent as a payload and exposed through the `SESSION_CONFIG_PATH` environment variable:

```yaml
payloads:
  - sandbox_path: /sandbox/session-config
    repo_url: https://github.com/example/team-session-config
    ref: main
environment:
  SESSION_CONFIG_PATH: /sandbox/session-config
```

At runtime the work repo remains the runner's working directory. The session-config path is added as an extra readable directory so the agent can discover skills and instructions without switching repos.

The session-config is loaded when the sandbox starts. It cannot be changed for an already-running session.

## Relationship to workflows

Workflows and session-configs solve different problems:

| Concern | Session Config | Workflow |
|---------|---------------|----------|
| Purpose | Team-wide tooling and instructions | Task-specific process |
| Scope | Shared across many agents | Usually one agent or task type |
| Working directory | Work repo stays active | Workflow directory becomes active |
| Typical contents | Skills, instructions, checklists | Task phases, rubrics, commands |

A single agent can use both. The workflow defines what to do; the session-config provides the shared tools to do it with.

## When to use it

Use a session-config repo when several agents need the same baseline:

- Shared Claude skills (review checklist, coding standards, release readiness).
- Team instructions that apply regardless of the task.
- Curated memory files or library context.
- Reusable command files.

Keep task-specific instructions in the session prompt or in a workflow. Keep code changes in the work repo. Do not store secrets in session-config repos — use ACP credentials and role bindings instead.

See the [Session Config Quickstart](/getting-started/session-config/) for a step-by-step setup guide.
