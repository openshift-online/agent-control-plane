---
title: Session Sharing & Credentials
description: How credentials work in shared sessions
---

ACP separates session access from credential access. A user can be allowed to view or message a session without automatically receiving every credential the session can use.

## Access model

Session, project, agent, and credential permissions are represented with role bindings. Project roles control who can see and operate on project resources. Credential roles control who can read credential tokens.

Normal credential responses do not include the token. Token reads go through:

```text
GET /api/ambient/v1/credentials/{cred_id}/token
GET /api/ambient/v1/projects/{id}/credentials/{cred_id}/token
```

These calls require token-read authorization.

## Runtime credentials

When the control plane starts a session, it resolves credentials visible at global, project, and agent scope. More specific bindings override less specific ones for the same provider.

At runtime, the runner has two credential paths:

- **Credential sidecar mode:** provider sidecars handle token access, and the runner talks to sidecar MCP URLs.
- **Runner fetch mode:** the runner uses `CREDENTIAL_IDS` and calls the API token endpoints before a turn.

For HTTP runner turns, the runner can use the caller's bearer token from the request headers for credential fetches, and it clears that caller token after the turn. If a caller token is not available or has expired, the runner may fall back to the control-plane/bot token path with current-user context.

## What this means for shared sessions

- Grant session or project visibility with project/session role bindings.
- Grant credential token access separately and narrowly.
- Prefer sidecar mode for provider credentials when your deployment supports it.
- Do not assume the session creator's credential is used for every later message.
- Do not put long-lived tokens in prompts, labels, annotations, or session messages.

## Practical setup

1. Give collaborators the minimum project or session role needed.
2. Bind only the credentials they need to the project or agent.
3. Start a test session and verify the runner can reach the intended repo or external service.
4. Review logs for credential failures without exposing token values.

If a user can send messages but the runner cannot access a private repo for that turn, check both the user's project/session access and the credential token-reader path for the relevant provider.
