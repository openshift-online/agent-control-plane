# Annotation System

## Annotation System
## Requirement: Registered Annotation Keys

The Ambient UI SHALL maintain a registry of annotation keys with defined UI behavior. Only registered keys produce visual elements in operational views. Unregistered annotations are invisible in all views except the raw annotations table in the Details tab.

Annotations are general-purpose metadata — agents write arbitrary annotations for their own purposes. The UI does not render unknown annotations. The registry defines which annotations the UI understands and how it renders them.

All registered annotation keys SHALL use the `ambient-code.io/` namespace prefix, consistent with the platform's existing annotation namespace. Integration-specific annotations use path hierarchy under `ambient-code.io/` (e.g., `ambient-code.io/jira/issue`, `ambient-code.io/github/pr`). Platform-internal annotations (e.g., `ambient-code.io/desired-phase`, `ambient-code.io/session-id`) share the same namespace but are not in the UI registry and are therefore invisible in operational views.

**Registered annotation keys and their UI behavior:**

| Key | Example Value | UI Behavior |
|-----|---------------|-------------|
| `ambient-code.io/ui/path` | `"backend/auth"` | Virtual folder tree grouping in Sessions view |
| `ambient-code.io/ui/pinned` | `"true"` | Pin icon next to session name; sorts to top |
| `ambient-code.io/ui/priority` | `"high"` | Colored priority icon (red/amber/gray) left of session name |
| `ambient-code.io/ui/tag` | `"docs"` | Muted tag chip in annotation popover |
| `ambient-code.io/ui/preview-url` | `"https://app.example.com"` | Live preview panel with feedback mode |
| `ambient-code.io/ui/preview-title` | `"SSO Login v2"` | Title for the preview panel |
| `ambient-code.io/jira/issue` | `"HYPERFLEET-234"` | Jira chip (icon, key); enriched tooltip when available |
| `ambient-code.io/jira/epic` | `"HYPERFLEET-100"` | Epic reference chip; used for grouping/filtering |
| `ambient-code.io/github/pr` | `"org/repo#1847"` | PR chip (icon, number); enriched tooltip when available |
| `ambient-code.io/github/repo` | `"org/repo"` | Repository reference |
| `ambient-code.io/github/branch` | `"feat/new-auth"` | Branch reference |
| `ambient-code.io/gitlab/mr` | `"org/repo!423"` | MR chip (icon, number); enriched tooltip when available |
| `ambient-code.io/gerrit/change` | `"change/12345"` | Gerrit change link |
| `ambient-code.io/review/status` | `"needs-review"` | Status badge (amber/green/red). This is external review metadata, distinct from session phase. |
| `ambient-code.io/review/reviewer` | `"@mchen"` | Reviewer reference |
| `ambient-code.io/triggered-by` | `"schedule/nightly"` | Provenance indicator with contextual icon |
| `ambient-code.io/cost/estimate` | `"$4.12"` | Muted cost display in Sessions table |
| `ambient-code.io/oncall/incident` | `"INC-003"` | Red incident chip with alert icon |
| `ambient-code.io/parent-agent` | `"orchestrator"` | Agent delegation reference |
| `ambient-code.io/agent/needs-input` | `"approval"` | Amber attention badge; surfaces in Dashboard attention queue. Values: `approval`, `clarification`, `credentials`, `review` |
| `ambient-code.io/managed-by` | `"gitops"` | Agent lifecycle badge: "GitOps" (managed externally) vs "Draft" (UI-managed prototype) |

### Scenario: Registered annotation rendered

- GIVEN a session with annotation `ambient-code.io/jira/issue: "HYPERFLEET-234"`
- WHEN the session appears in any view
- THEN the Jira annotation is rendered as a styled chip
- AND the annotation appears in the Details tab both as a rich card and in the raw table

### Scenario: Unregistered annotation not rendered

- GIVEN a session with annotation `ambient-code.io/desired-phase: "Running"`
- WHEN the session appears in the Sessions table or any operational view
- THEN no visual element is produced for that annotation
- AND the annotation is visible ONLY in the raw annotations table in the Details tab

### Scenario: Annotation key registration is explicit

- GIVEN an agent writes annotation `ambient-code.io/slack/channel: "#team-platform"`
- WHEN the Ambient UI encounters this annotation
- THEN it produces no visual element (this key is not in the registry)
- AND adding support for it requires a code change to the annotation renderer registry

## Requirement: Annotation Enrichment (Planned)

For registered annotations that reference external resources (Jira issues, GitHub PRs, GitLab MRs), the UI SHOULD display enriched data (issue title, status, assignee, PR checks) when available. Enrichment is a server-side concern — the UI SHALL NOT call external APIs directly.

**Dependency:** Annotation enrichment requires a new ambient-api-server endpoint that resolves annotation references using bound credentials. This endpoint does not exist today. Until it ships, the UI SHALL render raw annotation values as styled, clickable chips linking to the external resource. Enriched tooltips and detail cards SHALL be populated only when the enrichment API is available.

The enrichment endpoint specification is out of scope for this document and SHALL be defined in a separate API spec.

### Scenario: Enrichment available

- GIVEN a session with annotation `ambient-code.io/jira/issue: "HYPERFLEET-234"`
- AND the enrichment API is available and the project has a Jira credential bound
- WHEN the UI requests enrichment
- THEN the API server returns enriched data (summary, status, assignee, priority)
- AND the UI renders a rich tooltip on the Jira chip

### Scenario: Enrichment unavailable (graceful degradation)

- GIVEN a session with annotation `ambient-code.io/jira/issue: "HYPERFLEET-234"`
- AND the enrichment API is not available OR the project has no Jira credential bound
- WHEN the UI renders the annotation
- THEN it displays "HYPERFLEET-234" as a styled, clickable chip linking to the Jira instance
- AND no tooltip with enriched details is shown

---
