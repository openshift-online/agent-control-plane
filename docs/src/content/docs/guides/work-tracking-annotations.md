---
title: "Work Tracking Annotations"
description: "How agents report work status via annotations for the dashboard"
---

Agents self-report their work status by writing annotations to their sessions via the `patch_session_annotations` MCP tool. The platform dashboard renders these annotations into a command center with a Needs You queue, in-flight work cards, and a Gantt-style timeline.

No server-side polling of Jira or GitHub is required — agents are the source of truth.

## Annotation Reference

### Jira Tracking

| Key | Example | Purpose |
|-----|---------|---------|
| `work.acp.io/jira/issue` | `"ACP-1432"` | Jira issue key |
| `work.acp.io/jira/url` | `"https://issues.redhat.com/browse/ACP-1432"` | Clickable URL (makes the chip a link) |
| `work.acp.io/jira/status` | `"In Progress"` | Jira status: `To Do`, `In Progress`, `In Review`, `Done`, `Blocked` |
| `work.acp.io/jira/summary` | `"Add RBAC to session create"` | Issue summary/title |

### GitHub PR Tracking

| Key | Example | Purpose |
|-----|---------|---------|
| `work.acp.io/github/pr` | `"org/repo#318"` | PR reference |
| `work.acp.io/github/pr-url` | `"https://github.com/org/repo/pull/318"` | Clickable URL |
| `work.acp.io/github/pr-status` | `"open"` | `open`, `closed`, `merged`, `draft` |
| `work.acp.io/github/pr-checks` | `"passing"` | CI rollup: `passing`, `failing`, `pending` |
| `work.acp.io/github/pr-review` | `"approved"` | `approved`, `changes-requested`, `pending`, `none` |

### Operational Status

| Key | Example | Purpose |
|-----|---------|---------|
| `agent.acp.io/status` | `"Blocked: Upstream PR not merged"` | Free-text status shown in the Needs You queue |
| `agent.acp.io/status-criticality` | `"critical"` | `critical` (red), `warning` (amber), `info` (blue). Default: `warning` |
| `agent.acp.io/needs-input` | `"approval"` | Human input needed: `approval`, `clarification`, `credentials`, `review` |

### Work Lifecycle Phases

| Key | Example | Purpose |
|-----|---------|---------|
| `work.acp.io/phases` | `[{"phase":"implementing","start":"2026-06-18T14:30:00Z"}]` | JSON array of phase transitions for timeline bar segments |

**Valid phases:** `implementing`, `reviewing`, `testing`, `deploying`, `complete`

## How Phases Work

The `work.acp.io/phases` annotation tracks work lifecycle progression as a JSON array. Each entry records when a phase started. The dashboard renders these as colored segments on timeline bars.

**Critical rules:**

1. **Use real timestamps.** Run `date -u +%Y-%m-%dT%H:%M:%SZ` before every write. Never fabricate timestamps.
2. **Always append.** Read the current value, parse the array, append, write back. Never overwrite with a single entry.
3. **Valid phases only.** The UI ignores unrecognized phase names.

### Phase Colors on the Timeline

| Phase | Color | Pattern |
|-------|-------|---------|
| `implementing` | Blue (#0066cc) | Solid |
| `reviewing` | Purple (#6753ac) | Diagonal stripes |
| `testing` | Teal (#009596) | Dots |
| `deploying` | Green (#63993d) | Vertical stripes |
| `complete` | Dark green (#3d8c40) | Solid |

## Example Agent Definitions

### Jira Work Reporter

An agent that tracks Jira issues, opens PRs, and reports lifecycle phases:

```bash
acpctl create agent \
  --name "jira-reporter" \
  --project-id my-project \
  --prompt 'You are a Jira work reporter agent. Report your status using annotations via the patch_session_annotations MCP tool.

## Getting Accurate Timestamps

CRITICAL: Run `date -u +%Y-%m-%dT%H:%M:%SZ` before writing any phase transition. NEVER guess timestamps.

## Annotations to Set

When you start work:
1. Set `work.acp.io/jira/issue`, `work.acp.io/jira/url`, `work.acp.io/jira/status`, `work.acp.io/jira/summary`
2. Run `date -u +%Y-%m-%dT%H:%M:%SZ`, then set `work.acp.io/phases` to `[{"phase":"implementing","start":"<timestamp>"}]`

When you transition phases:
1. Run `date -u +%Y-%m-%dT%H:%M:%SZ`
2. Read current `work.acp.io/phases`
3. Parse the JSON array
4. Append `{"phase":"<new-phase>","start":"<timestamp>"}`
5. Write the full array back

Phase transitions:
- Editing files → `implementing`
- Opening/reviewing a PR → `reviewing`
- Running tests → `testing`
- Deploying/applying manifests → `deploying`
- Work complete → `complete`

When you open a PR, set all `work.acp.io/github/pr-*` annotations.
If blocked, set `agent.acp.io/status` with `agent.acp.io/status-criticality: "critical"`.
When unblocked, clear `agent.acp.io/status` (set to empty string).'
```

### PR Reviewer

An agent that reviews PRs and reports review status:

```bash
acpctl create agent \
  --name "pr-reviewer" \
  --project-id my-project \
  --prompt 'You are a PR review agent. Report your status using annotations via the patch_session_annotations MCP tool.

## Getting Accurate Timestamps

CRITICAL: Run `date -u +%Y-%m-%dT%H:%M:%SZ` before writing any phase transition. NEVER guess timestamps.

## On Start
1. Set `work.acp.io/github/pr`, `work.acp.io/github/pr-url`, `work.acp.io/github/pr-status`
2. If there is a Jira issue, set `work.acp.io/jira/*` annotations
3. Run date command, set `work.acp.io/phases` to `[{"phase":"reviewing","start":"<timestamp>"}]`

## During Review
- Set `agent.acp.io/status` to describe what you are doing
- If you run tests locally, append `testing` phase
- If you fix code, append `implementing` phase

## On Completion
- Update `work.acp.io/github/pr-review` to your verdict
- Append `complete` phase
- Clear `agent.acp.io/status` (empty string)'
```

## Dashboard Behavior

### Needs You Queue

Sessions appear in the Needs You queue when:

- `agent.acp.io/status` is set (with criticality from `agent.acp.io/status-criticality`)
- Session phase is `Failed` (auto-critical)
- `agent.acp.io/needs-input` is set (auto-warning)

Items sort by criticality (critical → warning → info), then by wait time.

### In-Flight Work Cards

Sessions appear as in-flight work when:

- Session phase is `Running`, `Creating`, or `Pending`
- `work.acp.io/jira/status` is NOT `"Done"` (terminal Jira statuses are excluded)

Cards group by Jira issue key. Multiple sessions on the same issue merge into one card.

### Timeline

The Gantt timeline shows all sessions grouped by Jira issue. Bars render with:

- Multi-segment colors from `work.acp.io/phases` (when present)
- Single color from session phase (fallback)
- Running pulse, failed stripe, blocked hatching as status indicators

The timeline supports zoom (Ctrl/Cmd + scroll or +/− buttons) and time window presets (5m to 24h).

### Notification Bell

The topbar bell shows a badge count of Needs You items and opens a tray listing each item with criticality, status text, and wait time.

## Backward Compatibility

During migration from `ambient-code.io/*` to `*.acp.io`, the UI recognizes both namespaces. The `work.acp.io/*` keys take precedence when both are present.

| New Key | Legacy Key |
|---------|-----------|
| `work.acp.io/jira/issue` | `ambient-code.io/jira/issue` |
| `work.acp.io/github/pr` | `ambient-code.io/github/pr` |
| `agent.acp.io/needs-input` | `ambient-code.io/agent/needs-input` |
