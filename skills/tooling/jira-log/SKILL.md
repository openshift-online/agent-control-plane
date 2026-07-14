---
name: jira-log
description: >
  Log a new Jira issue to the ENGPROD project with the ACP component pre-filled.
  Gathers context to make issues agent-actionable from cold start. Use this
  whenever work needs tracking in Jira -- creating stories, filing bugs, logging
  tasks, opening spikes, or any time the user says "create a jira", "log this",
  "file a bug", "new ticket", "open a story", "track this". Triggers on: "log
  jira", "create jira", "file a bug", "new ticket", "open a story", "jira
  issue", "track this work", "open a jira", "create a ticket".
---

# Jira Issue Logger

Create well-structured Jira issues in the ENGPROD project with the ACP (Agent Control Plane) component pre-filled.

## Usage

```text
/jira-log Add dark mode toggle to session viewer
/jira-log [Bug] Session list doesn't refresh after deletion
/jira-log [Task] Migrate session queries to React Query v5
/jira-log [Spike] Investigate MCP server connection pooling
```

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Execution Steps

### 1. Parse User Input

Extract from `$ARGUMENTS`:

- **Summary** (required): The title/summary of the issue
- **Description** (optional): Detailed description
- **Issue Type** (optional): Defaults to `Story`. Valid: `Bug`, `Task`, `Spike`. Normalize case (e.g. "bug" -> "Bug") and reject unrecognized values.
- **Priority** (optional): Defaults to `Normal`

If the user provides a simple sentence, use it as the summary. Multiple lines: first line is summary, rest is description.

### 2. Gather Cold-Start Context

To make the Jira actionable by an agent, gather context. Ask the user for missing critical info:

**Required for Stories:**
- User-facing goal (As a [user], I want [X], so that [Y])
- Acceptance criteria (How do we know it's done)
- Which component (e.g., `ambient-api-server`, `ambient-control-plane`, `ambient-ui`, `ambient-runner`)

**Required for Bugs:**
- Steps to reproduce
- Expected vs actual behaviour
- Environment info if relevant

**Required for Spikes:**
- Question to answer, expected deliverables, time-box

**Helpful for all types:**
- Relevant file paths (e.g., `components/ambient-ui/src/...`)
- Related issues/PRs/specs
- Constraints or out-of-scope items
- Testing requirements

### 3. Build Structured Description

Use this agent-friendly template, omitting sections that don't apply:

```markdown
## Overview
[One paragraph summary of what needs to be done and why]

## User Story (for Stories)
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

## Bug Details (for Bugs only)
**Steps to Reproduce**: ...
**Expected**: ...
**Actual**: ...

## Spike Deliverables (for Spikes only)
- [ ] [Output: e.g. design doc, prototype, findings]
**Time-box**: [e.g. 2 days]
```

### 4. Confirm Details

Before creating, confirm with the user:

```
About to create ENGPROD Jira:

**Summary**: [extracted summary]
**Type**: [Story/Bug/Task/Spike]
**Component**: ACP

**Description Preview**:
[First 500 chars of formatted description]

Shall I create this issue? (yes/no/edit)
```

### 5. Create the Jira Issue

Use `mcp__jira__jira_create_issue` with:

```json
{
  "project_key": "ENGPROD",
  "summary": "[user provided summary]",
  "issue_type": "[Story|Bug|Task|Spike]",
  "description": "[structured description]",
  "components": "ACP",
  "additional_fields": "{\"labels\": [\"team:acp\"]}"
}
```

### 6. Report Success

```
Created: [ISSUE_KEY]
Link: https://redhat.atlassian.net/browse/[ISSUE_KEY]

Summary: [summary]
Component: ACP
Type: [issue type]
Agent Cold-Start Ready: Yes
```

## Examples

### Quick Story

```
/jira-log Add session filtering by project scope
```

Will prompt for acceptance criteria, relevant files, etc.

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

### Research Spike

```
/jira-log [Spike] Investigate MCP server connection pooling strategies

Questions: Can we pool connections? What's the memory overhead?
Component: ambient-mcp
Deliverables: Findings doc with benchmarks
Time-box: 3 days
```

## Field Reference

| Field | Value | Notes |
|-------|-------|-------|
| Project | ENGPROD | Engineering Productivity |
| Component | ACP | Agent Control Plane |
| Label | `team:acp` | Set on create |
| Issue Type | Story | Default; also Bug, Task, Spike |
| Browse URL | `https://redhat.atlassian.net/browse/` | |

## Agent Cold-Start Checklist

A Jira is agent-actionable when it has: a user story (who/why), acceptance criteria (definition of done), repo + file paths (where to edit), constraints (what not to do), and testing requirements (expected coverage). Bug reports additionally need repro steps. Spikes need deliverables and a time-box.
