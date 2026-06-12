---
title: Credential Scoping for Shared Sessions
description: How credentials are bound and isolated when multiple users share a session
---

## How credential injection works

When a session starts, the control plane resolves which credentials to inject:

1. **Binding resolution** — queries role bindings at agent → project → global scope to find credentials with injection intent (not just ownership).
2. **Token-reader grant** — creates a temporary `credential:token-reader` binding so the session's service identity can read the credential token from the API server.
3. **Sidecar injection** — for providers with credential sidecars (GitHub, Jira, K8s, Google), the control plane adds a sidecar container that fetches the token at startup and runs the provider's MCP server.
4. **Cleanup** — when the session ends, the token-reader binding is revoked.

The credential used for a given provider is determined once at session start and does not change for the lifetime of the pod.

## Shared session implications

When multiple users collaborate on a session, all users share the same provider credentials that were injected at session start. A user who can message a session can use the tools backed by those credentials — for example, pushing commits via the GitHub MCP server.

To control this:

- **Bind credentials at the narrowest scope** — prefer agent or project bindings over global ones.
- **Use separate sessions** when users need different provider access levels.
- **Review who has session access** — session access implies access to the tools (and credentials) that session was started with.

## Migration checklist

If you're moving from a setup where credentials were broadly shared:

1. Inventory which credentials are bound at each scope (global, project, agent).
2. Remove global bindings where project or agent scope is sufficient.
3. Confirm each collaborator has only the project/session roles they need.
4. Start a fresh session and verify tools work for authorized users and fail cleanly for others.
5. Check that logs report credential failures without printing tokens.

## Troubleshooting

If a shared session can't access a provider:

1. Does the credential have an injection binding at the right scope?
2. Was the session started *after* the binding was created? (Bindings are resolved at session start.)
3. Is the sidecar image configured for that provider?
4. Check control plane logs for "credential resolution failed" warnings.
