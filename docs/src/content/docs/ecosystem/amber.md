---
title: "Amber"
---

Amber is the ACP name for a codebase-focused agent. In ACP terms, Amber is not a special API kind; it is an agent prompt, project context, repository credentials, and sessions that run against your code.

If your deployment ships an Amber agent, use it like any other project agent. If it does not, you can create one.

## Create an Amber-style agent

```bash
acpctl agent create \
  --name amber \
  --prompt "You are a codebase maintenance agent. Read repository instructions, keep changes focused, run targeted checks, and summarize files changed, tests run, and residual risk."
```

Start it with a specific task:

```bash
acpctl agent start amber --prompt "Find why the session status endpoint returns 500 on expired tokens and fix it."
```

## Good Amber tasks

- Explain how a module works.
- Trace a bug from symptom to root cause.
- Make a narrow code fix with tests.
- Review a pull request for repository standards.
- Add missing test coverage for a specific file.
- Produce an issue triage report.
- Draft a refactor plan without changing code yet.

## Give it useful context

Amber works best when the project has:

- repository credentials for the target repos.
- a project prompt with team conventions.
- a `CLAUDE.md` or similar repo instruction file.
- focused task prompts with expected verification commands.
- clear limits on what not to change.

## Prompt example

```text
You are working in the API server repo.

Task:
Fix the bug where stopping a pending session sometimes leaves runner resources behind.

Definition of done:
- explain the root cause.
- make the smallest code change.
- add or update a focused test.
- run the relevant test command.
- write artifacts/summary.md with files changed, tests run, and risks.

Constraints:
- follow CLAUDE.md.
- do not refactor unrelated reconcilers.
- do not log tokens.
```

## Review the output

Amber can edit code and run tools, but its output still needs normal engineering review. Check the diff, commands run, tests, and any assumptions in the final summary before merging changes.
