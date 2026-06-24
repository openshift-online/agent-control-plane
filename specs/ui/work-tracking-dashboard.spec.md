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
| `work.acp.io/phases` | `[{"phase":"implementing","start":"..."}]` | JSON array of work lifecycle phase transitions. Valid phases: `implementing`, `reviewing`, `testing`, `deploying`, `complete`. Agents append entries (read-append-write); the UI renders multi-segment timeline bars from this data. Timestamps MUST be accurate UTC — agents should use `date -u +%Y-%m-%dT%H:%M:%SZ` before each write. |
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

**List view (default):** Vertical sections — Needs You queue, In-flight work, Completed Today — all using a unified row grammar (see below). No summary counts bar — the section headings with counts serve this purpose.

**Timeline view:** A horizontal Gantt-style swim-lane chart showing all sessions on a time axis, grouped by Jira issue (see Timeline requirement below). Lazy-loaded via `dynamic()` since List is the default.

The dashboard SHALL be the project landing page — both the project card on the picker page and the sidebar project selector SHALL navigate to `/${projectId}` (the dashboard), not `/${projectId}/sessions`.

Both views share the notification bell. The sidebar SHALL preserve project context on global pages (e.g., Credentials) and never disable navigation items.

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

All tabular sections (Needs You, In-flight work, Completed detail) SHALL use a single shared grid template so the eye can build one scanning pattern across the entire dashboard. The grid columns SHALL be:

1. **Spacer** (4px) — visual breathing room
2. **Status cell** (~160-240px) — severity label+icon with line-clamp-2 (Needs You), phase pill (In-flight), result badge (Completed)
3. **Issue + summary** (flex) — Jira key chip (with hover card showing details) + description text
4. **PR** (72px) — PR reference chip (shortened to `#N` with full ref in tooltip)
5. **Agent** (~110px) — clickable agent name linking to agent definition page
6. **Meta** (80px) — "Since" time (Needs You), "Updated" timestamp (In-flight), duration (Completed)
7. **Action** (88px fixed) — "View session" button when applicable

Jira chips and PR chips are clickable when URL annotations are present — no separate external links column is needed. Container queries (`@md`, `@lg`) control responsive column visibility.

Each section SHALL have column headers. The In-flight work section uses the same row grammar as the other sections (not cards).

#### Scenario: Consistent scanning across sections

- GIVEN the Needs You, Running, and Completed sections are all visible
- WHEN the user scans vertically
- THEN issue keys, agent names, and PR references appear in the same column positions across all sections

### Requirement: Notification Bell

The topbar SHALL display a persistent notification bell icon with a badge count showing the number of **actionable** items (criticality `critical` or `warning` only — `info` level items are excluded). Clicking the bell opens a Popover tray listing each actionable item with its criticality icon, status text (full wrap, not truncated), Jira key, agent name, and wait time.

The bell provides a persistent attention indicator visible regardless of scroll position or active view mode. It shares the same React Query cache as the dashboard's `useSessions` call.

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

Each row SHALL display: criticality icon + status label (line-clamp-2 with tooltip for overflow), Jira chip (with hover card), PR chip, agent name, "Since" time, and "View session" button — using the unified row grammar.

**Visual escalation:** When any item has `critical` criticality, the section wrapper SHALL display a red-tinted border (`border-destructive/50`) and background (`bg-destructive/5`) to draw immediate attention. The heading count SHALL use `text-destructive font-bold`.

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

### Requirement: In-Flight Work Rows

The In-flight work section SHALL display active work items using the unified row grammar (not cards). A work item is in-flight when at least one session referencing it has phase `Running`, `Creating`, or `Pending`, AND `work.acp.io/jira/status` is NOT a terminal status (e.g., `"Done"`).

Work items SHALL be identified by their `work.acp.io/jira/issue` or `work.acp.io/github/pr` annotation. Multiple sessions referencing the same work item SHALL be grouped into a single row.

Each row SHALL display (using unified row grammar):
1. **Phase pill** — PhaseBadge for the session phase
2. **Jira key + summary** — clickable chip with hover card, plus Jira status badge
3. **PR chip** — shortened to `#N` with full ref in tooltip
4. **Agent** — comma-separated agent names if multiple sessions, clickable to agent definition
5. **Updated** — relative timestamp
6. **View session** — link to the first session in the group

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

The table SHALL show the 10 most recent completions, sorted with failures first (`Failed` → `Stopped` → `Completed`), then by completion time descending within each result tier.

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

**Phase segments:** Each bar SHALL be divided into segments colored by lifecycle phase from `work.acp.io/phases`. Phase colors (Red Hat palette): implementing=#0066cc (interaction-blue-50), reviewing=#5e40be (purple-50), testing=#37a3a3 (teal-50), deploying=#f5921b (orange-40), complete=#63993d (success-green-50). Color only — no CSS patterns (removed for simplicity per Tufte review). Sessions without phases use a single color based on session phase.

**Session status border:** Each bar SHALL display a 4px bottom border colored by session infrastructure phase: Running=#63993d (success-green-50), Failed=#f0561d (danger-orange-50), Pending/Creating=#f5921b (orange-40), Completed/Stopped=#a3a3a3 (gray-40). This provides a second visual channel: bar segments = work lifecycle, bottom border = session status.

**Bar animation:** Bars SHALL animate smoothly between poll cycles via CSS `transition` on width/left (300ms ease-out).

**Phase segment clamping:** When a time window is selected, segments SHALL be clamped to the visible range — phases that ended before the window start are hidden, and the visible portion of each phase is proportional to its duration within the window.

**Fit to screen:** The timeline SHALL auto-scale to fit the viewport width without horizontal scrolling at default zoom. The "now" marker SHALL be visible at the right edge.

**Zoom:** Users can zoom into the timeline via Ctrl/⌘ + scroll wheel, or +/− buttons. Zooming scales only the lane area — the label column stays fixed width via `position: sticky`. A "Reset" button returns to 1× zoom. The current zoom level is shown as a percentage.

**Time window:** A dropdown selector provides preset time windows: Auto (fit all sessions), Last 5m, 15m, 30m, 1h, 6h, 12h, 24h. Selecting a preset overrides the auto-computed time range.

**Legend:** Single row above the chart showing phase color swatches (Implementing, Reviewing, Testing, Deploying, Complete). Zoom controls and time window selector appear to the right of the legend, all at consistent `h-7` height with tooltips on +/−/reset buttons.

**Hover popover:** Hovering a bar SHALL show a rich popover (controlled Popover with hover open/close behavior, 120ms open delay, 250ms close delay). The popover includes:
- 5px colored top border matching the current work phase
- Session summary as title, with session phase badge and tinted work phase pill
- Blocked/attention banner (red) when `agent.acp.io/status-criticality` is `critical`
- Agent name as a clickable link to the agent definition page
- Time range and duration
- Recent session messages (3 most recent) with typing indicator for running sessions (skipped for terminal sessions)
- Footer: Jira and PR links (left), "Chat Log" button that opens the chat sidebar (right) — distinct from the queue's "View session" navigation link
- Popover arrow connecting card to bar

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

### Requirement: Work Lifecycle Phases

Agents SHALL report their work lifecycle progression via the `work.acp.io/phases` annotation — a JSON-encoded array of phase transition objects, each with a `phase` name and an ISO 8601 UTC `start` timestamp.

**Valid phases:** `implementing`, `reviewing`, `testing`, `deploying`, `complete`

**Convention:** Agents MUST use `date -u +%Y-%m-%dT%H:%M:%SZ` to obtain accurate timestamps before each write. Agents MUST read the current annotation value, parse the array, append the new entry, and write the full array back. Overwriting with a single entry discards transition history.

The dashboard timeline renders these phases as multi-segment colored bars. When no phases annotation is present, bars fall back to a single color based on session infrastructure phase.

In-flight work cards SHALL exclude sessions where `work.acp.io/jira/status` is a terminal status (e.g., `"Done"`), even if the session is still Running.

#### Scenario: Agent reports phase transitions

- GIVEN an agent starts implementing at 10:00 AM and transitions to reviewing at 10:30 AM
- WHEN the timeline renders
- THEN the bar shows a blue (implementing) segment from 10:00–10:30 and a purple (reviewing) segment from 10:30 onward

#### Scenario: Completed work

- GIVEN an agent appends `{"phase":"complete","start":"..."}` to the phases array
- WHEN the timeline renders
- THEN the bar shows a dark green (complete) segment at the end

#### Scenario: No phases annotation (fallback)

- GIVEN a session with no `work.acp.io/phases` annotation
- WHEN the timeline renders
- THEN the bar is a single color based on session phase (green for Running, blue for Completed, etc.)

### Requirement: Agent Annotations Tab

The agent detail page SHALL include an "Annotations" tab showing key/value tables for agent-level annotations and (when an active session exists) current session annotations. Annotations are sorted alphabetically and displayed in monospace font. Session annotations auto-refresh via existing polling.

### Requirement: Navigation and Landing

The dashboard SHALL be the project landing page:
- Project cards on the picker page navigate to `/${projectId}` (dashboard)
- Sidebar project selector navigates to `/${projectId}` (dashboard)
- Sidebar navigation SHALL preserve project context on global pages (e.g., Credentials) and never disable nav items when a project is selected

### Requirement: Work View Integration

The command center dashboard SHALL serve as the project landing page, superseding the standalone Work View (defined in `views.spec.md`) for work item aggregation. The List/Timeline toggle provides two complementary lenses on the same data — the tabbed artifact view from the former Work View is no longer a separate section.
