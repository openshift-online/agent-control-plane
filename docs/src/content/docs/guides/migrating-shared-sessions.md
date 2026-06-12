---
title: Migrating to Per-Message Credentials
description: How to update existing shared sessions for per-message credential behavior
---

Use this guide when moving from "the session owner owns all runtime credentials" to ACP's current role-binding and caller-token model.

## What changed

Credentials are API records with separate token-read authorization. A user who can view or message a session does not automatically get access to every credential used by that session.

For HTTP runner turns, the runner can use the caller's token to fetch credentials for that turn. The Claude bridge clears that caller token after the turn. If caller-token context is unavailable, the runner may use the control-plane/bot token path with current-user context.

Credential sidecar mode moves provider token handling out of the runner process where supported.

## Migration steps

1. Inventory shared projects and sessions.
2. List credentials used by those projects and agents.
3. Confirm each collaborator has the project or session role they need.
4. Grant credential token access only where required.
5. Prefer project or agent credential bindings over global credential access.
6. Start a fresh session and verify each collaborator can perform only the expected operations.
7. Remove old assumptions from runbooks, prompts, and automation scripts.

## What to check

- Private Git clone succeeds for users who should have access.
- Git/Jira/Google/kubeconfig tools fail cleanly for users who should not have access.
- Logs report credential failures without printing tokens.
- Runner messages and artifacts do not contain copied secrets.
- Sidecar-enabled deployments do not also pass the same provider token through broad environment variables.

## If a shared session fails after migration

Check in this order:

1. Does the caller have project or session access?
2. Is the credential bound at the correct scope?
3. Does the caller or session ServiceAccount have token-reader permission?
4. Is sidecar mode enabled for that provider, and is the sidecar image configured?
5. Is the runner receiving caller-token headers for HTTP turns?

Avoid fixing failures by granting global credential access unless that is genuinely the intended policy.
