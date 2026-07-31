# Reconciler Token Refresh

**Date:** 2026-07-31
**Status:** Draft
**Parent:** `control-plane.spec.md` — KubeReconciler
**Related:** `openshell-gateway-oidc.spec.md` — gateway OIDC; `openshell-sandbox-provisioning.spec.md` — sandbox lifecycle

---

## Purpose

Prevent sessions from getting stuck in `Creating` phase when the control plane's OIDC token expires during the sandbox readiness polling loop.

Today, `provisionSessionSandbox` calls `factory.ForProject(ctx, projectID)` once and passes the resulting `*sdkclient.Client` into `execAfterReady`. That client embeds a **static bearer token** captured at creation time. The readiness loop can block for up to 600 seconds (ndots retries, image pulls, scheduling delays). If the OIDC token expires during this wait, all subsequent API calls — `UpdateStatus` to `Running`, `failSession`, and `markCompleted` — fail with HTTP 401 and the session is orphaned in `Creating` forever.

### Observed incident (2026-07-31)

Session `dasfadsfdsa` (`3HHmQCYv7CBSoNwuiSeVohWmLm7`):

| Time | Event |
|------|-------|
| 21:24:48 | OIDC token acquired (expires 21:29:48, 5 min TTL) |
| 21:29:09 | `provisionSessionSandbox` → `ForProject()` captures SDK client with current token |
| 21:29:09 | Sandbox created, `execAfterReady` goroutine spawned |
| 21:29:51–21:30:15 | Three ndots retry cycles (pod deleted and recreated 3×, ~26s added) |
| 21:30:31 | Sandbox ready; `UpdateStatus(phase=Running)` → **HTTP 401** (token expired ~40s ago) |
| 21:30:44 | `markCompleted` → **HTTP 401** |

The session never left `Creating`. The UI showed it stuck indefinitely.

---

## Root Cause

`SDKClientFactory.ForProject()` (`internal/reconciler/shared.go:83`) calls `provider.Token(ctx)` and bakes the returned string into a new `sdkclient.Client`. The client has no mechanism to refresh its token. When `execAfterReady` (`kube_reconciler.go:766`) receives this client, it holds a token snapshot that can be minutes old by the time the sandbox becomes ready.

The `OIDCTokenProvider` (`internal/auth/token_provider.go:51`) already handles lazy refresh — it returns a cached token if valid with >30s remaining, or fetches a new one. The problem is that the reconciler never calls it again after the initial `ForProject()`.

---

## Requirements

### Requirement: SDK Client Refresh Before API Calls in execAfterReady

`execAfterReady` SHALL re-acquire the SDK client via `factory.ForProject(ctx, projectID)` immediately before making any Ambient API call, rather than using the client captured at provision time.

This ensures that `OIDCTokenProvider.Token()` is called at the moment the token is actually needed, not minutes earlier when the sandbox was first created.

#### Scenario: Token expires during sandbox readiness wait

- GIVEN an OIDC token with a 5-minute TTL acquired at T₀
- AND `execAfterReady` begins polling at T₀
- AND the sandbox becomes ready at T₀ + 6 minutes (beyond token expiry)
- WHEN `execAfterReady` re-acquires the SDK client before calling `UpdateStatus`
- THEN `ForProject()` SHALL call `OIDCTokenProvider.Token()` which fetches a fresh token
- AND `UpdateStatus(phase=Running)` SHALL succeed

#### Scenario: Token still valid during short sandbox wait

- GIVEN an OIDC token with a 5-minute TTL acquired at T₀
- AND the sandbox becomes ready at T₀ + 30 seconds
- WHEN `execAfterReady` re-acquires the SDK client before calling `UpdateStatus`
- THEN `ForProject()` SHALL return the cached client (token unchanged)
- AND no unnecessary token fetch occurs

#### Scenario: failSession closure uses fresh token

- GIVEN `execAfterReady` times out after 600 seconds
- WHEN `failSession` calls `UpdateStatus(phase=Failed)`
- THEN it SHALL use a freshly acquired SDK client, not the one captured at provision start
- AND the failure SHALL be recorded in the API server

#### Scenario: Token refresh fails

- GIVEN the OIDC provider is unreachable when `ForProject()` is called
- WHEN `execAfterReady` attempts to re-acquire the SDK client
- THEN the error SHALL be logged with the session ID
- AND the operation (phase update or failure marking) SHALL be skipped with a warning, not crash the reconciler

### Requirement: execAfterReady Receives Factory, Not Client

The `execAfterReady` function signature SHALL accept `*SDKClientFactory` and `projectID` instead of `*sdkclient.Client`. This makes it structurally impossible to use a stale captured client.

#### Scenario: Signature change

- GIVEN the current signature:
  ```go
  func (r *SimpleKubeReconciler) execAfterReady(
      namespace, sbxName, sessionID string,
      entrypoint []string,
      sdk *sdkclient.Client,       // ← captured snapshot
      execEnv map[string]string,
      payloads []types.Payload,
      stopOnRunFinished bool,
  )
  ```
- WHEN this spec is implemented
- THEN the signature SHALL become:
  ```go
  func (r *SimpleKubeReconciler) execAfterReady(
      namespace, sbxName, sessionID, projectID string,
      entrypoint []string,
      execEnv map[string]string,
      payloads []types.Payload,
      stopOnRunFinished bool,
  )
  ```
- AND `execAfterReady` SHALL call `r.factory.ForProject(ctx, projectID)` at each API call site

### Requirement: failSession Uses Fresh Client

The `failSession` closure inside `execAfterReady` currently captures the `sdk` variable from the enclosing scope. After this change, it SHALL call `r.factory.ForProject()` to obtain a fresh client.

#### Scenario: Failure after prolonged wait

- GIVEN a sandbox that enters error phase at T₀ + 8 minutes
- AND the original OIDC token expired at T₀ + 5 minutes
- WHEN `failSession` is invoked
- THEN it SHALL acquire a fresh SDK client
- AND `UpdateStatus(phase=Failed, conditions=[...])` SHALL succeed

---

## Scope

### In scope

- `internal/reconciler/kube_reconciler.go`: change `execAfterReady` signature, re-acquire SDK client before `UpdateStatus` calls
- `internal/reconciler/kube_reconciler.go`: update `failSession` closure to use factory
- `internal/reconciler/kube_reconciler.go`: update both call sites of `execAfterReady` (lines 482, 562) to pass `projectID` instead of `sdk`

### Out of scope

- `SDKClientFactory` internals — the lazy refresh logic is already correct
- `OIDCTokenProvider` — the 30-second buffer and mutex caching are sufficient
- ndots retry loop optimization (tracked in #421)
- Token endpoint for runner pods (orthogonal; runner uses CP token endpoint, not SDK client)

---

## Implementation Notes

The `sdk` variable is also used earlier in `provisionSessionSandbox` for `Projects().Get()`, `Agents().Get()`, and `buildSandboxEnv()`. Those calls happen synchronously before `execAfterReady` is spawned and complete within seconds — they are not at risk of token expiry and do not need to change.

The key call sites inside `execAfterReady` that need fresh clients:

| Line | Call | Risk |
|------|------|------|
| 949 | `sdk.Sessions().UpdateStatus(ctx, sessionID, {phase: Running})` | High — after readiness wait |
| 783 | `sdk.Sessions().UpdateStatus(ctx, sessionID, {phase: Failed})` (via `failSession`) | High — after timeout |
| 1059+ | completion marking after exec stream finishes | Medium — after entrypoint run |

Each of these should be preceded by `sdk, err := r.factory.ForProject(ctx, projectID)`.

---

## References

- Incident log: session `3HHmQCYv7CBSoNwuiSeVohWmLm7` stuck in Creating (2026-07-31)
- `internal/auth/token_provider.go` — `OIDCTokenProvider` with lazy refresh
- `internal/reconciler/shared.go:83` — `ForProject()` token-to-client binding
- `internal/reconciler/kube_reconciler.go:766` — `execAfterReady` entry point
- Issue #421 — ndots retry loop (contributing factor, separate fix)
