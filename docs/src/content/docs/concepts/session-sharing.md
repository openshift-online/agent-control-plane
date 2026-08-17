---
title: "Session Sharing"
---

Sessions can be shared with other users while keeping credential access separate and controlled. ACP treats visibility and token access as independent concerns, so granting someone access to a session does not automatically give them access to every credential the session uses.

## Visibility vs access

ACP uses role bindings at project and session scope to control who can see and interact with sessions. Credential token access is governed by a separate set of bindings. This means:

- A collaborator can view session output and send messages without being able to read credential tokens.
- A credential owner can grant token-read access to specific users or scopes without granting broader project permissions.

Grant the minimum role needed. Project-level roles cover all sessions in that project; session-level roles are narrower.

## How sharing works

1. Give collaborators a project or session role binding that allows them to view the session and send messages.
2. Bind only the credentials they need to the project or agent. Do not bind credentials broadly just because a session is shared.
3. Start a test session to verify the runner can reach the intended repositories or external services with the granted credentials.
4. Review runner logs for credential failures without exposing token values.

If a collaborator can send messages but the runner cannot access a private repository, check both the user's session/project access and the credential token-reader binding for the relevant provider.

## Credential isolation

Normal credential responses never include the token. Token reads go through dedicated endpoints:

```text
GET /api/ambient/v1/credentials/{cred_id}/token
GET /api/ambient/v1/projects/{id}/credentials/{cred_id}/token
```

These calls require explicit token-read authorization. Sharing a session does not bypass this gate.

Do not put long-lived tokens in prompts, labels, annotations, or session messages. The runner clears caller tokens after each turn.

## Sidecar vs runner fetch modes

At runtime, the runner resolves credentials through one of two paths:

- **Sidecar mode**: provider-specific sidecars handle token access and expose MCP tool URLs to the runner. The runner never sees raw tokens directly. Prefer this mode when your deployment supports it.
- **Runner fetch mode**: the runner uses `CREDENTIAL_IDS` and calls the API token endpoints before each turn. For HTTP turns, the runner can use the caller's bearer token from request headers and clears it after the turn completes.

If a caller token is unavailable or expired, the runner may fall back to the control-plane service account with current-user context. Do not assume the session creator's credential is used for every later message in a shared session.

## Summary

| Concern | Controlled by |
| --- | --- |
| Who can see and message a session | Project and session role bindings |
| Who can read credential tokens | Credential role bindings |
| How the runner accesses tokens | Sidecar mode or runner fetch mode |
| Token lifetime per turn | Runner clears caller token after each turn |
