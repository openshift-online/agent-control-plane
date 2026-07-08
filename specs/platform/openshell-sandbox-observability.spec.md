# OpenShell Sandbox Observability Specification

**Date:** 2026-07-06
**Status:** Design
**Related:** `openshell-sandbox-provisioning.spec.md` — sandbox lifecycle; `views.spec.md` — session detail UI
**Skill:** `skills/build/full-stack-pipeline/` — wave-based implementation pipeline

---

## Purpose

Operators need visibility into the OpenShell sandbox layer — what the sandbox supervisor is doing, what network requests are allowed/denied, and what policy governs the sandbox. Today this information is only accessible via the `openshell` CLI:

```bash
openshell logs <sandbox-name> --gateway <namespace> --tail
openshell policy get <sandbox-name> --gateway <namespace> --full
```

This spec adds an **OpenShell tab** to the session detail UI that surfaces sandbox logs (streaming) and sandbox policy (on-demand fetch) through the existing control plane → gateway gRPC channel.

### Scope

This iteration covers:

- **Sandbox log streaming** — real-time log tail from the OpenShell gateway, surfaced as SSE through the API stack
- **Sandbox policy display** — full policy configuration (filesystem, network, process, landlock) rendered in a structured view

Out of scope:

- **Policy editing** — the policy tab is read-only; mutations happen via the agent sandbox config
- **Log filtering/search** — future iteration; the initial implementation shows the raw log stream

### Architecture

```
Browser → UI (Next.js BFF) → API Server (REST) → Control Plane (HTTP) → Gateway (gRPC)
```

The control plane already has an HTTP server on `:8080` (token server) and a gRPC gateway client with per-namespace mTLS connections. New HTTP endpoints on the CP proxy log streams and policy requests to the gateway. The API server proxies to the CP endpoints using the same pattern it uses for runner proxying.

---

## Requirements

### Requirement: Sandbox Log Streaming

The control plane SHALL expose an HTTP SSE endpoint that streams sandbox logs from the OpenShell gateway. The API server SHALL proxy this endpoint to the UI.

#### Gateway gRPC Integration

The OpenShell gateway exposes log streaming and policy retrieval RPCs not currently vendored in the ACP proto subset. The control plane SHALL vendor the following RPCs from the upstream `openshell.v1.OpenShell` service:

| RPC | Type | Purpose |
|-----|------|---------|
| `StreamSandboxLogs` | server-streaming | Streams structured log entries from gateway and sandbox |
| `GetSandboxPolicy` | unary | Returns the effective sandbox policy |

If the upstream RPC names differ from the above, the implementation SHALL adapt to the actual upstream proto definitions. The gateway client (`internal/openshell/gateway_client.go`) SHALL add methods for both RPCs following the existing connection-caching and mTLS patterns.

#### Control Plane HTTP Endpoints

The token server mux (`internal/tokenserver/server.go`) SHALL register two new endpoints:

| Method | Path | Response | Description |
|--------|------|----------|-------------|
| `GET` | `/sandbox/{name}/logs` | `text/event-stream` | SSE stream of sandbox log entries |
| `GET` | `/sandbox/{name}/policy` | `application/json` | Full sandbox policy as JSON |

The `{name}` path parameter is the sandbox name (e.g., `session-3g9cp9vh6mqwsag0hzhixysjju0`). The CP resolves the project namespace from the sandbox name prefix (which maps to a session ID) via the API server.

**Log SSE format:** Each SSE event SHALL contain a JSON-encoded log entry:

```
data: {"timestamp":1783387201.593,"source":"gateway","level":"INFO","module":"openshell_server::grpc::sandbox","message":"minted sandbox JWT"}

data: {"timestamp":1783387218.394,"source":"sandbox","level":"INFO","module":"openshell_sandbox","message":"Starting sandbox command=[\"sleep\", \"infinity\"]"}

data: {"timestamp":1783387244.795,"source":"sandbox","level":"MED","module":"ocsf","message":"DENIED /sandbox/.venv/lib/python3.14/site-packages/claude_agent_sdk/_bundled/claude(218) -> http-intake.logs.us5.datadoghq.com:443","category":"NET:OPEN","denied":true}
```

Log entry fields:

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | float64 | Unix timestamp with sub-second precision |
| `source` | string | `"gateway"` or `"sandbox"` |
| `level` | string | `"INFO"`, `"WARN"`, `"MED"`, `"OCSF"` |
| `module` | string | Rust module path (e.g., `openshell_server::grpc::sandbox`) |
| `message` | string | Log message text |
| `category` | string? | OCSF event category when present (e.g., `NET:OPEN`, `HTTP:GET`, `CONFIG:LOADED`) |
| `denied` | bool? | `true` when the log represents a denied action |

#### Scenario: Sandbox log streaming while session is running

- GIVEN a session in Running phase with an OpenShell sandbox
- WHEN the user opens the OpenShell tab → Sandbox Logs sub-tab
- THEN the UI opens an SSE connection to `/api/ambient/v1/sessions/{id}/sandbox/logs`
- AND log entries stream in real-time with timestamps, source badges, level indicators, and message text
- AND the view auto-scrolls to follow new entries (using the existing `useLiveTail` pattern)

#### Scenario: Sandbox log stream reconnection

- GIVEN an active sandbox log stream
- WHEN the SSE connection drops (network error, CP restart)
- THEN the UI reconnects automatically after 3 seconds
- AND displays a reconnection indicator
- AND reconnect attempts are capped at 5 (`MAX_RECONNECTS`)
- AND the reconnect counter resets to 0 on each successful connection

#### Scenario: Sandbox log entry memory management

- GIVEN a long-running sandbox log stream accumulating entries in the browser
- WHEN the entry count exceeds 5000 (`MAX_LOG_ENTRIES`)
- THEN the oldest entries are evicted (sliding window) to cap browser memory usage
- AND the UI retains the most recent 5000 entries

#### Scenario: Sandbox log entry type validation

- GIVEN an SSE event arrives from the log stream
- WHEN the event data is parsed
- THEN a type guard (`parseSandboxLogEntry`) validates and constructs each field with defaults for missing optional fields
- AND events missing required fields (`timestamp`, `message`) are silently dropped
- AND no unsafe type casts (`as unknown as T`) are used

#### Scenario: Session without OpenShell sandbox

- GIVEN a session that was created without gateway mode (pod-mode sandbox or no sandbox)
- WHEN the user views the session detail
- THEN the OpenShell tab SHALL NOT appear in the tab bar

#### Scenario: Sandbox not yet provisioned

- GIVEN a session in Creating phase (sandbox still provisioning)
- WHEN the user opens the OpenShell tab → Sandbox Logs sub-tab
- THEN the view displays a "Waiting for sandbox..." placeholder
- AND begins streaming once the sandbox reaches Ready phase

### Requirement: Sandbox Policy Display

The sandbox policy tab SHALL display the full effective policy governing the sandbox, matching the output of `openshell policy get --full`.

#### Scenario: Policy display

- GIVEN a running session with an OpenShell sandbox
- WHEN the user opens the OpenShell tab → Sandbox Policy sub-tab
- THEN the policy is fetched from `/api/ambient/v1/sessions/{id}/sandbox/policy`
- AND displayed as structured YAML in a read-only code block
- AND policy metadata (version, hash, status, source) is shown above the code block

#### Scenario: Policy sections

- GIVEN the sandbox policy is loaded
- WHEN the user views the policy
- THEN the following sections are visible: Filesystem Policy (read-only paths, read-write paths), Landlock (compatibility mode), Process (run_as_user, run_as_group), Network Policies (per-policy name: endpoints, binaries)
- AND network policy entries with `enforcement: enforce` are visually distinct from non-enforced entries

### Requirement: API Server Proxy Endpoints

The API server SHALL proxy sandbox observability requests from the UI to the control plane.

#### Endpoints

| Method | Path | Upstream | Description |
|--------|------|----------|-------------|
| `GET` | `/sessions/{id}/sandbox/logs` | `GET http://{cp-host}:8080/sandbox/{sandbox-name}/logs` | SSE passthrough |
| `GET` | `/sessions/{id}/sandbox/policy` | `GET http://{cp-host}:8080/sandbox/{sandbox-name}/policy` | JSON passthrough |

The API server resolves the sandbox name from the session's `kube_cr_name` field using `openshell.SandboxName()` logic: lowercase, truncate to 40 chars, prepend `session-`.

The control plane host is discovered from the `CONTROL_PLANE_URL` environment variable (or equivalent service DNS: `ambient-control-plane.ambient-code.svc.cluster.local:8080`).

#### Scenario: API server proxies log stream

- GIVEN a valid session with `kube_cr_name` and `kube_namespace` set
- WHEN the UI requests `GET /api/ambient/v1/sessions/{id}/sandbox/logs`
- THEN the API server opens an SSE connection to the CP's `/sandbox/{name}/logs` endpoint
- AND pipes the SSE stream to the client using the existing streaming passthrough pattern (`text/event-stream`, `X-Accel-Buffering: no`)

#### Scenario: API server proxies policy request with header filtering

- GIVEN a valid session with `kube_cr_name` and `kube_namespace` set
- WHEN the UI requests `GET /api/ambient/v1/sessions/{id}/sandbox/policy`
- THEN the API server proxies to the CP's `/sandbox/{name}/policy` endpoint
- AND only `Content-Type` and `Content-Length` response headers are forwarded to the client
- AND internal upstream headers (e.g., `Server`, `X-Powered-By`, tracing headers) are NOT forwarded — the API server is the trust boundary

#### Scenario: Session not in gateway mode

- GIVEN a session without a gateway-mode sandbox (no `kube_namespace` or gateway not enabled)
- WHEN the UI requests sandbox logs or policy
- THEN the API server returns `404 Not Found` with a descriptive error

### Requirement: OpenShell Tab in Session Detail UI

The session detail page SHALL add an **OpenShell** tab between the existing Logs tab and Resources tab. The tab SHALL only appear for sessions using gateway-mode sandboxes.

#### Tab Structure

The OpenShell tab contains two sub-tabs:

| Sub-Tab | Content | Data Source |
|---------|---------|-------------|
| **Sandbox Logs** (default) | Real-time log stream with source/level badges | SSE: `GET /api/ambient/v1/sessions/{id}/sandbox/logs` |
| **Sandbox Policy** | Structured policy YAML with metadata | REST: `GET /api/ambient/v1/sessions/{id}/sandbox/policy` |

#### Scenario: OpenShell tab visibility

- GIVEN a session created via gateway mode (`OPENSHELL_USE_GATEWAY=true`)
- WHEN the session detail page renders
- THEN the tab bar shows: Overview, Logs, **OpenShell**, Resources, Config, Chat
- AND the OpenShell tab icon is a shield or terminal icon

#### Scenario: OpenShell tab hidden for non-gateway sessions

- GIVEN a session created in pod mode (no gateway)
- WHEN the session detail page renders
- THEN the tab bar shows: Overview, Logs, Resources, Config, Chat (no OpenShell tab)

#### Scenario: Sandbox Logs sub-tab rendering

- GIVEN a running session with sandbox logs streaming
- WHEN the Sandbox Logs sub-tab renders
- THEN each log entry shows:
  - Timestamp (formatted as relative time, with absolute time on hover)
  - Source badge: `gateway` (blue) or `sandbox` (green)
  - Level indicator: `INFO` (default), `WARN` (amber), `MED` (amber), `OCSF` (purple)
  - OCSF category badge when present (e.g., `NET:OPEN`, `HTTP:GET`, `CONFIG:LOADED`)
  - Message text (monospace)
- AND denied actions (`denied: true`) are highlighted with a red left border and `DENIED` badge
- AND the log stream auto-follows new entries when scrolled to the bottom

#### Scenario: Sandbox Policy sub-tab rendering

- GIVEN a running session with a sandbox policy
- WHEN the Sandbox Policy sub-tab renders
- THEN policy metadata displays: Version, Hash (truncated), Status, Source
- AND the full policy YAML renders in a syntax-highlighted read-only code block
- AND the user can copy the policy YAML to clipboard

### Requirement: Session Domain Model Extension

The session domain model SHALL include a field indicating whether the session has a gateway-mode sandbox, to support conditional tab visibility.

#### Scenario: Gateway-mode detection

- GIVEN a session fetched from the API
- WHEN the UI maps the API response to `DomainSession`
- THEN `hasGatewaySandbox` is `true` when the session has both `kube_namespace` set AND the platform is running in gateway mode
- AND the OpenShell tab renders conditionally based on this field

### Requirement: Sandbox Log and Policy Persistence

Sandbox logs and policy SHALL be persisted to the sessions table so they survive sandbox shutdown. Operators see historical sandbox data for stopped sessions, matching the pattern used for chat message history.

#### Data Model

Two TEXT columns on the `sessions` table:

| Column | Type | Content |
|--------|------|---------|
| `sandbox_logs_snapshot` | TEXT (nullable) | JSON array of `SandboxLogEntry` objects — the last 500 log lines |
| `sandbox_policy_snapshot` | TEXT (nullable) | JSON `SandboxPolicyResponse` envelope — the full effective policy |

Both fields are write-only from the CP's perspective (set via `UpdateStatus` patch) and read-only from the API/UI perspective (never set by users). See `data-model.spec.md` for field details.

#### Collection Strategy

The CP's `PodStatusSyncer` (15s tick) collects both snapshots on every sync cycle:

| Data | Source | Cadence | Cost |
|------|--------|---------|------|
| Policy | Extracted from existing `GetSandbox` response | Every 15s | Zero — response already fetched |
| Logs | `WatchSandbox` with `FollowLogs: false, LogTailLines: 500` | Every 15s | One additional gRPC call per running session |

A **final snapshot** is taken in `deprovisionSessionSandbox()` before `DeleteSandbox` is called. This guarantees the stored data matches the live SSE stream for normal stop flows. For abnormal termination (sandbox crash), the most recent periodic snapshot (at most 15s stale) serves as fallback.

See `control-plane.spec.md` § Sandbox Snapshot Collection for implementation details.

#### Scenario: Periodic snapshot during running session

- GIVEN a session in Running phase with an OpenShell sandbox
- WHEN the `PodStatusSyncer` runs its 15s sync cycle
- THEN the CP extracts the policy from the `GetSandbox` response
- AND fetches the last 500 log lines via `WatchSandbox` with `FollowLogs: false`
- AND pushes both as `sandbox_policy_snapshot` and `sandbox_logs_snapshot` in the `UpdateStatus` patch

#### Scenario: Pre-delete final snapshot

- GIVEN a session transitioning to Stopping phase
- WHEN `deprovisionSessionSandbox()` runs (before `DeleteSandbox`)
- THEN the CP fetches a complete log and policy snapshot
- AND pushes both to the API server via `UpdateStatus`
- AND only then proceeds to `DeleteSandbox`

#### Scenario: Historical fallback in UI

- GIVEN a session in a terminal phase (Stopped, Completed, Failed) with persisted snapshot data
- WHEN the user opens the OpenShell tab → Sandbox Logs sub-tab
- THEN the UI displays the stored `sandbox_logs_snapshot` data with a "Historical" indicator
- AND the Sandbox Policy sub-tab displays the stored `sandbox_policy_snapshot` data with a "Historical" indicator

#### Scenario: Session without snapshot data

- GIVEN a session in a terminal phase with NULL snapshot fields (created before this feature, or snapshot collection failed)
- WHEN the user opens the OpenShell tab
- THEN the Sandbox Logs sub-tab displays "No sandbox logs available for this session."
- AND the Sandbox Policy sub-tab displays "No sandbox policy available for this session."

#### Scenario: Abnormal termination fallback

- GIVEN a running session whose sandbox crashes unexpectedly (no `deprovisionSessionSandbox` call)
- WHEN the session reaches a terminal phase
- THEN the most recent periodic snapshot (at most 15s stale) is available as historical data

---

## Data Model

### Sandbox Log Entry

```typescript
type SandboxLogEntry = {
  timestamp: number      // Unix timestamp (float64, sub-second precision)
  source: 'gateway' | 'sandbox'
  level: string          // INFO, WARN, MED, OCSF
  module: string         // Rust module path
  message: string        // Log message text
  category?: string      // OCSF event category (NET:OPEN, HTTP:GET, etc.)
  denied?: boolean       // true when action was denied
}
```

### Sandbox Policy Response

```typescript
type SandboxPolicyResponse = {
  version: number
  hash: string
  status: string         // 'Effective', 'Pending', etc.
  source: string         // 'sandbox', 'gateway', etc.
  config_revision: string
  policy: SandboxPolicy
}

type SandboxPolicy = {
  version: number
  filesystem_policy: {
    include_workdir: boolean
    read_only: string[]
    read_write: string[]
  }
  landlock: {
    compatibility: string
  }
  process: {
    run_as_user: string
    run_as_group: string
  }
  network_policies: Record<string, NetworkPolicy>
}

type NetworkPolicy = {
  name: string
  endpoints: NetworkEndpoint[]
  binaries?: NetworkBinary[]
}

type NetworkEndpoint = {
  host: string
  port: number
  protocol?: string
  tls?: string
  enforcement?: string
  access?: string
}

type NetworkBinary = {
  path: string
}
```

---

## Migration

### Existing consumers

| Consumer | Impact | Action |
|----------|--------|--------|
| Session detail page (`page.tsx`) | New tab added | Add OpenShell tab trigger/content conditionally |
| Views spec (`views.spec.md`) | New scenarios | Add OpenShell tab scenarios |
| Token server (`tokenserver/server.go`) | New routes on existing mux | Add `/sandbox/` handler registrations |
| Gateway client (`gateway_client.go`) | New methods | Add `StreamSandboxLogs` and `GetSandboxPolicy` |
| Gateway interface (`gateway_iface.go`) | New methods | Extend interface |
| Session handler (`handler.go`) | New proxy endpoints | Add sandbox log/policy proxy handlers |
| Session plugin routes (`plugin.go`) | New route registrations | Register `/sessions/{id}/sandbox/logs` and `/sessions/{id}/sandbox/policy` |
| Vendored protos | New RPCs needed | Vendor `StreamSandboxLogs` and `GetSandboxPolicy` from upstream |
| BFF proxy (`[...path]/route.ts`) | SSE passthrough | Already supported, no changes needed |

### Backward compatibility

Sessions created before this feature will not have gateway-mode metadata. The OpenShell tab will not appear for these sessions.

A database migration adds two nullable TEXT columns (`sandbox_logs_snapshot`, `sandbox_policy_snapshot`) to the sessions table. Sessions created before this migration will have NULL values — the UI shows "No data available." for these sessions. The migration is additive and safe to run against existing data.

The control plane HTTP endpoints are additive. The token server mux gains new routes without affecting the existing `/token` and `/healthz` endpoints.

---

## Design Decisions

### Why stream through the CP instead of direct gateway access?

The CP already manages per-namespace mTLS connections to the gateway. Routing sandbox observability through the CP avoids duplicating credential resolution in the API server and keeps the gateway network surface internal to the cluster.

### Why SSE instead of WebSocket?

SSE is unidirectional (server-to-client), matches the log-tailing use case, and is already supported by the BFF proxy passthrough. The existing runner event streaming uses the same SSE pattern.

### Why snapshot to PostgreSQL instead of a dedicated log store?

Sandbox log snapshots are bounded (last 500 lines) and scoped to individual sessions — they are not unbounded telemetry streams. Storing them as TEXT columns on the sessions table reuses the existing data model and avoids introducing a new storage dependency (Loki, Elasticsearch). The write pattern (one update per 15s sync cycle) is well within PostgreSQL's capabilities. If full historical log search is needed in the future, a dedicated log aggregation system would complement (not replace) these snapshots.

### Why pre-delete final snapshot?

The periodic 15s snapshots provide good coverage, but the final state of the sandbox (last log entries, final policy) is the most valuable for post-mortem analysis. By fetching a complete snapshot in `deprovisionSessionSandbox()` before `DeleteSandbox`, the stored data is guaranteed to match what the live SSE stream showed — no 15s gap. For abnormal termination, the periodic snapshot serves as a fallback.
