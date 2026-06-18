# Work Tracking & Command Center Dashboard

## Purpose

Agents self-report their work status — Jira issue state, PR state, CI results, and blocked reasons — via annotations. The UI renders this agent-reported data into a command center dashboard that provides a single pane of glass over all in-flight, blocked, and recently completed work. No server-side polling of Jira or GitHub is required; agents are the source of truth for status updates.

This spec defines: (1) the new annotations agents write, (2) how the dashboard renders them, and (3) the URL companion convention that makes integration references clickable without the UI needing to know base URLs.

> **Prototype:** A static HTML/CSS/JS reference prototype is available at [`work-tracking-dashboard-prototype.html`](work-tracking-dashboard-prototype.html). This prototype is a **loose reference** for the visual direction and interaction patterns — not a prescriptive layout or design. Implementation should follow the spec requirements and the project's design system; the prototype illustrates intent and can be used for stakeholder feedback.

> **Namespace:** This spec uses `*.acp.io` annotation keys (e.g., `work.acp.io/jira/issue`). The namespace convention — ownership rules, GitOps vs. runtime preservation semantics, and migration path from `ambient-code.io/*` — is defined in a separate namespace specification. Until the namespace spec is finalized, the key structure defined here is authoritative; only the domain suffix may change.

## Requirements

### Requirement: Agent-Reported Work Annotations

Agents SHALL report work item status by writing annotations to their own sessions via the `patch_session_annotations` MCP tool (provided by the ambient-mcp component). These annotations are the source of truth for the dashboard — the platform SHALL NOT poll Jira, GitHub, or any external system for status. Agents update annotations as they make progress.

> **Data freshness:** Work tracking annotations are agent-reported and reflect the agent's last observation of external systems. They MAY be stale if the agent has not recently checked Jira or GitHub. The dashboard SHALL display reported values without server-side validation.

**Work tracking annotations (agent-written, runtime-owned):**

| Key | Example Value | Purpose |
|-----|---------------|---------|
| `work.acp.io/jira/issue` | `"ACP-1432"` | Jira issue key |
| `work.acp.io/jira/url` | `"https://issues.redhat.com/browse/ACP-1432"` | Clickable URL to the Jira issue |
| `work.acp.io/jira/status` | `"In Progress"` | Agent-reported Jira issue status |
| `work.acp.io/jira/summary` | `"Add RBAC to session create"` | Jira issue summary/title |
| `work.acp.io/github/pr` | `"org/repo#318"` | GitHub PR reference |
| `work.acp.io/github/pr-url` | `"https://github.com/org/repo/pull/318"` | Clickable URL to the PR |
| `work.acp.io/github/pr-status` | `"open"` | PR state: `open`, `closed`, `merged`, `draft` |
| `work.acp.io/github/pr-checks` | `"passing"` | CI check rollup: `passing`, `failing`, `pending` |
| `work.acp.io/github/pr-review` | `"approved"` | Review state: `approved`, `changes-requested`, `pending`, `none` |
| `work.acp.io/phases` | `[{"phase":"implementing","start":"..."}]` | JSON array of work lifecycle phase transitions. Valid phases: `implementing`, `reviewing`, `testing`, `deploying`. Agents append entries; the UI renders multi-segment timeline bars from this data. |
| `agent.acp.io/status` | `"Blocked: Upstream PR not merged"` | Free-text status label for the Needs You queue |
| `agent.acp.io/status-criticality` | `"critical"` | Criticality: `critical`, `warning`, `info`. Drives sort, color, icon |

All `work.acp.io/*` annotations are runtime-owned: `acpctl apply` SHALL preserve them (not overwrite from YAML).

#### Scenario: Agent sets Jira and PR annotations

- GIVEN an agent begins work on Jira issue ACP-1432
- WHEN the agent writes `work.acp.io/jira/issue: "ACP-1432"` and `work.acp.io/jira/url: "https://issues.redhat.com/browse/ACP-1432"`
- THEN the session's annotations are updated via the API
- AND the dashboard reflects the Jira reference within the next polling interval

#### Scenario: Agent updates PR status after CI completes

- GIVEN a session with `work.acp.io/github/pr: "org/repo#318"` and `work.acp.io/github/pr-checks: "pending"`
- WHEN the agent observes CI has passed and writes `work.acp.io/github/pr-checks: "passing"`
- THEN the dashboard updates the CI badge on that work item card

#### Scenario: Agent updates Jira status

- GIVEN a session with `work.acp.io/jira/status: "In Progress"`
- WHEN the agent transitions the Jira issue and writes `work.acp.io/jira/status: "In Review"`
- THEN the dashboard updates the Jira status badge on that work item card

#### Scenario: URL annotation makes reference clickable

- GIVEN a session with `work.acp.io/jira/issue: "ACP-1432"` and `work.acp.io/jira/url: "https://issues.redhat.com/browse/ACP-1432"`
- WHEN the UI renders the Jira chip
- THEN clicking the chip opens the URL in a new tab
- AND the chip displays the issue key ("ACP-1432"), not the URL

#### Scenario: URL annotation missing (graceful degradation)

- GIVEN a session with `work.acp.io/jira/issue: "ACP-1432"` but no `work.acp.io/jira/url` annotation
- WHEN the UI renders the Jira chip
- THEN the chip displays "ACP-1432" as plain text (not clickable)
- AND no error is shown

### Requirement: Needs-Input Annotation (Migration)

The existing `ambient-code.io/agent/needs-input` annotation SHALL be migrated to the `*.acp.io` namespace as `agent.acp.io/needs-input`. The value semantics are unchanged: `"approval"`, `"clarification"`, `"credentials"`, `"review"`.

Sessions with this annotation SHALL surface in the Dashboard attention column and SHALL display a distinct amber badge in the Sessions table.

> **Migration:** During the transition period, the UI SHALL recognize both `ambient-code.io/agent/needs-input` and `agent.acp.io/needs-input`. The old key takes lower precedence if both are present.

#### Scenario: Agent flags need for input (new key)

- GIVEN a Running session where the agent writes `agent.acp.io/needs-input: "approval"`
- WHEN the Dashboard renders
- THEN the attention column includes this session with label "Waiting for approval"
- AND the Sessions table shows an amber "Needs Input" badge on this session's row

#### Scenario: Backward compatibility during migration

- GIVEN a session with `ambient-code.io/agent/needs-input: "clarification"` (old key)
- WHEN the Dashboard renders
- THEN it is treated identically to `agent.acp.io/needs-input: "clarification"`

### Requirement: Dashboard Layout and View Toggle

The Dashboard SHALL support two view modes, toggled via a segmented control (List / Timeline):

**List view (default):** Vertical sections — Needs You queue, Running sessions, Completed Today — using a unified row grammar (see below).

**Timeline view:** A horizontal Gantt-style swim-lane chart showing all sessions on a time axis, grouped by Jira issue (see Timeline requirement below).

Both views share the same summary bar and notification bell.

#### Scenario: View toggle

- GIVEN the dashboard is in List view
- WHEN the user clicks the "Timeline" toggle
- THEN the list sections are hidden and the Gantt timeline is displayed
- AND switching back to "List" restores the list sections

#### Scenario: Responsive layout

- GIVEN the Dashboard is displayed on a viewport narrower than the tablet breakpoint
- WHEN the layout adapts
- THEN sections stack vertically and the timeline scrolls vertically if needed

### Requirement: Unified Row Grammar

All tabular sections (Needs You, Running, Completed detail) SHALL use a single shared grid template so the eye can build one scanning pattern across the entire dashboard. The grid columns SHALL be:

1. **Status stripe** (4px) — left border colored by criticality/state, transparent when neutral
2. **Status cell** (~120-148px) — severity label+icon (Needs You), phase pill (Running), result badge (Completed)
3. **Issue + summary** (flex) — Jira key + description text, consistent position across all sections
4. **PR** (72px) — PR reference in mono
5. **Agent** (~110px) — clickable agent name link
6. **Meta** (80px) — wait time (Needs You), activity timestamp (Running), duration (Completed)
7. **Action** (88px fixed) — action button when applicable, empty otherwise
8. **Links** (52px) — external Jira/PR icon links

Each section SHALL have column headers (Status, Issue, PR, Agent, and a section-specific meta label).

#### Scenario: Consistent scanning across sections

- GIVEN the Needs You, Running, and Completed sections are all visible
- WHEN the user scans vertically
- THEN issue keys, agent names, and PR references appear in the same column positions across all sections

### Requirement: Notification Bell

The topbar SHALL display a persistent notification bell icon with a badge count showing the number of items in the Needs You queue. Clicking the bell opens a dropdown tray listing each item with its criticality, status text, Jira key, and wait time.

The bell provides a persistent attention indicator that is visible regardless of scroll position or active view mode.

#### Scenario: Bell badge with active items

- GIVEN 5 sessions have `agent.acp.io/status` set
- WHEN any page renders
- THEN the topbar bell shows a badge with "5"
- AND clicking the bell opens a tray listing all 5 items

#### Scenario: Bell with no items

- GIVEN no sessions have `agent.acp.io/status` set and no sessions are Failed
- WHEN any page renders
- THEN the bell has no badge
- AND clicking it shows an empty tray with "All clear"

### Requirement: Agent-Reported Status Annotations

Agents SHALL report their operational status via two annotations that drive the Needs You queue:

| Key | Example Value | Purpose |
|-----|---------------|---------|
| `agent.acp.io/status` | `"Blocked: Upstream PR not merged"` | Free-text status label displayed in the Needs You queue. The agent controls the exact wording. |
| `agent.acp.io/status-criticality` | `"critical"` | Criticality level that determines sort order, border color, and icon. Values: `critical`, `warning`, `info`. |

The `status` annotation is the display text — the agent writes whatever is most useful for the operator (e.g., `"Waiting for approval"`, `"CI failing on ARM"`, `"Blocked: upstream PR not merged"`). The `status-criticality` annotation determines how the status is visually presented:

| Criticality | Sort Order | Border Color | Icon | Use Case |
|-------------|-----------|--------------|------|----------|
| `critical` | 1 (top) | danger-orange (`--danger`) | X-circle | Failed sessions, blocked work, CI failures |
| `warning` | 2 | warning-amber (`--status-warning-border`) | Alert triangle | Needs human input, review requested, stale |
| `info` | 3 (bottom) | interaction-blue (`--primary`) | Info circle | FYI items, non-urgent notifications |

When `agent.acp.io/status-criticality` is absent, the default is `warning`.

#### Scenario: Agent sets custom status

- GIVEN an agent writes `agent.acp.io/status: "CI failing on ARM — needs maintainer"` and `agent.acp.io/status-criticality: "critical"`
- WHEN the Needs You queue renders
- THEN the row displays "CI failing on ARM — needs maintainer" as the status label
- AND the row has a danger-orange left border stripe and an X-circle icon
- AND the row sorts above any `warning` or `info` items

#### Scenario: Agent clears status

- GIVEN an agent removes the `agent.acp.io/status` annotation (sets value to empty string)
- WHEN the dashboard re-renders
- THEN the session no longer appears in the Needs You queue

### Requirement: Needs You Queue

The Needs You section SHALL show all sessions that have an `agent.acp.io/status` annotation set. Additionally, sessions with phase `Failed` SHALL always appear in the queue (using the phase as the status label and `critical` as the criticality).

Items SHALL be sorted by criticality (critical first, then warning, then info), then by wait time descending within each criticality tier.

Each row SHALL display: status label (from annotation), issue+summary, PR reference, agent name, wait time, action button, and external links — using the unified row grammar.

#### Scenario: Mixed attention items

- GIVEN one failed session with `work.acp.io/jira/issue: "ACP-1398"`, one session with `agent.acp.io/needs-input: "approval"`, and one with `ambient-code.io/review/status: "changes-requested"`
- WHEN the attention column renders
- THEN it shows three items with badges: [Failed], [Needs Input], [Changes Requested]
- AND each item shows the Jira key or PR reference as a clickable link (when URL annotation is present)

#### Scenario: No attention items

- GIVEN no sessions require attention
- WHEN the Dashboard renders
- THEN the attention section shows a muted "All clear" state
- AND the sidebar badge count is not displayed

### Requirement: Blocked Sessions

Sessions where the agent has signaled a blocking dependency SHALL appear in the Needs You queue with the agent-reported status text and `critical` criticality. The `agent.acp.io/status` annotation carries the blocking reason (e.g., `"Blocked: Upstream PR not merged"`).

#### Scenario: Agent blocked on upstream dependency

- GIVEN a Running session where the agent writes `agent.acp.io/status: "Blocked: Upstream PR not merged"` and `agent.acp.io/status-criticality: "critical"`
- WHEN the Needs You queue renders
- THEN the session appears with the agent's status text, a danger-orange border stripe, and an X-circle icon

### Requirement: In-Flight Work Cards

The right column SHALL display in-flight work as cards. A work item is in-flight when at least one session referencing it has phase `Running`, `Creating`, or `Pending`.

Work items SHALL be identified by their `work.acp.io/jira/issue` or `work.acp.io/github/pr` annotation. Multiple sessions referencing the same work item SHALL be grouped into a single card.

Each card SHALL display:
1. **Header:** Jira issue key + status badge (from `work.acp.io/jira/status`). Clickable if URL annotation present.
2. **PR row:** PR reference + PR status badge + CI checks badge. Clickable if URL annotation present.
3. **Agent row:** Agent name(s) working on this item.
4. **Footer:** Last updated timestamp (relative).

#### Scenario: Work item card with full annotations

- GIVEN a session with:
  - `work.acp.io/jira/issue: "ACP-1432"`, `work.acp.io/jira/url: "https://..."`, `work.acp.io/jira/status: "In Progress"`
  - `work.acp.io/github/pr: "org/repo#318"`, `work.acp.io/github/pr-url: "https://..."`, `work.acp.io/github/pr-status: "open"`, `work.acp.io/github/pr-checks: "passing"`
- WHEN the in-flight section renders
- THEN a card appears with:
  - "ACP-1432" as a clickable link with [In Progress] badge
  - "PR #318" as a clickable link with [Open] badge and [CI Passing] badge
  - Agent name and "Updated 4m ago"

#### Scenario: Work item card without PR

- GIVEN a session with `work.acp.io/jira/issue: "ACP-1440"` and `work.acp.io/jira/status: "To Do"` but no PR annotations
- WHEN the in-flight section renders
- THEN the card shows the Jira issue with status but no PR row
- AND the card is visually complete (no empty space or "—" placeholder for PR)

#### Scenario: Multiple sessions on same work item

- GIVEN two Running sessions both with `work.acp.io/jira/issue: "ACP-1432"`
- WHEN the in-flight section renders
- THEN a single card appears for ACP-1432
- AND the agent row shows both agent names

#### Scenario: Work item with only PR (no Jira)

- GIVEN a session with `work.acp.io/github/pr: "org/repo#320"` and `work.acp.io/github/pr-status: "open"` but no Jira annotations
- WHEN the in-flight section renders
- THEN a card appears with the PR reference as the primary identifier
- AND no Jira row is shown

#### Scenario: No in-flight work

- GIVEN no sessions are in active phases with work annotations
- WHEN the in-flight section renders
- THEN a centered empty state shows "No active work items"

### Requirement: Recent Completions Table

The bottom zone SHALL display a compact table of recently completed work items spanning the full viewport width. A work item is complete when all sessions referencing it are in terminal phase (`Completed`, `Failed`, `Stopped`).

The table SHALL display: Work item reference (Jira key or PR), Result badge (Merged / Completed / Failed), PR reference, Agent, Duration, and Completion time.

The table SHALL show the 10 most recent completions, sorted by completion time descending.

#### Scenario: Recent completions rendering

- GIVEN 15 sessions in terminal phases, some with work annotations
- WHEN the Recent Completions table renders
- THEN the 10 most recently completed work items appear
- AND each row shows the work item reference, result, PR, agent, duration, and completion time

### Requirement: Annotation Registration

All new `work.acp.io/*` and `agent.acp.io/*` annotation keys SHALL be added to the UI annotation registry. The registry entry SHALL include the key, category, label, and icon.

New categories SHALL be added to the `AnnotationCategory` type as needed:
- `work` — for `work.acp.io/*` annotations
- Existing `agent` category is reused for `agent.acp.io/*`

#### Scenario: New annotations appear in registry

- GIVEN the annotation registry is updated with `work.acp.io/jira/issue`
- WHEN a session with that annotation is rendered in any view
- THEN the annotation produces a styled chip (icon + label + value)

#### Scenario: Status annotations render as badges

- GIVEN a session with `work.acp.io/jira/status: "In Progress"`
- WHEN the annotation is rendered
- THEN it appears as a colored badge: "In Progress" = blue, "Done" = green, "Blocked" = red, "To Do" = gray

### Requirement: Real-Time Updates

Work tracking annotations SHALL be reflected in the dashboard within the existing polling intervals (1s for transitioning sessions, 3s for running sessions). No additional polling mechanism is required — the existing React Query adaptive polling on the sessions list endpoint is sufficient.

#### Scenario: Annotation update reflected without page refresh

- GIVEN the dashboard is open and an agent updates `work.acp.io/github/pr-checks` from `"pending"` to `"passing"`
- WHEN the next polling interval fires
- THEN the CI badge on the work item card updates from [Pending] to [Passing]
- AND no manual page refresh is required

### Requirement: Work Annotations in Sessions Table

The Sessions table's Work Item column SHALL recognize `work.acp.io/*` annotations in addition to the existing `ambient-code.io/*` keys (during migration). The `work.acp.io/*` keys take precedence when both are present.

The priority order for the Work Item column SHALL be: `work.acp.io/jira/issue` → `work.acp.io/github/pr` → `ambient-code.io/jira/issue` → `ambient-code.io/github/pr` → `ambient-code.io/gitlab/mr` → `ambient-code.io/gerrit/change`.

#### Scenario: Sessions table shows new annotation

- GIVEN a session with `work.acp.io/jira/issue: "ACP-1432"` and `work.acp.io/jira/url: "https://..."`
- WHEN the Sessions table renders
- THEN the Work Item column shows a clickable "ACP-1432" chip with a Jira icon

#### Scenario: Both old and new annotations present

- GIVEN a session with both `ambient-code.io/jira/issue: "OLD-100"` and `work.acp.io/jira/issue: "ACP-1432"`
- WHEN the Sessions table renders
- THEN the Work Item column shows "ACP-1432" (new key takes precedence)

### Requirement: Timeline View

The Timeline view SHALL display a horizontal Gantt-style chart with sessions as colored bars on a wall-clock time axis.

**Grouping:** Sessions SHALL be grouped by Jira issue key. Sessions sharing the same `work.acp.io/jira/issue` value appear as a collapsible group labeled by the Jira key. Sessions without a Jira annotation appear as ungrouped individual lanes labeled by agent name.

**Ordering:** Groups SHALL be sorted by most recent activity (latest session start time) descending — most recent work at the top.

**Collapsing:** All groups SHALL default to collapsed (all bars stacked in one lane). Clicking a group header expands it to show individual agent sub-lanes.

**Phase segments:** Each bar SHALL be divided into segments colored by lifecycle phase (implementing, reviewing, testing, deploying). Bar patterns distinguish status: solid = completed, open right edge with pulse = running, diagonal hatching = blocked, danger-colored = failed.

**Fit to screen:** The timeline SHALL auto-scale to fit the viewport width without horizontal scrolling. The "now" marker SHALL be visible at the right edge.

**Hover popover:** Hovering a bar SHALL show a rich popover with:
- Jira key + summary as a title (with phase badge top-right)
- Agent name as a clickable session link
- Time range and duration
- Jira and PR links in a footer (bottom-left), "View Session →" (bottom-right)
- Recent session messages with live streaming indicator for running sessions

**Keyboard accessible:** Bars SHALL be keyboard-focusable. Focus SHALL open the popover. Escape SHALL dismiss it and return focus.

#### Scenario: Timeline with multi-agent Jira groups

- GIVEN three sessions for Jira issue AIHCM-177 (jira-refiner completed, implementer running, reviewer running)
- WHEN the Timeline view renders with the group collapsed
- THEN one lane labeled "AIHCM-177" shows all three bars stacked
- AND clicking the group header expands to three sub-lanes (one per agent)

#### Scenario: Ungrouped sessions

- GIVEN a session with no `work.acp.io/jira/issue` annotation (e.g., a nightly benchmark run)
- WHEN the Timeline view renders
- THEN the session appears as an individual lane labeled by agent name, with no collapse chevron

#### Scenario: Timeline fits viewport

- GIVEN sessions spanning 9:00 AM to 2:45 PM
- WHEN the Timeline view renders
- THEN the entire time range fits within the viewport width
- AND the "now" marker is visible at the right edge without scrolling

### Requirement: Staleness Indicator

Running session rows SHALL display a staleness indicator when the agent has not produced recent activity. A session is considered stale when `session.lastActivityAt` is older than 15 minutes. The `lastActivityAt` field is updated by the API server each time a session message is pushed (see `specs/platform/session-activity-tracking.spec.md`).

Stale sessions SHALL display an amber "Stale" indicator with a tooltip explaining the threshold. The session title link remains the primary action path for investigating stale sessions.

#### Scenario: Stale session detected

- GIVEN a running session whose `lastActivityAt` is older than 15 minutes
- WHEN the dashboard renders
- THEN the session row displays an amber "Stale" indicator with text "Stale · Xm ago"
- AND a tooltip explains: "No messages or tool calls received for over 15 minutes"

#### Scenario: Fresh session

- GIVEN a running session whose `lastActivityAt` is 3 minutes old
- WHEN the dashboard renders
- THEN no staleness indicator is shown

#### Scenario: Unrecognized needs-input value

- GIVEN a session with `agent.acp.io/needs-input: "unknown-value"` (a value not in the known human-action or blocked sets)
- WHEN the Dashboard renders
- THEN the session appears in the Attention section (not the Blocked section)
- AND the badge displays the raw value

### Requirement: Work View Integration

The command center dashboard SHALL serve as the project landing page, superseding the standalone Work View (defined in `views.spec.md`) for work item aggregation. The List/Timeline toggle provides two complementary lenses on the same data — the tabbed artifact view from the former Work View is no longer a separate section.
