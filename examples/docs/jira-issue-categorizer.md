# Jira Issue Categorizer Agent

An automation agent that classifies Jira issues into activity types using AI. This is one of the most complex example agents — it demonstrates **multi-phase workflows**, **large payload-driven classification**, and **write-back to external systems** via MCP tools.

## What it does

The agent scans Jira projects for Epics, Features, and Outcomes that lack an "Activity Type" classification, then assigns one of six Sankey categories based on the issue's summary and description:

| Category | What it covers |
|----------|---------------|
| Associate Wellness & Development | Onboarding, training, conferences, career development |
| Incidents & Support | P0/P1 incidents, on-call, customer-blocking issues |
| Security & Compliance | CVEs, FedRAMP, audits, vulnerability remediation |
| Quality / Stability / Reliability | Bugs, tech debt, toil, SLO improvements |
| Future Sustainability | Automation, architecture spikes, tooling, observability |
| Product / Portfolio Work | New features, GA launches, roadmap items |

The agent supports two operating modes:

- **Standard mode** — Finds unclassified issues and categorizes each one independently.
- **Hierarchical mode** — Processes issues top-down (Outcomes → Features → Epics), propagating classification from parent issues to their descendants.

A **dry-run mode** lets you preview what would be categorized without making any changes.

## Agent definition (simplified)

```yaml
kind: Agent
name: jira-issue-categorizer
sandbox_policy: permissive
prompt: |
  You are a Jira issue categorizer. The session prompt will tell you
  which Jira projects to process and whether to use dry-run mode.
providers:
  - vertex
  - jira
payloads:
  - sandbox_path: /sandbox/SANKEY_CATEGORIES.md
    content: |
      # Sankey Activity Type Classification Guide
      Classify each Jira issue into exactly one of the following six categories...
environment:
  JIRA_URL: "https://your-jira-instance.atlassian.net"
```

## Key concepts demonstrated

| Concept | How it's used |
|---------|---------------|
| Complex prompt engineering | Multi-phase workflow with standard and hierarchical modes, decision rules, and structured reporting |
| Payload as classification guide | The full Sankey category taxonomy is injected at `/sandbox/SANKEY_CATEGORIES.md` |
| Write-back via MCP | The agent reads AND writes to Jira — it updates `customfield_10682` on classified issues |
| Environment variables | `JIRA_URL` configures the Jira instance without changing the agent definition |
| Dry-run safety | Built-in dry-run mode prevents accidental changes during testing |

## Prerequisites

Jira credentials must be configured for the project:

```bash
acpctl credential create --name jira --provider jira \
  --token "$JIRA_API_TOKEN" --url "https://your-instance.atlassian.net" \
  --email "your-email@example.com" --project my-project
```

## How to run

```bash
# Apply the agent
acpctl apply -f examples/base/agents/jira-issue-categorizer.yaml --project my-project

# Dry-run first to preview classifications
acpctl agent start jira-issue-categorizer --project my-project \
  --prompt "Process project MYPROJ in dry-run mode"

# Run for real when satisfied
acpctl agent start jira-issue-categorizer --project my-project \
  --prompt "Process project MYPROJ"

# Use hierarchical mode for large projects
acpctl agent start jira-issue-categorizer --project my-project \
  --prompt "Process project MYPROJ using hierarchical propagation mode"
```

## Customization ideas

- **Custom categories**: Replace the Sankey taxonomy payload with your team's own classification scheme.
- **Scheduled categorization**: Combine with a scheduled session to automatically classify new issues daily.
- **Multi-project runs**: Pass multiple project keys in a single session prompt to process an entire portfolio.
