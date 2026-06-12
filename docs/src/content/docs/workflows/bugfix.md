---
title: "Bugfix Workflow"
---

Use this pattern when you want an agent to investigate a reproducible defect, change code, and report exactly what changed.

## Start from the CLI

```bash
acpctl agent create \
  --name bugfixer \
  --prompt "You fix bugs with narrow changes, targeted tests, and clear summaries."

acpctl agent start bugfixer --prompt "$(cat <<'EOF'
Bug: expired bearer tokens return 500 from the sessions API.

Goal:
- reproduce or identify the failing path.
- fix the root cause.
- add or update a focused test.
- run the smallest relevant test command.
- summarize files changed, tests run, and residual risk.

Constraints:
- follow CLAUDE.md.
- do not refactor unrelated code.
- do not print tokens.
EOF
)"

acpctl get sessions -w
```

## Prompt template

```text
Investigate and fix this bug:

Problem:
<describe the failure and expected behavior>

Context:
<repo, branch, issue link, failing command, logs, or stack trace>

Definition of done:
- root cause explained.
- code fix is minimal.
- regression test added or updated.
- relevant tests pass.
- final summary lists files changed and commands run.

Constraints:
- follow repository instructions.
- avoid unrelated cleanup.
- ask before changing public API behavior.
```

## Suggested phases

Ask the agent to work in this order:

1. Reproduce or locate the failure.
2. Identify root cause and affected code paths.
3. Make the smallest fix that addresses the root cause.
4. Add or update a targeted test.
5. Run the smallest useful verification command.
6. Write a final summary and residual-risk note.

## Optional Git-backed workflow

If you maintain a workflow repo, attach it to a created session before or during the run:

```bash
curl -fsS \
  -X POST \
  -H "Authorization: Bearer $AMBIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "git_url": "https://github.com/acme/agent-workflows.git",
    "branch": "main",
    "path": "bugfix"
  }' \
  "$AMBIENT_API_URL/api/ambient/v1/sessions/$SESSION_ID/workflow"
```

The runner clones the workflow under `/workspace/workflows` and uses it as the active working directory when available.

## Useful artifacts

Ask for artifacts when you need durable output:

```text
Write artifacts/bugfix-report.md with root cause, patch summary, tests run,
and follow-up risks.
```

Use session messages for conversation and artifacts for structured reports.
