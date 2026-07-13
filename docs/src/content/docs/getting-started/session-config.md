---
title: "Session Config Quickstart"
---

A session-config repo is a Git-backed harness for an agent session. Use it on
day 0 when you want the runner to load shared instructions, Claude skills, or
reusable context without making that repo the work repo.

The current day-0 path is declarative Agent YAML applied with `acpctl apply`.
There is not yet a `--session-config` CLI flag.

## Create the repo

Create a Git repository for your session harness. A minimal Claude skill layout
looks like this:

```text
.
|-- AGENTS.md
`-- .claude/
    `-- skills/
        `-- release-reviewer/
            `-- SKILL.md
```

Example `SKILL.md`:

```markdown
---
name: release-reviewer
description: Use when reviewing release readiness, release notes, or release-blocking risk.
---

# Release Reviewer

Check open issues, recent commits, tests, docs, and known deployment risks.
Return a short release readiness report with blockers first.
```

## Mount it into an Agent

Add the repo as a payload at `/sandbox/session-config` and set
`SESSION_CONFIG_PATH` to the same path:

```yaml
kind: Agent
name: release-lead
prompt: |
  You manage release readiness. Use the team session-config harness when it
  contains relevant skills or instructions.
providers:
  - vertex
  - github
repo_url: https://github.com/example/app
payloads:
  - sandbox_path: /sandbox/session-config
    repo_url: https://github.com/example/team-session-config
    ref: main
environment:
  SESSION_CONFIG_PATH: /sandbox/session-config
```

Apply the Agent:

```bash
acpctl apply -f release-lead.yaml --project my-project
```

Start the Agent:

```bash
acpctl agent start release-lead --prompt "Review release readiness for this week."
```

## What happens at runtime

When `SESSION_CONFIG_PATH` points to an existing absolute directory:

- The work repo remains the runner's working directory.
- `/sandbox/session-config` is added as an extra Claude-readable directory.
- Claude SDK skills are enabled, so skills from the mounted harness can be
  activated by prompt intent.

The session-config repo is loaded when the sandbox starts. Existing-session
commands such as `acpctl session send` only add messages to a running session;
they do not change the mounted harness for that session.

## When to use it

Use session config for stable team harness content:

- Claude skills.
- Team instructions.
- Reusable review checklists.
- Curated Library or memory files.

Keep task-specific instructions in the session prompt. Keep code changes in the
work repo.
