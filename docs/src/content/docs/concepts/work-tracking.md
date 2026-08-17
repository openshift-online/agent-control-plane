---
title: "Work Tracking"
---

Agents self-report their progress through annotations on sessions. The platform does not poll Jira, GitHub, or any external system. Instead, agents write structured annotations via the `patch_session_annotations` MCP tool. The UI renders those annotations into a command center with queues, work rows, and a timeline.

## How annotations work

Annotations are key-value metadata on sessions. Agents write them at runtime to report what they are working on, what state external resources are in, and whether they need human help. The UI maintains a registry of known annotation keys. Registered keys produce visual elements (chips, badges, timeline segments). Unregistered keys are stored but invisible in operational views.

All work tracking keys use two namespaces:

- `work.acp.io/*` for external work items (Jira issues, GitHub PRs, lifecycle phases).
- `agent.acp.io/*` for agent operational status (blocked, needs input).

These annotations are runtime-owned. Applying agent definitions with `acpctl apply` preserves them rather than overwriting from YAML.

## Key annotation types

### Jira tracking

| Key | Example | Purpose |
|-----|---------|---------|
| `work.acp.io/jira/issue` | `"ACP-1432"` | Jira issue key, displayed as a chip |
| `work.acp.io/jira/url` | `"https://issues.redhat.com/browse/ACP-1432"` | Makes the chip a clickable link |
| `work.acp.io/jira/status` | `"In Progress"` | Status badge: To Do, In Progress, In Review, Done, Blocked |
| `work.acp.io/jira/summary` | `"Add RBAC to session create"` | Issue title shown in hover cards |

### GitHub PR tracking

| Key | Example | Purpose |
|-----|---------|---------|
| `work.acp.io/github/pr` | `"org/repo#318"` | PR reference chip |
| `work.acp.io/github/pr-url` | `"https://github.com/org/repo/pull/318"` | Makes the chip a clickable link |
| `work.acp.io/github/pr-status` | `"open"` | PR state: open, closed, merged, draft |
| `work.acp.io/github/pr-checks` | `"passing"` | CI rollup: passing, failing, pending |
| `work.acp.io/github/pr-review` | `"approved"` | Review state: approved, changes-requested, pending |

### Work lifecycle phases

Agents track progression through work phases via `work.acp.io/phases`, a JSON array of phase transitions. Each entry has a `phase` name and an ISO 8601 UTC `start` timestamp. The dashboard renders these as multi-segment colored bars on the timeline.

Valid phases: `implementing`, `reviewing`, `testing`, `deploying`, `complete`.

### Operational status

| Key | Example | Purpose |
|-----|---------|---------|
| `agent.acp.io/status` | `"Blocked: Upstream PR not merged"` | Free-text status shown in the Needs You queue |
| `agent.acp.io/status-criticality` | `"critical"` | Severity: critical (red), warning (amber), info (blue) |
| `agent.acp.io/needs-input` | `"approval"` | Human action needed: approval, clarification, credentials, review |

## Dashboard views

The project dashboard is the landing page for each project. It supports two view modes toggled by a List / Timeline control.

### List view

The list view has three sections that share a unified row layout so you can scan vertically across all of them:

**Needs You** shows sessions that require attention. A session appears here when `agent.acp.io/status` is set, when the session phase is `Failed`, or when `agent.acp.io/needs-input` is set. Items sort by criticality (critical first), then by wait time. When any item is critical, the section border turns red.

**In-flight work** shows active work items. Sessions in Running, Creating, or Pending phases appear here unless their Jira status is terminal (Done). Multiple sessions on the same Jira issue merge into one row.

**Completed today** lists recently finished work items with result badges, duration, and completion time.

### Timeline view

A horizontal Gantt chart with sessions as colored bars on a time axis. Sessions group by Jira issue key. Bars divide into colored segments from the phases annotation (blue for implementing, purple for reviewing, teal for testing, green for deploying, dark green for complete). Sessions without phases use a single color based on session phase.

The timeline supports zoom (Ctrl/Cmd + scroll or +/- buttons) and time window presets from 5 minutes to 24 hours.

### Notification bell

The notification bell shows a badge count of actionable items (critical and warning only). Clicking it opens a tray listing each item with its criticality, status text, and wait time. The bell is visible on every page.

## Using annotations in agent prompts

Agents report status because their prompts tell them to. When defining an agent, include instructions to set annotations at key points:

- On start: set Jira and PR annotations, begin an `implementing` phase.
- On phase transitions: append to the phases array (read, parse, append, write back).
- When blocked: set `agent.acp.io/status` with a description and `agent.acp.io/status-criticality`.
- On completion: append the `complete` phase and clear `agent.acp.io/status`.

See the [Work Tracking Annotations](/guides/work-tracking-annotations/) guide for annotation reference tables and example agent definitions.
