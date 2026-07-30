# Agent Control Plane — Jira Conventions

All issues created by this skill target the **Agent Control Plane (ACP)** team in ENGPROD.

## Field Defaults

| Field | Value | Notes |
|-------|-------|-------|
| Project | ENGPROD | Engineering Productivity |
| Component | acp | Agent Control Plane (lowercase) |
| Label | `team:acp` | Always set on create |
| Priority | Normal | Unless user specifies otherwise |
| Browse URL | `https://redhat.atlassian.net/browse/` | |
| Board | 348 | ENGPROD kanban board (no sprints) |

## Activity Type Defaults

Set Activity Type (`customfield_10464`) automatically — do not prompt unless the user wants to override:

| Issue context | Activity Type | Option ID |
|---------------|---------------|-----------|
| Bug, tech debt, stability | Quality / Stability / Reliability | 10608 |
| Everything else (Story, Task, Spike, Epic, etc.) | Future Sustainability | 10606 |

If a parent issue is provided, inherit its Activity Type instead.

## ACP Components (for description Technical Context)

Use these in the **description**, not as the Jira component field:

- `ambient-api-server` — Go REST API, PostgreSQL-backed
- `ambient-control-plane` — Go reconciler, K8s Jobs
- `ambient-ui` — Next.js + Shadcn frontend
- `ambient-runner` — Python runner in Job pods
- `ambient-mcp` — MCP server integration
- `ambient-cli` — Go CLI (`acpctl`)
- `ambient-sdk` — Generated client SDKs
- `manifests` — Kustomize deployment manifests
- `docs` — Astro Starlight documentation site

## Description Template

When delegating to specialist agents or building descriptions directly, ensure every non-Epic issue includes agent-actionable content. Use this template, dropping sections that do not apply:

```markdown
## Overview
[One paragraph: what needs to be done and why]

## User Story
As a [type of user], I want [goal], so that [benefit].

## Acceptance Criteria
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Technical Context
**Repo**: openshift-online/agent-control-plane
**Component**: [e.g. ambient-api-server, ambient-control-plane, ambient-ui, ambient-runner]
**Relevant Paths**:
- `components/[component]/path/to/relevant/file`

## Related Links
- Spec: [link to relevant spec in specs/]
- Related Issues: [ENGPROD-XXXX]

## Constraints
- [What NOT to do]

## Testing Requirements
- [ ] Unit tests for [X]

## Bug Details
**Steps to Reproduce**: ...
**Expected**: ...
**Actual**: ...

## Spike Deliverables
- [ ] [Output: e.g. design doc, prototype, findings]
**Time-box**: [e.g. 2 days]
```

**Section guidance by type:**
- **Epics**: Overview only. No Acceptance Criteria, Testing Requirements, or User Story — those belong on the children.
- **Stories**: Overview, User Story, Acceptance Criteria, Technical Context (with Relevant Paths), Testing Requirements.
- **Bugs**: Overview, Bug Details (Steps/Expected/Actual), Technical Context (with Relevant Paths), Testing Requirements.
- **Tasks**: Overview, Acceptance Criteria, Technical Context (with Relevant Paths), Testing Requirements.
- **Spikes**: Overview, Spike Deliverables (must include Time-box), Technical Context (with Relevant Paths).

## Jira Link Types

| Relationship | `link_type` value | Notes |
|-------------|-------------------|-------|
| Blocking | `"Blocks"` | inward issue blocks outward issue |
| Related | `"Related"` | Not "Relates" — wrong name silently fails |

## What Makes a Jira Agent-Actionable

A Jira is ready for cold-start work when it has: a user story (who/why), acceptance criteria (definition of done), repo + file paths (where to edit), constraints (what not to do), and testing requirements (expected coverage). Bug reports additionally need repro steps. Spikes need deliverables and a time-box. Epics need an overview and linked children.

## Type Prefix Syntax

When `$ARGUMENTS` contains a type prefix, parse it before asking:
- `[Bug] Session crashes` → type=Bug, summary="Session crashes"
- `[Task]`, `[Spike]`, `[Epic]`, `[Story]` work the same way
