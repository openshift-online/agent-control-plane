# Architecture

## Purpose
The Ambient UI is the platform's agentic SDLC operations dashboard. It serves two primary workflows: **operations monitoring** (high-frequency, low-duration — "what needs my attention?") and **agent authoring** (low-frequency, high-duration — building, testing, and iterating on agent definitions before codifying them for GitOps). The UI is organized around work outcomes (Jira tickets, PRs, reviews, incidents) rather than infrastructure primitives. Sessions and agents are the execution layer — accessible but secondary to the work they produce. It replaces the existing frontend over time but coexists functionally as a separate component during migration.

The Ambient UI interacts exclusively with the ambient-api-server API via the generated TypeScript SDK. It has no dependency on the legacy backend.

## Architecture
## Requirement: Next.js BFF with OIDC Authentication

The Ambient UI SHALL be a Next.js application acting as a Backend-for-Frontend (BFF). The BFF SHALL handle OIDC authentication as a confidential client, manage server-side sessions, and relay JWTs to the ambient-api-server. The browser SHALL never receive a raw JWT.

The BFF SHALL authenticate via Native SSO: OIDC Authorization Code Flow against a Keycloak or Red Hat SSO issuer. The BFF is the confidential client. Dev environments use a local Keycloak deployed in the Kind cluster.

### Scenario: SSO login flow

- GIVEN a user navigates to the Ambient UI
- WHEN they are not authenticated
- THEN the BFF redirects to the OIDC authorization endpoint
- AND on callback, exchanges the code for tokens and establishes a server-side session
- AND sets an httpOnly, secure, SameSite cookie on the browser

### Scenario: API request with JWT relay

- GIVEN an authenticated user makes an API request
- WHEN the BFF proxies the request to the ambient-api-server
- THEN the BFF extracts the JWT from the server-side session
- AND forwards it as `Authorization: Bearer <jwt>`

## Requirement: User Identity Endpoint

The BFF SHALL expose a `/api/me` endpoint that returns the authenticated user's identity extracted from JWT claims in the SSO session. The response SHALL include `username`, `name`, `email`, and `initials` (computed from the user's name).

### Scenario: Authenticated user identity

- GIVEN a user authenticated via SSO
- WHEN the client fetches `/api/me`
- THEN the response includes `authenticated: true`, `username`, `name`, `email`, and `initials`
- AND the claims are extracted from the JWT stored in the server-side session

### Scenario: Unauthenticated user identity

- GIVEN a user without a valid session
- WHEN the client fetches `/api/me`
- THEN the response includes `authenticated: false`

## Requirement: User Menu

The nav header SHALL display a user avatar/menu in the top-right corner showing the user's initials. Clicking the avatar SHALL open a dropdown menu displaying the user's full name, email, and a "Sign out" action that redirects to `/api/auth/sso/logout`.

### Scenario: User menu rendering

- GIVEN an authenticated user with name "Dev User"
- WHEN the nav header renders
- THEN a circular avatar with initials "DU" appears in the top-right corner
- AND clicking it opens a dropdown with the user's name, email, and "Sign out" option

### Scenario: Sign out

- GIVEN the user menu is open
- WHEN the user clicks "Sign out"
- THEN the browser navigates to `/api/auth/sso/logout`
- AND the SSO session is destroyed

## Requirement: Port/Adapter API Layer

The Ambient UI SHALL define domain port interfaces for each API concern. An adapter layer SHALL implement these ports by calling the generated TypeScript SDK. Components SHALL consume ports, never SDK types directly.

The port layer SHALL define canonical domain types that represent the UI's view of each resource. SDK types SHALL NOT leak into React components or hooks.

### Scenario: Domain port for sessions

- GIVEN the sessions domain port
- WHEN a component calls `listSessions(projectId, filters)`
- THEN the port returns domain-typed `Session` objects
- AND the adapter internally calls the SDK and maps SDK types to domain types

### Scenario: SDK type isolation

- GIVEN a React component rendering an agent
- WHEN the component reads the agent's data
- THEN the data type is a domain `Agent` type defined in the port layer
- AND no SDK-generated type appears in the component's imports

### Scenario: Port coverage

- GIVEN the complete ambient-api-server API surface
- WHEN the port layer is fully implemented
- THEN ports exist for: Projects, Agents, Sessions, SessionMessages, SessionEvents, Credentials, RoleBindings, ScheduledSessions, Inbox

## Requirement: Domain-Oriented Observability

The Ambient UI SHALL instrument domain-significant events — not generic HTTP calls. Observability probes SHALL be expressed in domain language.

### Scenario: Session phase change observed

- GIVEN a session transitions from Running to Failed
- WHEN the UI detects the change via SSE stream
- THEN a domain probe fires: `session.phaseChanged({ sessionId, from: 'Running', to: 'Failed', projectId })`
- AND the probe is available for logging, metrics, and alerting hooks

### Scenario: Credential rotation observed

- GIVEN a user rotates a credential token
- WHEN the mutation succeeds
- THEN a domain probe fires: `credential.rotated({ credentialId, provider })`

---

## Navigation and Project Scoping
## Requirement: Project as Primary Context

The Ambient UI SHALL scope all operational views to a single active project. The project selector SHALL be the primary navigation pivot, positioned at the top of the sidebar.

### Scenario: Project selection

- GIVEN a user opens the Ambient UI
- WHEN no project is selected
- THEN the main content area displays a project picker showing all accessible projects
- AND project-scoped sidebar navigation items are disabled

### Scenario: Project-scoped views

- GIVEN a user selects project "platform"
- WHEN they navigate to Sessions, Agents, Schedules, Work, or Settings
- THEN all data displayed is scoped to the "platform" project
- AND the active project name is visible in a breadcrumb on every view

### Scenario: Global views

- GIVEN a user navigates to Credentials
- WHEN the Credentials view renders
- THEN it displays credentials across all projects (global scope)
- AND the project selector is visually dimmed to indicate the view is not project-scoped

## Requirement: Sidebar Navigation

The Ambient UI sidebar SHALL contain three groups separated by visual dividers and group labels:

**Operate** (project-scoped, high-frequency monitoring):
- Dashboard (attention queue + active work + recent completions — default landing page)
- Work (aggregated SDLC artifacts: PRs, tickets, MRs, incidents)
- Sessions (session monitoring, route: `/sessions`)
- Schedules (cron management)

**Build** (project-scoped, agent authoring and configuration):
- Agents (agent registry, authoring workbench, test sessions)

**Configure** (cross-cutting):
- Credentials (credential management and project/agent binding)
- Settings (project configuration, permissions, API keys, feature flags)

The Dashboard sidebar item SHALL display a badge count of items requiring human attention. The group labels ("Operate", "Build", "Configure") SHALL be rendered as muted section headers, not clickable items.

### Scenario: Navigation breadcrumbs

- GIVEN a user is viewing a session detail in the "platform" project
- WHEN the breadcrumb renders
- THEN it displays: `platform > Sessions > session-name`
- AND each segment is clickable to navigate to that level

## Requirement: Keyboard Navigation

The Ambient UI SHALL support keyboard-first navigation for power users.

### Scenario: Table navigation

- GIVEN a user is viewing the Sessions table
- WHEN they press `j` or `k`
- THEN the selection moves down or up through table rows
- AND `Enter` opens the selected session's detail view

### Scenario: Global search

- GIVEN a user presses `Ctrl+K` or `Cmd+K`
- WHEN the search overlay opens
- THEN they can search across session names, agent names, and registered annotation values (Jira issue keys, PR numbers)
- AND results are grouped by type and clickable

Global search SHALL be implemented client-side by querying multiple API endpoints (`GET /sessions?search=...`, `GET /projects/{id}/agents?search=...`) and aggregating results. No cross-resource search endpoint exists in the API today.

### Scenario: Escape to go back

- GIVEN a user is in a detail view, sidebar, or modal
- WHEN they press `Escape`
- THEN the current overlay closes or the view navigates back one level

---

## Cross-Cutting Concerns
## Requirement: Empty States

Every list view SHALL display a meaningful empty state when no data exists, including an explanation and suggested action.

## Requirement: Action Confirmation

All destructive or state-changing actions (session stop/delete, credential delete/rotate, schedule enable/disable, feature flag toggle) SHALL require explicit confirmation before executing.

## Requirement: Status Bar

The Ambient UI SHALL display a persistent status bar fixed to the bottom of the viewport. The status bar SHALL be compact (single line) and always visible regardless of scroll position or active view.

The status bar SHALL display:
- **Connection context**: The ambient-api-server URL currently targeted by the BFF
- **Connection status indicator**: A colored dot and label reflecting the ambient-api-server's reachability (moved from the top bar)

### Scenario: Status bar rendering

- GIVEN the Ambient UI is loaded
- WHEN any view renders
- THEN a compact status bar is visible at the bottom of the viewport
- AND it displays the API server URL (e.g., `https://ambient-api-server:8000`)
- AND it displays a connection status indicator (green dot + "Connected" or red dot + "Disconnected")

### Scenario: Cluster connected

- GIVEN the ambient-api-server is reachable
- WHEN the status bar renders
- THEN the connection indicator displays a green dot with "Connected" label

### Scenario: Cluster disconnected

- GIVEN the ambient-api-server becomes unreachable
- WHEN the UI detects connection failure
- THEN the connection indicator changes to a red dot with "Disconnected" label
- AND a pulsing animation draws attention to the status change

## Requirement: Connection Context Switching

The status bar SHALL support switching between the default SSO-authenticated connection and a custom connection with a user-provided URL and bearer token.

The default connection uses the BFF's configured API server URL and the JWT from the user's SSO session (native-sso mode). A custom connection overrides both the URL and the authentication token.

### Scenario: Default SSO context

- GIVEN the user has authenticated via SSO
- WHEN no custom context is active
- THEN the BFF proxies API requests to the configured API server URL
- AND uses the JWT from the SSO session as the Authorization header
- AND the status bar displays the configured URL with no override indicator

### Scenario: Enter custom context

- GIVEN the status bar displays the default API server URL
- WHEN the user clicks the URL
- THEN the status bar expands to show two editable fields: URL and Token
- AND the URL field is pre-populated with the current URL
- AND the Token field is empty with placeholder text (e.g., "Bearer token")
- AND pressing Enter on either field confirms the change
- AND pressing Escape cancels and collapses back to the default view

### Scenario: Custom context applied

- GIVEN the user enters a custom URL and token and confirms
- WHEN the custom context is active
- THEN the BFF proxies all API requests to the custom URL
- AND uses the user-provided token as the Authorization header (instead of the SSO JWT)
- AND the status bar displays the custom URL with a visual override indicator
- AND a "Reset" control is visible to revert to the default context

### Scenario: Reset to default context

- GIVEN a custom context is active
- WHEN the user clicks the "Reset" control
- THEN the custom URL and token are cleared
- AND the BFF reverts to using the configured API server URL and SSO JWT
- AND the status bar returns to its default appearance

### Scenario: Custom context with URL only (no token)

- GIVEN the user enters only a custom URL without a token
- WHEN the custom context is applied
- THEN the BFF proxies to the custom URL
- AND uses the SSO session JWT as the Authorization header (if available)
- AND falls back to no Authorization header if no SSO session exists

### Scenario: Custom context persistence

- GIVEN the user has set a custom context
- WHEN the page is refreshed
- THEN the custom context persists (stored server-side in the BFF session)
- AND the user does not need to re-enter the URL and token

---

## Migration
## URL Routes

All existing routes SHALL remain stable. The sidebar label changes do NOT imply URL path changes:

| Sidebar Label | Route Path | Status |
|---------------|-----------|--------|
| Dashboard | `/{projectId}` (root project route) | New — becomes default landing |
| Work | `/{projectId}/work` | New |
| Sessions | `/{projectId}/sessions` | Existing — unchanged |
| Agents | `/{projectId}/agents` | Existing — unchanged |
| Agents Detail | `/{projectId}/agents/{agentId}` | New — replaces Sheet with page |
| Schedules | `/{projectId}/schedules` | New |
| Credentials | `/credentials` | New (global) |
| Settings | `/{projectId}/settings` | New |

When the Dashboard page ships, the project picker and project selector SHALL navigate to `/{projectId}` instead of `/{projectId}/sessions`. Direct navigation to `/{projectId}/sessions` SHALL continue to work.

## Session Detail Tabs

Tab URL param values SHALL remain stable: `?tab=overview`, `?tab=logs`, `?tab=resources`, `?tab=config`, `?tab=chat`. These names match the current implementation and SHALL NOT change.

## Agent Detail: Sheet to Page Migration

The existing `AgentDetailPanel` Sheet component SHALL be replaced by a full page at `/{projectId}/agents/{agentId}`. The Sheet component MAY be retained as a lightweight preview when clicking agent names in the Sessions table, but the primary agent detail surface is the page.

## Phased Rollout

New sidebar items SHALL be added incrementally as their pages are implemented. Items SHALL NOT appear in the sidebar until their page exists (no disabled "Coming soon" stubs). Recommended order:

1. Dashboard page + sidebar restructure (Operate/Build/Configure groups)
2. Agent detail page (replaces Sheet)
3. Work view
4. Schedules, Credentials, Settings

---

## API Dependencies
This section documents API endpoints and capabilities that this spec depends on but which do not yet exist. These are not requirements of this spec — they are requirements on other specs.

| Dependency | Required By | Status | Interim |
|------------|-------------|--------|---------|
| Annotation enrichment endpoint (resolve `ambient-code.io/jira/issue` etc. against bound credentials) | Annotation enrichment, Issues view status filtering | Not yet specified | Render raw annotation values as clickable chips |
| `GET /credentials/{cred_id}/role_bindings` (scoped query) | Credential binding display | Planned, not implemented | Use generic `GET /role_bindings` filtered by `credential_id` |
| Cross-resource search endpoint | Global search | Not planned | Client-side aggregation across multiple list endpoints |
| Session list-watch endpoint (`GET /sessions?watch=true`) | Sessions real-time phase updates | Not available | Poll `GET /sessions` at 5s interval |
| SSE availability guarantee (runner reachability) | Logs/Chat real-time streaming | Runner returns 502 when unreachable | Fall back to polling `GET /sessions/{id}/messages` |

## Design Decisions
| Decision | Rationale |
|----------|-----------|
| Next.js BFF (not pure SPA) | Secure OIDC confidential client. Tokens never reach the browser. Proven pattern from existing frontend. |
| Port/adapter over SDK (not SDK types directly) | Domain types decouple UI from generated code. SDK regeneration doesn't cascade into component changes. |
| `ambient-code.io/*` annotation namespace | Consistent with the platform's existing annotation namespace. UI-registered keys and platform-internal keys share the same domain; the UI registry determines which are rendered. |
| Annotation registry is a code enum (not dynamic) | Simplicity. Adding a new annotation type is a PR, not a config change. The set of annotations the UI understands should be deliberate and reviewed. |
| Enrichment as graceful degradation | UI ships without enrichment API. Raw annotation values are useful on their own (clickable links). Enriched tooltips are additive. |
| Cost as annotation, not API field | Cost is agent-computed and written as `ambient-code.io/cost/estimate`. No API-level cost computation. |
| Tool metrics computed client-side | The API stores raw SessionMessages. Aggregating tool call stats is a UI concern, not an API concern. |
| SSE for sessions, polling for rest | Sessions have real-time SSE streams. Credentials, schedules, and agents change infrequently — polling is sufficient and simpler. |
| Single interaction pattern per entity | Agent rows: navigate to detail page. Session rows: navigate to detail page. Reduces cognitive load per Krug's "Don't Make Me Think." |
| Chat sidebar is app-level, not tab-level | The sidebar lives in the root layout, not the session detail page. This enables cross-page persistence. State is managed via React context at the dashboard layout level. |
| Feedback delivery is context-dependent | Running session → session message (immediate). Stopped session → agent inbox (queued). Matches the platform's existing message model. |
| Work-centric IA, not infrastructure-centric | The UI is organized around work outcomes (PRs, tickets, reviews) rather than infrastructure primitives (sessions, agents). Sessions and agents are accessible but secondary. Sidebar groups: Operate (Dashboard, Work, Sessions, Schedules), Build (Agents), Configure (Credentials, Settings). |
| Agent detail is a page, not a sheet | The authoring workflow requires editing prompts, comparing test runs, and exporting YAML. A slide-out sheet is too narrow for sustained work. Agent detail mirrors the session detail tabbed-page pattern. |
| Agents as authoring playground | The UI serves as a prototyping workbench for agent definitions. Teams experiment in the UI, then export to YAML for GitOps management via `acpctl apply`. Draft vs GitOps lifecycle badges distinguish prototype from production agents. |
| Progressive disclosure, not mode switching | The operator and agent author share one navigation structure at different depths of engagement. No modal "Operations Mode" vs "Authoring Mode". Group labels (Operate/Build) provide wayfinding without mode complexity. |
| Dashboard as default landing | The most frequent question ("what needs my attention?") should be answered without clicking anything. The Dashboard is the project-level entry point, replacing the session list as the default. |

---

## Design System

### Requirement: Typefaces

The Ambient UI SHALL use **Red Hat Text** for body copy and UI labels. Red Hat Text is optimized for readability at small sizes with increased x-height, wider narrow characters, and varied stroke weights.

The Ambient UI SHALL use **Red Hat Mono** for code, terminal output, and machine-readable identifiers (session IDs, KSUIDs, JSON). Each letter occupies the same horizontal space, creating aligned columns for scanning.

### Requirement: Accessibility

All UI elements SHALL meet Red Hat accessibility standards:

- Small text (17pt or smaller): minimum 4.5:1 contrast ratio
- Large text (18pt or larger) and informative icons: minimum 3:1 contrast ratio
- Saturated hues of similar intensity SHALL NOT be placed adjacent — combine bright colors with less saturated or neutral colors to avoid visual vibration

### Requirement: Color Palette

The Ambient UI SHALL use the Red Hat color palette organized into three groups: Core, Secondary, and Information. Colors are referenced by name and shade level (e.g. `red-50`, `gray-70`).

#### Core Palette

| Name | HEX | Usage |
|------|-----|-------|
| red-05 | `#fef0f0` | Red tint background |
| red-10 | `#fce3e3` | Red light background |
| red-20 | `#fbc5c5` | Red accent light |
| red-30 | `#f9a8a8` | Red accent |
| red-40 | `#f56e6e` | Red emphasis |
| red-50 | `#ee0000` | Red Hat brand red — never for negative states |
| red-60 | `#a60000` | Red dark |
| red-70 | `#5f0000` | Red darker |
| red-80 | `#3f0000` | Red darkest |
| white | `#ffffff` | Background |
| gray-10 | `#f2f2f2` | Subtle background |
| gray-20 | `#e0e0e0` | Border, divider |
| gray-30 | `#c7c7c7` | Disabled border |
| gray-40 | `#a3a3a3` | Placeholder text |
| gray-45 | `#8c8c8c` | Muted text |
| gray-50 | `#707070` | Secondary text |
| gray-60 | `#4d4d4d` | Body text |
| gray-70 | `#383838` | Heading text |
| gray-80 | `#292929` | Primary text |
| gray-90 | `#1f1f1f` | Dark surface |
| gray-95 | `#151515` | Darkest surface |
| black | `#000000` | Maximum contrast |

#### Secondary Palette

| Name | HEX |
|------|-----|
| orange-10 | `#ffe8cc` |
| orange-20 | `#fccb8f` |
| orange-30 | `#f8ae54` |
| orange-40 | `#f5921b` |
| orange-50 | `#ca6c0f` |
| orange-60 | `#9e4a06` |
| orange-70 | `#732e00` |
| orange-80 | `#4d1f00` |
| yellow-10 | `#fff4cc` |
| yellow-20 | `#ffe072` |
| yellow-30 | `#ffcc17` |
| yellow-40 | `#dca614` |
| yellow-50 | `#b98412` |
| yellow-60 | `#96640f` |
| yellow-70 | `#73480b` |
| yellow-80 | `#54330b` |
| teal-10 | `#daf2f2` |
| teal-20 | `#b9e5e5` |
| teal-30 | `#9ad8d8` |
| teal-40 | `#63bdbd` |
| teal-50 | `#37a3a3` |
| teal-60 | `#147878` |
| teal-70 | `#004d4d` |
| teal-80 | `#003333` |
| purple-10 | `#ece6ff` |
| purple-20 | `#d0c5f4` |
| purple-30 | `#b6a6e9` |
| purple-40 | `#876fd4` |
| purple-50 | `#5e40be` |
| purple-60 | `#3d2785` |
| purple-70 | `#21134d` |
| purple-80 | `#1b0d33` |

#### Information Palette

| Name | HEX |
|------|-----|
| success-green-10 | `#e9f7df` |
| success-green-20 | `#d1f1bb` |
| success-green-30 | `#afdc8f` |
| success-green-40 | `#87bb62` |
| success-green-50 | `#63993d` |
| success-green-60 | `#3d7317` |
| success-green-70 | `#204d00` |
| success-green-80 | `#183301` |
| danger-orange-10 | `#ffe3d9` |
| danger-orange-20 | `#fbbea8` |
| danger-orange-30 | `#f89b78` |
| danger-orange-40 | `#f4784a` |
| danger-orange-50 | `#f0561d` |
| danger-orange-60 | `#b1380b` |
| danger-orange-70 | `#731f00` |
| danger-orange-80 | `#4c1405` |
| interaction-blue-10 | `#e0f0ff` |
| interaction-blue-20 | `#b9dafc` |
| interaction-blue-30 | `#92c5f9` |
| interaction-blue-40 | `#4394e5` |
| interaction-blue-50 | `#0066cc` |
| interaction-blue-60 | `#004d99` |
| interaction-blue-70 | `#003366` |
| interaction-blue-80 | `#032142` |

### Requirement: Color Semantics

Colors SHALL carry consistent semantic meaning across all UI surfaces:

| Color | Semantic | Usage |
|-------|----------|-------|
| Red | Red Hat brand | Brand identity only — never for negative states |
| Success green | Success, increase | Completed sessions, healthy status, positive deltas |
| Danger orange | Error, failure, decrease | Failed sessions, errors, negative deltas |
| Orange | Caution | Non-destructive warnings, attention needed |
| Yellow | Warning | Action needed, approaching limits |
| Interaction blue | Link, interaction | Clickable elements, focused states |
| Purple | Info, note, tip | Informational badges, documentation links |
| Teal | General, neutral | Neutral status, default badges |
| Gray | Null, unavailable | Disabled states, unimportant metadata |
