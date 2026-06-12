---
title: "Triage Workflow"
---

Use this pattern when you want an agent to sort issues, logs, support tickets, or incoming work into actionable buckets.

## Best inputs

Provide at least one of:

- a GitHub or GitLab issue list the agent can access.
- a Jira query or exported issue list.
- a file containing raw reports.
- labels, severity rules, owners, and release constraints.
- examples of previously triaged issues.

If the source system is private, make sure the project or agent has the right credentials before starting the session.

## Prompt template

```text
Triage these issues:

Source:
<issue query, repo, file path, or pasted list>

Classify each item by:
- component.
- severity.
- user impact.
- likely owner.
- recommended next action.

Output:
- artifacts/triage-summary.md with top risks and recommended order.
- artifacts/triage-table.md with one row per issue.

Rules:
- do not close or modify issues unless explicitly asked.
- mark uncertain classifications as uncertain.
- link related issues when evidence is visible.
```

## Run it

```bash
acpctl agent start triager --prompt "Triage open API server bugs and write artifacts/triage-summary.md."
acpctl session messages <session-id> -f
```

## Good output

A useful triage run should produce:

- a short executive summary.
- a prioritized list of urgent items.
- a table of all reviewed items.
- clear reasons for severity.
- a list of items needing human clarification.

Do not ask the agent to perform bulk issue edits until you have reviewed the triage report.
