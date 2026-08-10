# Platform Feedback

## Purpose

The Ambient UI provides a persistent, always-accessible feedback mechanism that lets users share comments, bug reports, feature requests, and general impressions with project maintainers. Feedback is delivered to a configurable Slack channel so it reaches the team where they already work. The mechanism is designed to encourage participation: it thanks the user, explains the purpose of their feedback, and minimizes friction.

This spec covers the UI trigger, the feedback dialog, and the Slack delivery route. It does not cover the existing *visual preview feedback* system (`FeedbackItem` / `FeedbackBatch`), which sends annotated comments to an AI agent within a session.

## Requirements

### Requirement: Persistent Feedback Strip

The Ambient UI SHALL render a persistent feedback trigger as a vertical strip fixed to the right edge of the viewport, vertically centered. The strip SHALL display the label "Feedback" rotated 90° (or an equivalent vertical text treatment).

The strip SHALL render above all application chrome, including sidebars, slide-over panels, modals, and overlays, so that it remains reachable at all times.

The strip SHALL be visible on every page and in every application state, including when the chat sidebar is open, when a dialog is active, or when the command palette is displayed.

#### Scenario: Strip visibility on dashboard

- GIVEN a user is on the Dashboard view
- WHEN the page renders
- THEN a vertical "Feedback" strip is visible, fixed to the right edge and vertically centered
- AND the strip does not overlap or obstruct page content in its resting state

#### Scenario: Strip above chat sidebar

- GIVEN the chat sidebar is open
- WHEN the user looks at the right edge of the viewport
- THEN the feedback strip remains visible on top of the chat sidebar

#### Scenario: Strip above modal dialogs

- GIVEN a dialog (e.g., project sharing, credential creation) is open
- WHEN the user looks at the right edge of the viewport
- THEN the feedback strip remains visible on top of the dialog overlay

### Requirement: Feedback Dialog

Clicking the feedback strip SHALL open a modal dialog. The dialog SHALL contain:

1. **Header**: a clear title (e.g., "Share Your Feedback").
2. **Encouragement copy**: a short message explaining that feedback is sent to project maintainers to improve the platform, and thanking the user for taking the time to share.
3. **Free-text area**: a multi-line text input where the user writes their feedback. The textarea SHALL have placeholder text guiding the user (e.g., "Tell us about a bug, suggest an improvement, or share what you like...").
4. **Submit button**: sends the feedback. The button SHALL be disabled when the textarea is empty.
5. **Cancel / close button**: dismisses the dialog without sending.

The dialog SHALL use the existing shadcn `Dialog` component to match the application's design language.

#### Scenario: Opening the feedback dialog

- GIVEN the feedback strip is visible
- WHEN the user clicks the strip
- THEN a modal dialog opens with a title, encouragement message, a textarea, and submit/cancel buttons

#### Scenario: Empty feedback prevention

- GIVEN the feedback dialog is open
- WHEN the textarea is empty or contains only whitespace
- THEN the Submit button is disabled

#### Scenario: Dismissing the dialog

- GIVEN the feedback dialog is open
- WHEN the user clicks Cancel, presses Escape, or clicks the backdrop overlay
- THEN the dialog closes without sending feedback
- AND any text entered in the textarea is discarded

### Requirement: Feedback Submission

When the user submits feedback, the UI SHALL send the feedback text to a BFF API route. The BFF SHALL deliver the message to a configured Slack channel using a Slack Incoming Webhook.

The submission payload SHALL include:

- The feedback text
- The submitting user's username (from the SSO session)
- The current page path (for context)

#### Scenario: Successful submission

- GIVEN the user has typed feedback text
- WHEN the user clicks Submit
- THEN the UI sends a POST request to the BFF feedback endpoint
- AND the Submit button shows a loading state while the request is in flight
- AND on success, the dialog displays a confirmation message (e.g., "Thank you! Your feedback has been sent.")
- AND the dialog auto-closes after a short delay (2–3 seconds)

#### Scenario: Submission failure

- GIVEN the user has typed feedback text
- WHEN the user clicks Submit
- AND the BFF or Slack API returns an error
- THEN the dialog displays an error message (e.g., "Something went wrong. Please try again.")
- AND the user's feedback text is preserved so they can retry

### Requirement: BFF Feedback Route

The BFF SHALL expose a `POST /api/feedback` endpoint. This route SHALL:

1. Validate that the request includes a non-empty feedback text.
2. Authenticate the request using the existing SSO session (reject unauthenticated requests with 401).
3. Construct a Slack message containing the feedback text, the submitting user's identity, and the page path.
4. Post the message to the configured Slack Incoming Webhook URL.
5. Return 200 on success, or an appropriate error status on failure.

#### Scenario: Authenticated feedback post

- GIVEN an authenticated user
- WHEN the BFF receives `POST /api/feedback` with `{ "text": "Great tool!", "pagePath": "/sessions" }`
- THEN the BFF posts to Slack: a formatted message with the feedback text, the username from the session, and the page path
- AND returns 200

#### Scenario: Unauthenticated feedback post

- GIVEN a request without a valid SSO session
- WHEN the BFF receives `POST /api/feedback`
- THEN the BFF returns 401

#### Scenario: Empty feedback rejection

- GIVEN an authenticated user
- WHEN the BFF receives `POST /api/feedback` with `{ "text": "   " }`
- THEN the BFF returns 400 with an error indicating feedback text is required

### Requirement: Slack Channel Configuration

The Slack Incoming Webhook URL used for feedback delivery SHALL be configured via an environment variable:

- `FEEDBACK_SLACK_WEBHOOK_URL` — the Slack Incoming Webhook URL (e.g., `https://hooks.slack.com/services/...`).

If the variable is missing, the feedback endpoint SHALL return 503 with a message indicating feedback is not configured, and the feedback strip SHALL NOT render. The UI SHALL check feedback availability via `GET /api/feedback` on load and hide the strip entirely when the backend reports `available: false`.

#### Scenario: Missing Slack configuration

- GIVEN `FEEDBACK_SLACK_WEBHOOK_URL` is not set
- WHEN the UI checks feedback availability
- THEN the feedback strip is not rendered
- AND no feedback UI is visible to the user

#### Scenario: Slack configuration present

- GIVEN `FEEDBACK_SLACK_WEBHOOK_URL` is set
- WHEN the BFF starts
- THEN the feedback endpoint is fully operational

### Requirement: Slack Message Format

The Slack message SHALL be formatted for quick comprehension by channel members. The message SHALL include:

- A header identifying it as platform feedback.
- The feedback text as the message body.
- The submitting user's username.
- The page the user was on when they submitted.
- A timestamp.

The message SHOULD use Slack Block Kit formatting for visual structure.

#### Scenario: Slack message content

- GIVEN user "developer" submits "The session logs are hard to read" from the `/sessions/abc-123` page
- WHEN the BFF posts to Slack
- THEN the Slack message contains:
  - A header: "Platform Feedback"
  - Body: "The session logs are hard to read"
  - Footer: "From: developer · Page: /sessions/abc-123"
- AND the message uses Block Kit formatting

### Requirement: Accessibility

The feedback strip and dialog SHALL meet WCAG 2.1 AA accessibility standards:

- The strip SHALL be keyboard-focusable and activatable with Enter or Space.
- The dialog SHALL trap focus while open.
- The textarea SHALL have an associated label (visible or `aria-label`).
- The strip SHALL have `aria-label="Send feedback"` for screen readers.
- Color contrast ratios for the strip text and background SHALL meet AA thresholds (4.5:1 for normal text).

#### Scenario: Keyboard activation

- GIVEN the feedback strip has keyboard focus
- WHEN the user presses Enter
- THEN the feedback dialog opens
- AND focus moves to the textarea

## API Dependencies

| Dependency | Type | Purpose |
|---|---|---|
| Slack Incoming Webhook | External | POST to webhook URL to deliver feedback |
| `/api/me` (BFF) | Internal | Resolve submitting user identity from SSO session |

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Delivery target | Slack channel | Feedback reaches maintainers where they already work; no new internal tooling needed |
| UI pattern | Fixed right-edge strip + modal | Always visible without occupying layout space; highest z-index ensures reachability over all chrome |
| Naming | "Platform Feedback" | Avoids collision with existing `FeedbackItem`/`FeedbackBatch` used for visual preview feedback |
| Configuration | Environment variables | Follows project convention of separating configuration from code; no code change needed to switch channels |
| Auth requirement | SSO session required | Prevents anonymous spam; identifies the submitter for follow-up |
