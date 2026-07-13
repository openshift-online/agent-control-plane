# Live Preview and Real-Time Updates

## Live Preview and Visual Feedback
## Requirement: Live Preview Mode

Sessions with an `ambient-code.io/ui/preview-url` annotation SHALL offer a live preview panel. The preview SHALL render the target URL in an iframe within a near-fullscreen overlay.

The preview iframe SHALL be hardened:
- The `sandbox` attribute SHALL be set with minimal permissions (`allow-scripts allow-same-origin allow-forms`). Top-level navigation (`allow-top-navigation`) and popups (`allow-popups`) SHALL NOT be granted.
- The UI SHALL validate the preview URL against a configurable allowlist of trusted host patterns (e.g., `*.apps.rosa.example.com`, `*.apps.cluster.local`). URLs not matching the allowlist SHALL be rejected with an error message instead of rendered.
- A Content-Security-Policy `frame-src` directive SHALL restrict the iframe to the allowlisted hosts.

### Scenario: Preview mode activation

- GIVEN a session with `ambient-code.io/ui/preview-url: "https://app.example.com"` and `ambient-code.io/ui/preview-title: "SSO Login v2"`
- AND the URL matches the configured preview host allowlist
- WHEN the user clicks "Open Preview" in the session detail
- THEN a near-fullscreen overlay opens with the URL loaded in a sandboxed iframe
- AND the overlay header shows the preview title, device size toggles (Desktop/Tablet/Mobile), and a Comment button

### Scenario: Preview URL rejected (untrusted host)

- GIVEN a session with `ambient-code.io/ui/preview-url: "https://evil.example.com"`
- AND the URL does not match the configured preview host allowlist
- WHEN the user clicks "Open Preview"
- THEN the preview does not render
- AND an error message is displayed: "Preview URL is not on the trusted hosts allowlist"

### Scenario: Device size emulation

- GIVEN the preview overlay is open
- WHEN the user selects "Mobile"
- THEN the iframe width constrains to 375px, centered in the preview area

## Requirement: Visual Feedback Mode

The preview panel SHALL support a feedback mode where users can select elements or regions in the previewed app, attach comments, and batch-send feedback to the agent.

### Scenario: Enter feedback mode

- GIVEN the preview overlay is open
- WHEN the user presses `c` or clicks "Comment"
- THEN the cursor changes to crosshair
- AND hovering over elements in the iframe highlights them with a blue outline
- AND an instruction bar appears: "Click an element or drag to select a region. Press Esc to cancel."

### Scenario: Element selection and comment

- GIVEN the user is in feedback mode
- WHEN they click an element in the preview
- THEN the element is highlighted
- AND its `outerHTML` is captured
- AND a comment card appears anchored to the element with a textarea and "Add to Batch" button

### Scenario: Region selection

- GIVEN the user is in feedback mode
- WHEN they click and drag to draw a rectangle
- THEN the selected region is highlighted
- AND a comment card appears with region dimensions and any contained elements

### Scenario: Batch feedback

- GIVEN the user has added 3 comments to the batch
- WHEN they click "Send All Feedback (3)"
- THEN a confirmation is shown
- AND on confirm, all feedback is sent as a single aggregated message
- AND the message includes: each comment's text, captured HTML, and viewport metadata

## Requirement: Feedback Delivery

Feedback SHALL be delivered to the agent via the appropriate channel based on session state.

### Scenario: Feedback to running session

- GIVEN the session is in Running phase
- WHEN feedback is sent
- THEN it is posted as a session message via `POST /api/ambient/v1/sessions/{id}/messages`
- AND the agent receives it as a user turn in the active conversation

### Scenario: Feedback to inactive session

- GIVEN the session is in Completed or Stopped phase
- WHEN feedback is sent
- THEN it is posted to the agent's inbox via `POST /api/ambient/v1/projects/{project_id}/agents/{agent_id}/inbox`
- AND the agent receives it on next start as part of the drained inbox context

## Requirement: Feedback Panel Position

The feedback history panel SHALL be positioned as a right-side panel alongside the preview area, not below it.

### Scenario: Feedback panel layout

- GIVEN the preview overlay is open
- WHEN the feedback panel renders
- THEN it appears as a fixed-width panel on the right side of the preview area
- AND pending feedback items appear at the top with edit/remove controls
- AND sent feedback appears below with muted styling
- AND the panel is collapsible via a toggle handle

## Audit-Driven Requirements

> Requirements in this section address findings from the 2026-07 ProdSec security audit.
> Each requirement references the originating finding ID (fNNN) for traceability.

### Requirement: Preview Content Must Be Served from a Sandbox Origin (f021)

Proxied preview content SHALL be served from a dedicated sandbox origin (e.g.,
`preview.ambient.example.com`), NOT from the dashboard application origin. The
current design fetches agent-supplied HTML server-side and re-serves it — scripts
intact, anti-framing headers stripped — from the dashboard origin inside an
`allow-same-origin + allow-scripts` iframe. JavaScript in the previewed app
therefore runs with full access to the operator's dashboard session.

Alternatively, the `allow-same-origin` directive SHALL be removed from the iframe
sandbox attribute so the document runs in an opaque origin with no access to
the parent frame's cookies, storage, or DOM.

#### Scenario: Preview iframe isolation

- GIVEN a session with a preview URL pointing to agent-generated content
- WHEN the preview overlay renders the content
- THEN the iframe either uses a separate origin OR omits `allow-same-origin`
- AND the previewed content cannot access `parent` DOM or dashboard cookies
- AND the previewed content cannot make authenticated API calls as the operator

### Requirement: Operator Token Must Not Be Forwarded to Preview Targets (f022)

The preview proxy SHALL NOT forward the operator's OIDC access token to preview
target hosts. The current implementation attaches the logged-in operator's
control-plane access token as `Authorization: Bearer` to every request to the
preview target — which is an untrusted agent-generated application.

If previews require authentication, a short-lived, audience-scoped preview token
valid only for the specific host/session SHALL be minted instead.

#### Scenario: Preview request without operator token

- GIVEN the preview proxy fetches content from an agent preview URL
- WHEN the proxy makes the HTTP request
- THEN no `Authorization` header with the operator's token is included
- AND the operator's session cannot be hijacked by the preview target

### Requirement: Preview PostMessage Bridge Origin Validation (f060)

The preview postMessage bridge SHALL validate `e.origin` and `e.source` before
accepting responses, and SHALL use a specific `targetOrigin` (not `'*'`) when
posting requests. The current implementation accepts `capturedHtml` from any
origin and broadcasts with `targetOrigin '*'`.

#### Scenario: postMessage from untrusted origin rejected

- GIVEN the preview bridge is listening for capture responses
- WHEN a message arrives from an unexpected origin
- THEN the message is ignored
- AND no content is injected into the feedback payload

---

## Real-Time Updates
## Requirement: SSE-Driven Updates

The Ambient UI SHALL use Server-Sent Events as the primary mechanism for real-time updates. Polling SHALL be used as a fallback for resources without SSE endpoints.

### Scenario: Session event streaming

- GIVEN a user is viewing a Running session's Logs or Chat tab
- WHEN the agent produces new events
- THEN the UI receives them via `GET /api/ambient/v1/sessions/{id}/events` SSE stream
- AND renders them in real-time without polling

### Scenario: Sessions table polling

- GIVEN a user is viewing the Sessions table
- WHEN a session's phase changes
- THEN the UI detects the change via periodic polling of `GET /api/ambient/v1/sessions` (5s interval)
- AND the Sessions table row updates on the next poll cycle

No list-watch endpoint exists for sessions today. Polling is the interim mechanism.

### Scenario: SSE unavailable (runner unreachable)

- GIVEN a user is viewing a session's Logs or Chat tab
- WHEN the runner pod is unreachable (SSE returns 502)
- THEN the UI falls back to polling `GET /api/ambient/v1/sessions/{id}/messages` for historical messages
- AND displays a status indicator: "Live stream unavailable — showing cached messages"

### Scenario: Non-streamable resource polling

- GIVEN the user is viewing the Credentials view
- WHEN credential data changes
- THEN the UI detects changes via periodic polling (30s interval)

---
