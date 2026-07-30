---
title: Platform Feedback
description: How to configure the user feedback channel that delivers free-text feedback to a Slack channel
---

Platform Feedback gives every authenticated user a one-click way to send comments, bug reports, or feature requests to your team. Feedback is delivered to a Slack channel via an Incoming Webhook so it reaches maintainers where they already work.

## How it works

A vertical "Feedback" strip is fixed to the right edge of the viewport. Clicking it opens a dialog where the user types free-text feedback and submits. The BFF posts the message to a configured Slack Incoming Webhook. The strip is hidden entirely when the webhook is not configured.

The feedback flow is:

```
User clicks strip → Dialog opens → User types feedback → POST /api/feedback →
BFF validates + authenticates → Slack Incoming Webhook → Slack channel
```

## Configuration

Platform Feedback requires a single environment variable on the `ambient-ui` deployment:

| Variable | Required | Description |
|---|---|---|
| `FEEDBACK_SLACK_WEBHOOK_URL` | Yes | Slack Incoming Webhook URL (e.g., `https://hooks.slack.com/services/T.../B.../...`) |

When the variable is not set, the feedback strip does not render and the `POST /api/feedback` endpoint returns `503`.

### Creating a Slack Incoming Webhook

1. Go to [Slack App Management](https://api.slack.com/apps) and create a new app (or use an existing one).
2. Under **Incoming Webhooks**, activate the feature and click **Add New Webhook to Workspace**.
3. Select the channel where feedback should be delivered.
4. Copy the webhook URL.

### Kind (local development)

Pass the webhook URL as a Make variable when starting the cluster:

```bash
make kind-up FEEDBACK_SLACK_WEBHOOK_URL="https://hooks.slack.com/services/T.../B.../..."
```

`kind-up` calls `kubectl set env` on the `ambient-ui` deployment after applying manifests, so the value is always applied regardless of what the base manifest declares. You will see a confirmation line in the output:

```
✓ Platform feedback: Slack webhook configured
```

To persist the value across `make kind-up` invocations without typing it each time, add it to `.env.local` (gitignored):

```
FEEDBACK_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../...
```

To set it on an already-running cluster:

```bash
kubectl set env deployment/ambient-ui -n ambient-code \
  FEEDBACK_SLACK_WEBHOOK_URL="https://hooks.slack.com/services/T.../B.../..."
```

### OpenShift / production

Inject `FEEDBACK_SLACK_WEBHOOK_URL` into the `ambient-ui` deployment via your secret management tooling (Vault, Sealed Secrets, External Secrets Operator, or an environment-specific kustomize overlay patch).

## Slack message format

Each feedback message is posted using Slack Block Kit with three sections:

- **Header**: "Platform Feedback"
- **Body**: the user's feedback text
- **Context**: submitting username, page path, and timestamp

## Rate limiting

The BFF enforces per-user rate limiting: 5 requests per user per minute, identified by the SSO session username. Exceeding the limit returns `429 Too Many Requests` with a `Retry-After` header. The rate limiter is in-memory and resets when the pod restarts.

## Disabling feedback

Remove or unset `FEEDBACK_SLACK_WEBHOOK_URL` from the deployment. The UI checks availability on load (`GET /api/feedback`) and hides the strip when the backend reports `available: false`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Feedback strip not visible | `FEEDBACK_SLACK_WEBHOOK_URL` not set | Set the env var and restart the pod |
| Submit returns error | Slack webhook URL is invalid or channel was deleted | Verify the webhook URL in Slack app settings |
| 429 "too quickly" message | User exceeded 5 submissions/minute | Wait and retry |
| 401 on submit | SSO session expired | Refresh the page to re-authenticate |
