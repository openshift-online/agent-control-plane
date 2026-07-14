---
name: jira-log
description: >
  Log one or more Jira issues to the ENGPROD project with the acp component
  pre-filled. Gathers context to make issues agent-actionable from cold start.
  Use this whenever work needs tracking in Jira -- creating stories, filing
  bugs, logging tasks, opening spikes, creating epics, or any time the user says
  "create a jira", "log this", "file a bug", "new ticket", "open a story",
  "track this", "create tickets", "batch create", or provides a bullet list of
  work items. Supports single tickets and batch creation from bullet lists.
  Triggers on: "log jira", "create jira", "file a bug", "new ticket",
  "open a story", "jira issue", "track this work", "open a jira",
  "create a ticket", "create tickets", "batch tickets", "log these items".
---

# Jira Issue Logger

Create well-structured Jira issues in the ENGPROD project with the `acp` (Agent Control Plane) component pre-filled. Every issue is built to be agent-actionable from a cold start — meaning another agent (or human) can pick it up and start working immediately without asking clarifying questions.

## User Input

```text
$ARGUMENTS
```

Consider the user input before proceeding (if not empty).

## Recognizing Single vs Batch Mode

**Single ticket** (default): The input is a sentence, paragraph, or block of text describing one piece of work.

**Batch mode**: The input contains a markdown bullet list (lines starting with `- ` or `* `). Each top-level bullet becomes a separate ticket. Sub-bullets provide context for that ticket's description. The reason batch mode skips interactive prompting is that asking questions for each of 10+ tickets would be exhausting — instead, use sub-bullet context and reasonable defaults, then confirm the full batch before creating.

## Execution

### Step 1 — Parse

Extract from user input, per ticket:

| Field | Default | Notes |
|-------|---------|-------|
| Summary | (required) | Title of the issue |
| Issue Type | Story | Also: Bug, Task, Spike, Epic. Normalize case. |
| Priority | Normal | |
| Description | (from context) | Sub-bullets, multi-line text, or gathered interactively |
| Epic link | — | If a ticket should belong to an epic |
| Blocking | — | "X blocks Y" relationships |
| Related | — | "X related to Y" relationships |

Type prefix syntax: `[Bug] Session crashes` → type=Bug, summary="Session crashes".

### Step 2 — Gather Context (single ticket only)

To make a Jira actionable by an agent picking it up cold, gather the information they'd need. The specific info depends on the issue type:

**Stories** need: a user story (As a [user], I want [X], so that [Y]), acceptance criteria, and the target component (e.g., `ambient-api-server`, `ambient-control-plane`, `ambient-ui`, `ambient-runner`).

**Bugs** need: steps to reproduce, expected vs actual behavior, and environment info if relevant.

**Spikes** need: the question to answer, expected deliverables, and a time-box. Always include a time-box — spikes without one tend to expand indefinitely.

**Epics** need: a high-level overview of the initiative and the child stories/tasks that make it up. Epics are containers, so they don't need Testing Requirements or Acceptance Criteria of their own — their children carry those.

**All types** benefit from: relevant file paths, related issues/PRs/specs, constraints, and testing requirements.

In batch mode, skip this interactive step — use whatever context the sub-bullets provide and fill in reasonable defaults for the rest. But don't skip content just because it's batch: every non-Epic ticket still needs Testing Requirements and Relevant Paths in its description, even if you have to infer them from the component. Going back to add these later is painful.

### Step 3 — Build Description

Use this template, dropping sections that don't apply:

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

### Step 4 — Confirm

**Single ticket:**

```
About to create ENGPROD Jira:

**Summary**: [extracted summary]
**Type**: [Story/Bug/Task/Spike/Epic]
**Component**: acp

**Description Preview**:
[First 500 chars of formatted description]

Shall I create this issue? (yes/no/edit)
```

**Batch mode** — show a summary table:

```
About to create N ENGPROD tickets:

| # | Type  | Summary                        | Epic          |
|---|-------|--------------------------------|---------------|
| 1 | Epic  | Feature X                      | —             |
| 2 | Story | Implement Y                    | Feature X     |
| 3 | Bug   | Fix Z                          | —             |

Blocking: #2 blocks #3
Related: #4 related to #5

Create all? (yes/no/edit)
```

### Step 5 — Create

Use `mcp__jira__jira_create_issue` with:

```json
{
  "project_key": "ENGPROD",
  "summary": "[summary]",
  "issue_type": "[Story|Bug|Task|Spike|Epic]",
  "description": "[structured description from step 3]",
  "components": "acp",
  "additional_fields": "{\"labels\": [\"team:acp\"]}"
}
```

**Batch execution order** (the order matters because later steps depend on earlier ones):
1. Create Epics first — their keys are needed for linking
2. Create remaining tickets (Stories, Bugs, Tasks, Spikes)
3. Link child tickets to their epics via `mcp__jira__jira_link_to_epic`
4. Create blocking relationships via `mcp__jira__jira_create_issue_link` with `link_type: "Blocks"`
5. Create related links via `mcp__jira__jira_create_issue_link` with `link_type: "Related"`

**Important**: the Jira link type for related issues is `"Related"` (not "Relates"). Using the wrong name silently fails.

Parallelize where possible: all epics can be created in parallel, then all non-epics in parallel, then all links in parallel. But each phase must complete before the next begins.

### Step 6 — Report

**Single ticket:**
```
Created: [ISSUE_KEY]
Link: https://redhat.atlassian.net/browse/[ISSUE_KEY]

Summary: [summary]
Component: acp
Type: [issue type]
Agent Cold-Start Ready: Yes
```

**Batch:**
```
Created N tickets:

| Key            | Type  | Summary                        | Epic          |
|----------------|-------|--------------------------------|---------------|
| ENGPROD-XXXXX  | Epic  | Feature X                      | —             |
| ENGPROD-XXXXX  | Story | Implement Y                    | Feature X     |
| ENGPROD-XXXXX  | Bug   | Fix Z                          | —             |

Links created:
- ENGPROD-XXXXX blocks ENGPROD-XXXXX
- ENGPROD-XXXXX → Epic ENGPROD-XXXXX
```

## Examples

### Quick Story
```
/jira-log Add session filtering by project scope
```
Prompts for acceptance criteria, relevant files, etc.

### Bug Report
```
/jira-log [Bug] Session list doesn't refresh after deletion

Steps:
1. Create a session
2. Delete the session via UI
3. Observe the list

Expected: Session disappears from list
Actual: Session remains until page refresh

Component: ambient-ui
Files: components/ambient-ui/src/components/session-list/
```

### Tech Debt Task
```
/jira-log [Task] Add OwnerReferences to reconciler-created Secrets

Control plane creates Secrets without OwnerReferences, leaving orphans.

Component: ambient-control-plane
Files: components/ambient-control-plane/internal/reconciler/kube_reconciler.go
```

### Spike
```
/jira-log [Spike] Investigate MCP server connection pooling strategies

Questions: Can we pool connections? What's the memory overhead?
Component: ambient-mcp
Deliverables: Findings doc with benchmarks
Time-box: 3 days
```

### Batch
```
/jira-log
- [Epic] User Onboarding Flow
- Implement SSO login page
  - Component: ambient-ui
  - Acceptance: user can log in via Keycloak
- [Task] Add onboarding docs
  - Component: docs
- [Bug] Login redirect fails on Safari
  - Steps: open Safari, click login, observe redirect loop
```
Creates 1 epic + 2 stories + 1 bug, links stories to the epic.

### Batch with Blocking
```
/jira-log
- [Epic] RBAC Hardening
- [Task] Audit existing ClusterRole permissions
  - Component: manifests
  - Files: components/manifests/base/rbac/
  - blocks: Implement namespace-scoped RBAC
- [Story] Implement namespace-scoped RBAC for sessions
  - Component: ambient-api-server
  - Acceptance: users can only see sessions in their namespace
- [Spike] Investigate OPA integration for policy enforcement
  - Deliverables: findings doc with recommendation
  - Time-box: 3 days
```
Creates 1 epic + 1 story + 1 task + 1 spike, links all to the epic, creates blocking relationship from audit → RBAC story.

## Field Reference

| Field | Value | Notes |
|-------|-------|-------|
| Project | ENGPROD | Engineering Productivity |
| Component | acp | Agent Control Plane (lowercase) |
| Label | `team:acp` | Set on create |
| Issue Type | Story | Default; also Bug, Task, Spike, Epic |
| Browse URL | `https://redhat.atlassian.net/browse/` | |
| Board | 348 | ENGPROD kanban board (no sprints) |

## Jira Link Types

| Relationship | `link_type` value | Notes |
|-------------|-------------------|-------|
| Blocking | `"Blocks"` | inward issue blocks outward issue |
| Related | `"Related"` | Not "Relates" — wrong name silently fails |

## What Makes a Jira Agent-Actionable

A Jira is ready for cold-start work when it has: a user story (who/why), acceptance criteria (definition of done), repo + file paths (where to edit), constraints (what not to do), and testing requirements (expected coverage). Bug reports additionally need repro steps. Spikes need deliverables and a time-box. Epics need an overview and linked children — their actionability comes from the children being well-structured, not from the epic itself.
