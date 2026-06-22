# Views

## Dashboard (Default Landing Page)

The Dashboard is defined in [`work-tracking-dashboard.spec.md`](work-tracking-dashboard.spec.md). It serves as the default landing page and unified work view, superseding the former standalone Work View.

---

## Sessions View (Session Monitoring)
## Requirement: Session Table

The Sessions view SHALL display a table of all sessions in the active project. Each row SHALL show operational data answering: "Does this session need my attention?"

The table SHALL display: Phase (with activity indicator), Work Item (primary integration annotation as chip), Review Status (from `ambient-code.io/review/status`), Session Name, Agent, Duration, Last Activity, Cost, and Chat action.

The Work Item column SHALL show the first matching integration annotation in priority order: Jira issue, then GitHub PR, then GitLab MR, then Gerrit change. Sessions without integration annotations display "—". The Review Status column SHALL render as a colored badge: `needs-review` = amber, `approved` = green, `changes-requested` = red.

Phase SHALL be the single status indicator. There SHALL NOT be a separate "Status" column. When a session is Running and the agent is actively working, the Phase badge SHALL display a pulsing indicator.

Cost is annotation-driven: the UI reads the `ambient-code.io/cost/estimate` annotation value. Sessions without this annotation display "—" in the Cost column.

### Scenario: Sessions table rendering

- GIVEN a project with 15 sessions in various phases
- WHEN the Sessions view renders
- THEN each session appears as a single-line row
- AND the Phase badge shows: Running (green), Completed (blue), Failed (red), Stopped (gray), Pending (amber)
- AND Running sessions with active agents show a pulsing dot on the Phase badge

### Scenario: Sessions filtering

- GIVEN the Sessions table is displayed
- WHEN the user types in the search field or selects a phase filter
- THEN the table filters to matching sessions
- AND summary stats update to reflect the filtered set

### Scenario: Empty fleet

- GIVEN a project with no sessions
- WHEN the Sessions view renders
- THEN a centered empty state is displayed with an explanation and suggested action

## Requirement: Registered Annotation Indicators

Sessions with registered annotations SHALL display compact visual indicators in the Sessions table. Indicators SHALL appear as small, muted icons to the right of the session name — never as inline chips that break the table's horizontal scan line.

Only annotations with registered keys SHALL produce indicators. Unregistered annotations SHALL NOT produce any visual element in the Sessions table or any other operational view.

Full annotation details SHALL be available on hover (as a popover) or in the session detail view.

### Scenario: Annotation indicators in fleet

- GIVEN a session with annotations `ambient-code.io/jira/issue: "HYPERFLEET-234"` and `ambient-code.io/github/pr: "org/repo#1847"`
- WHEN the Sessions table renders
- THEN the session row shows small muted icons (Jira icon, PR icon) next to the session name
- AND hovering over the session name reveals a popover with full annotation details

### Scenario: Unregistered annotation ignored

- GIVEN a session with annotation `ambient-code.io/desired-phase: "Running"`
- WHEN the session appears in the Sessions table or any operational view
- THEN no visual element is produced for that annotation

## Requirement: Virtual Folder Tree (ambient-code.io/ui/path)

Sessions with an `ambient-code.io/ui/path` annotation SHALL be organizable into a virtual folder hierarchy. The folder tree SHALL be toggleable — hidden by default, shown when the user activates it.

The annotation value is a forward-slash-delimited string (e.g., `"backend/auth"`). The UI SHALL parse these into a tree structure. This is a flat namespace rendered as a tree — like S3 prefixes.

### Scenario: Folder tree activation

- GIVEN sessions with `ambient-code.io/ui/path` annotations like `"backend/auth"`, `"backend/testing"`, `"infra/networking"`
- WHEN the user toggles the folder tree
- THEN a tree panel appears showing the parsed hierarchy with session counts per node
- AND clicking a folder filters the Sessions table to sessions with that path prefix

## Requirement: Bulk Session Operations

The Sessions table SHALL support selecting multiple sessions and performing bulk operations.

### Scenario: Bulk stop

- GIVEN the user selects 3 Running sessions via checkboxes
- WHEN they click "Stop All" in the floating action bar
- THEN a confirmation is shown
- AND on confirm, all 3 sessions are stopped via the API

## Requirement: Session Detail (Workload Inspector)

Clicking a session in the Sessions table SHALL open a detail view with tabbed content. The detail view SHALL include a sticky action bar with session lifecycle controls.

**Action bar:** Stop (when Running), Restart (when terminal), Clone, Export, Delete. Destructive actions (Stop, Delete) SHALL require confirmation.

**Tabs:** Phase, Logs, Resources, Details, Chat.

### Scenario: Phase tab

- GIVEN a session in Running phase
- WHEN the Phase tab renders
- THEN it displays: compact phase timeline, Conditions table (with semantically correct colors), Pod Events, key metadata (session name, project, agent link, owner, timestamps)
- AND a collapsible Metrics section showing: tool call count, success/failure rate, average duration, message count, wall clock time, SDK restart count

Tool call metrics SHALL be computed client-side from SessionMessages (event types `tool_use` and `tool_result`). The API does not provide pre-computed metrics.

### Scenario: Conditions table semantic colors

- GIVEN a condition "InactivityTimeout: False"
- WHEN the Conditions table renders
- THEN the condition displays as green (healthy — timeout has NOT fired)
- AND "Ready: True" displays as green (healthy)
- AND "Error: True" displays as red (unhealthy)

Condition colors SHALL reflect semantic health, not literal True/False values. "Problem" conditions (InactivityTimeout, Error) invert the color mapping: True = red (bad), False = green (good).

### Scenario: Logs tab

- GIVEN a running session with AG-UI events
- WHEN the Logs tab renders
- THEN it displays a structured log view of events: timestamps, event type badges (text, tool call, error, lifecycle), content
- AND filter chips allow filtering by event type
- AND errors are visually prominent

### Scenario: Resources tab

- GIVEN a session with attached repos and MCP servers
- WHEN the Resources tab renders
- THEN repos show: name, URL, branch, clone status, cloned timestamp
- AND MCP servers show: name, type, status (connected/disconnected/error), tool count, last heartbeat

### Scenario: Details tab

- GIVEN a session with configuration and annotations
- WHEN the Details tab renders
- THEN it shows a Configuration section (model, temperature, max tokens, timeouts, workflow, env vars as key-value)
- AND an Annotations section with two parts:
  - Registered annotations rendered as rich cards (Jira ticket card, PR card, etc.) with enriched data when available, or raw values as fallback
  - Raw annotations table showing ALL annotations as key-value pairs (the "kubectl describe" view)

### Scenario: Chat tab (Full AG-UI)

- GIVEN a Running session
- WHEN the Chat tab renders
- THEN it displays a full AG-UI chat interface with messages
- AND user messages are styled distinctly from assistant messages
- AND assistant messages render as Markdown (headings, lists, code blocks, tables, links)
- AND tool calls render as collapsible blocks showing tool name, arguments (when available), and result
- AND the user can send messages via an input field (Enter to send, Shift+Enter for newline)
- AND the agent's current status is displayed as a phase badge near the input
- AND the input is disabled when the session is not in Running phase

Note: the runner currently persists one `assistant` message per turn (final text only). Intermediate assistant text and individual tool call arguments are not yet persisted as separate messages — they arrive via the operational event writer with tool name and result only. Full streaming with intermediate text requires the SSE-Driven Updates requirement.

## Requirement: Draft Message Persistence

The chat input SHALL persist unsent text to `localStorage` as the user types, scoped per session ID. If the user navigates away, refreshes, or is redirected by an auth flow, the draft SHALL be restored when they return to the same session.

Drafts SHALL be cleared when the message is successfully sent. Drafts SHOULD be cleared on explicit logout (`/api/auth/sso/logout`). Drafts older than 48 hours SHOULD be silently discarded on read.

The storage key format SHALL be `ambient-draft:{sessionId}`. The stored value SHALL include the text and a timestamp.

### Scenario: Draft survives page reload

- GIVEN a user has typed "review the PR" in the chat input for session A
- WHEN the page reloads (browser refresh or auth redirect)
- THEN the chat input for session A is pre-filled with "review the PR"

### Scenario: Draft cleared on send

- GIVEN a user has a draft for session A
- WHEN they send the message successfully
- THEN the draft for session A is removed from localStorage

### Scenario: Draft expires after 48 hours

- GIVEN a draft was saved 49 hours ago
- WHEN the user returns to that session
- THEN the draft is discarded and the input is empty

### Scenario: Drafts independent per session

- GIVEN drafts exist for session A and session B
- WHEN the user views session A
- THEN only session A's draft is restored
- AND session B's draft is unaffected

## Requirement: Persistent Chat Sidebar

The Ambient UI SHALL support popping a session's chat into a persistent sidebar panel that remains visible across page navigation. The sidebar allows the user to monitor and interact with an agent while performing other tasks in the UI.

Any view that displays a session (fleet table row, session detail header, chat tab) SHALL offer a control to open the chat sidebar for that session. Only one chat sidebar MAY be open at a time; opening a different session's chat SHALL replace the current one.

### Scenario: Open chat sidebar from Chat tab

- GIVEN the user is viewing a session's Chat tab
- WHEN the user clicks the "Pop out" button
- THEN the chat panel moves from the tab content area into a right-edge sidebar
- AND the Chat tab displays a message indicating the chat is open in the sidebar
- AND the sidebar shows the session name and phase badge

### Scenario: Open chat sidebar from fleet table

- GIVEN the user is viewing the fleet table
- WHEN the user clicks the chat icon on a session row
- THEN the chat sidebar opens for that session
- AND the fleet table remains visible alongside the sidebar

### Scenario: Sidebar persists across navigation

- GIVEN the chat sidebar is open for session A
- WHEN the user navigates to a different page (fleet list, another session, settings)
- THEN the sidebar remains open and continues displaying session A's chat
- AND new messages continue to appear via polling or SSE

### Scenario: Replace sidebar session

- GIVEN the chat sidebar is open for session A
- WHEN the user opens the chat sidebar for session B
- THEN the sidebar switches to session B's chat
- AND session A's chat is no longer displayed

### Scenario: Close sidebar

- GIVEN the chat sidebar is open
- WHEN the user clicks the close button on the sidebar
- THEN the sidebar dismisses
- AND if the user navigates back to the session's Chat tab, it renders inline again

### Scenario: Sidebar layout

- GIVEN the chat sidebar is open
- THEN it docks to the right edge of the viewport
- AND it is resizable by dragging the left edge
- AND it is collapsible to a narrow strip showing the session name
- AND the main content area shrinks to accommodate the sidebar

## Requirement: Timestamp Toggle

The Sessions table's "Last Activity" column SHALL support toggling between relative time ("12s ago") and absolute time ("10:42:18 AM EST").

### Scenario: Timestamp format toggle

- GIVEN the Sessions table displays relative timestamps
- WHEN the user clicks the toggle on the column header
- THEN all timestamps switch to absolute format with explicit timezone
- AND the preference persists for the session

---

## Agents View (Authoring Workbench)
The Agents view serves two personas: operators who need a quick registry glance, and agent authors who build, test, and iterate on agent definitions before codifying them for GitOps management via `acpctl apply`.

## Requirement: Agent Registry Table

The Agents view SHALL display a table of agents in the active project. The table SHALL display: Name, Source (prototype/production badge), Model, Owner, Current Session (clickable), Last Active.

Clicking an agent row SHALL navigate to the agent detail page.

The page SHALL include a "+ New Agent" button for creating agents directly in the UI.

### Scenario: Agent table rendering

- GIVEN a project with 5 agents
- WHEN the Agents view renders
- THEN each agent appears as a row with name, source badge, model, owner, current session link, and last active timestamp
- AND prototype agents display a "Draft" badge
- AND production agents (managed via GitOps) display a "GitOps" badge

### Scenario: Empty agents state

- GIVEN a project with no agents
- WHEN the Agents view renders
- THEN an empty state is displayed with a "Create Agent" action button

## Requirement: Agent Detail Page

Clicking an agent in the registry table SHALL navigate to a dedicated agent detail page at `/{projectId}/agents/{agentId}`. The detail page SHALL use a tabbed layout with three tabs: Overview, Sessions, Config.

The page header SHALL display the agent name, lifecycle badge (Draft/GitOps), and action buttons: "Run Test Session" and "Export YAML".

### Scenario: Overview tab (authoring surface)

- GIVEN an agent detail page for a Draft agent
- WHEN the Overview tab renders
- THEN it displays editable fields: prompt (textarea), model (select), repository URL, description
- AND a "Save Changes" action persists edits via the API
- AND registered annotations render with icons and labels

### Scenario: Overview tab (GitOps-managed agent)

- GIVEN an agent detail page for a GitOps-managed agent
- WHEN the Overview tab renders
- THEN fields are read-only with a banner: "This agent is managed via GitOps. Edits here will not persist."
- AND the "Run Test Session" action remains available

### Scenario: Sessions tab (test history)

- GIVEN an agent with 10 past sessions
- WHEN the Sessions tab renders
- THEN it displays a session table filtered to sessions for this agent
- AND each row shows phase, name, duration, cost, and created timestamp
- AND clicking a session navigates to the session detail page

### Scenario: Config tab (YAML export)

- GIVEN an agent detail page
- WHEN the Config tab renders
- THEN it displays a YAML preview of the agent definition (the format consumed by `acpctl apply`)
- AND "Copy to Clipboard" and "Download YAML" actions are available

### Scenario: Run Test Session

- GIVEN the user clicks "Run Test Session" on an agent detail page
- WHEN the create session sheet opens
- THEN the agent is pre-selected and the form is pre-filled with the agent's model, prompt, and repos
- AND the user can override any field before submitting
- AND on success, the new session appears in the agent's Sessions tab

## Requirement: Agent Lifecycle Badge

Agents SHALL display a lifecycle badge indicating whether they are managed in the UI (prototype/draft) or via GitOps (production). The badge SHALL be derived from the `ambient-code.io/managed-by` annotation:

- `ambient-code.io/managed-by: "gitops"` → "GitOps" badge (muted, with git-branch icon)
- No annotation or any other value → "Draft" badge (default)

### Scenario: Prototype agent

- GIVEN an agent without `ambient-code.io/managed-by` annotation
- WHEN it appears in the registry table or detail page
- THEN it displays a "Draft" badge
- AND all fields are editable in the Overview tab

### Scenario: Production agent

- GIVEN an agent with `ambient-code.io/managed-by: "gitops"`
- WHEN it appears in the registry table or detail page
- THEN it displays a "GitOps" badge
- AND fields are read-only in the Overview tab

## Requirement: Agent CRUD

The Agents view SHALL support creating, editing, and deleting agents.

### Scenario: Create agent

- GIVEN the user clicks "+ New Agent"
- WHEN the creation form opens
- THEN it displays fields: name (required), display name, model, prompt, repository URL, description
- AND submitting creates the agent via the API

### Scenario: Edit agent

- GIVEN the user edits fields on a Draft agent's Overview tab
- WHEN they click "Save Changes"
- THEN the agent is updated via the API
- AND a success notification confirms the save

### Scenario: Delete agent

- GIVEN the user clicks "Delete" on an agent
- WHEN confirmation is provided
- THEN the agent is deleted via the API
- AND the user is navigated back to the agents list

---

## Schedules View
## Requirement: Schedule Table

The Schedules view SHALL display cron schedules in the active project.

The table SHALL display: Name, Agent, Schedule (human-readable with explicit timezone), Next Run (absolute datetime with timezone), Last Run, Last Status (phase badge of most recent run), Enabled (toggle with confirmation).

Raw cron expressions SHALL be shown as hover detail, not inline text.

### Scenario: Human-readable schedule

- GIVEN a schedule with cron `"0 9 * * 1-5"` and timezone `"America/New_York"`
- WHEN the Schedules table renders
- THEN the Schedule column shows: "9:00 AM EST, Weekdays"
- AND hovering reveals the raw cron expression

### Scenario: Toggle confirmation

- GIVEN a user clicks the Enabled toggle for "nightly-benchmarks"
- WHEN the toggle is clicked
- THEN an inline confirmation appears: "Disable nightly-benchmarks? [Confirm] [Cancel]"
- AND the toggle does not change until confirmed

---

## Credentials View (Global)
## Requirement: Credential Registry

The Credentials view SHALL be global (not project-scoped). Credentials SHALL be grouped by category.

### Scenario: Category grouping

- GIVEN credentials of various providers
- WHEN the Credentials view renders
- THEN credentials are grouped in collapsible sections by category:
  - Source Control (GitHub, GitLab)
  - Project Management (Jira)
  - Cloud & Infrastructure (Google Cloud, Vertex AI, Kubernetes)

## Requirement: Credential-to-Agent Binding

Credentials SHALL be bindable to **specific agents** within a project OR to **all agents** in a project. This binding is expressed via RoleBindings with `scope=credential`.

The Credentials view SHALL display bindings as compact indicators showing the project name and either "(all agents)" or specific agent names.

To display bindings for a credential, the UI SHALL query `GET /api/ambient/v1/role_bindings` filtered by `credential_id`. The `GET /credentials/{cred_id}/role_bindings` scoped endpoint is planned but not yet implemented; the generic endpoint is the interim path.

Binding a credential to a project requires the user to hold `project:owner` on that project (per the security spec). The UI SHALL only show bindable projects where the user has `project:owner`.

### Scenario: Bind credential to all agents

- GIVEN the user manages credential "github-pat"
- AND the user holds `project:owner` on project "platform"
- WHEN they check project "platform" and select "All agents"
- THEN a RoleBinding is created with `credential_id=<cred>`, `project_id=<project>`, `agent_id=NULL`
- AND the credential row shows: "platform (all agents)"

### Scenario: Bind credential to specific agents

- GIVEN the user manages credential "jira-cloud"
- WHEN they check project "platform" and select "Specific agents" → "pr-reviewer", "bug-fixer"
- THEN RoleBindings are created with `credential_id=<cred>`, `project_id=<project>`, `agent_id=<each agent>`
- AND the credential row shows: "platform → pr-reviewer, bug-fixer"

## Requirement: Credential CRUD with Modals

The Credentials view SHALL provide Add and Manage modals for credential lifecycle operations.

The UI SHALL NOT access credential tokens. The `credential:token-reader` role is platform-internal and granted only to runner service accounts. The UI operates with `credential:owner` (CRUD) and `credential:viewer` (metadata read) roles.

### Scenario: Add credential

- GIVEN the user clicks "+ Add Credential"
- WHEN the modal opens
- THEN it displays: Category dropdown, Provider dropdown (filtered by category), Name field, dynamic provider-specific fields (Token, URL, Email as needed), and agent binding controls
- AND submitting creates the Credential and associated RoleBindings via the API

### Scenario: Rotate credential

- GIVEN the user clicks "Manage" on an existing credential
- WHEN they click "Rotate Token"
- THEN a confirmation is shown before proceeding
- AND on confirm, the credential is updated via PATCH with the new token

### Scenario: Delete credential

- GIVEN the user clicks "Delete" in the Manage modal
- WHEN confirmation is provided
- THEN the credential is soft-deleted via the API
- AND associated RoleBindings are removed

---

## Issues View

**Note:** The Issues view has been superseded by the Dashboard (see [`work-tracking-dashboard.spec.md`](work-tracking-dashboard.spec.md)).

---

## Settings View
## Requirement: Project Configuration

The Settings view SHALL provide project-scoped configuration management with tabbed sections.

**Tabs:** General (project metadata), Permissions (user/role management), API Keys (key lifecycle), Feature Flags (toggles with confirmation).

### Scenario: Feature flag toggle confirmation

- GIVEN the user clicks a feature flag toggle
- WHEN the toggle is clicked
- THEN an inline confirmation appears before applying the change

---
