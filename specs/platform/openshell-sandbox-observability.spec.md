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

- **Log persistence** — logs are streamed live and not stored in PostgreSQL; historical logs after sandbox termination are not available
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
- THEN the UI reconnects automatically after a brief delay
- AND displays a reconnection indicator

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

Sessions created before this feature will not have gateway-mode metadata. The OpenShell tab will not appear for these sessions. No database migration is required — the feature reads existing session fields (`kube_namespace`, `kube_cr_name`) to determine gateway-mode status.

The control plane HTTP endpoints are additive. The token server mux gains new routes without affecting the existing `/token` and `/healthz` endpoints.

---

## Design Decisions

### Why stream through the CP instead of direct gateway access?

The CP already manages per-namespace mTLS connections to the gateway. Routing sandbox observability through the CP avoids duplicating credential resolution in the API server and keeps the gateway network surface internal to the cluster.

### Why SSE instead of WebSocket?

SSE is unidirectional (server-to-client), matches the log-tailing use case, and is already supported by the BFF proxy passthrough. The existing runner event streaming uses the same SSE pattern.

### Why not store logs in PostgreSQL?

Sandbox logs are high-volume operational telemetry (network events, policy evaluations, process launches). Storing them would significantly increase database write load and storage. Live streaming provides the observability operators need without storage overhead. If historical log search is needed in the future, a dedicated log aggregation system (e.g., Loki) would be more appropriate than PostgreSQL.
