# Control Plane

**Date:** 2026-03-22
**Status:** Living Document — current state documented; proposed changes marked
**Skill:** `skills/build/full-stack-pipeline/` — wave-based implementation pipeline

---

## Overview

The Ambient Control Plane (CP) and the Runner are two cooperating runtime components that sit between the api-server and the actual Claude Code execution. Together they implement the execution half of the session lifecycle: provisioning Kubernetes resources, starting Claude, delivering messages in both directions, and persisting the conversation record.

```
User / CLI
    │  REST / gRPC
    ▼
ambient-api-server          ← data model, auth, RBAC, DB
    │  gRPC WatchSessions
    ▼
ambient-control-plane (CP)  ← K8s provisioner + session watcher
    │  K8s API + env vars
    ▼
Runner Pod                  ← FastAPI + ClaudeBridge + gRPC client
    │  Claude Agent SDK
    ▼
Claude Code CLI (subprocess)
```

The api-server is the source of truth for all persistent state. The CP and Runner have no databases of their own. They read from the api-server via the Go SDK and write back via `PushSessionMessage` gRPC and `UpdateStatus` REST.

---

## Control Plane (CP)

### What It Is

The CP is a standalone Go service (`ambient-control-plane`) that:

1. **Watches** the api-server for session events via gRPC `WatchSessions`
2. **Provisions** Kubernetes resources for each session (namespace, secret, service account, pod, service)
3. **Assembles** the start context (Project.prompt + Agent.prompt + Inbox messages + Session.prompt) and injects it as `INITIAL_PROMPT` env var into the runner pod
4. **Updates** session phase via `sdk.Sessions().UpdateStatus()` as pods transition through states

The CP does not proxy traffic. It does not fan out events. It does not hold any persistent state. It is a pure Kubernetes reconciler driven by the api-server event stream.

### Components

#### `internal/watcher/watcher.go` — WatchManager

Maintains one gRPC `WatchSessions` stream per resource type (sessions, projects, project_settings). Reconnects with exponential backoff (1s → 30s) on stream failure. Dispatches each event to a buffered channel consumed by the Informer.

#### `internal/informer/informer.go` — Informer

Performs an initial list+watch sync at startup. Converts proto events to SDK types. Buffers events (256 capacity) and dispatches them to all registered reconcilers.

#### `internal/reconciler/kube_reconciler.go` — KubeReconciler

Handles `session ADDED` and `session MODIFIED (phase=Pending)` events by provisioning:

1. Namespace (named `{project_id}`)
2. K8s Secret with `BOT_TOKEN` (the runner's api-server credential)
3. ServiceAccount (no automount)
4. Pod (runner image + env vars)
5. Service (ClusterIP on port 8001 pointing at the pod)
6. RoleBinding granting `system:image-builder` ClusterRole to `session-{id}-sa` (enables push to the OpenShift internal image registry)

On `phase=Stopping` → calls `deprovisionSession` (deletes pods).
On `DELETED` → calls `cleanupSession` (deletes pod, secret, service account, service, namespace).

#### `internal/reconciler/project_reconciler.go` — ProjectReconciler

Watches Project events via gRPC informer. Creates Kubernetes namespaces for each Project via `ensureNamespace()`, provisions runner secrets, and sets up control plane RBAC. Project = Namespace — the ProjectReconciler is the sole owner of namespace lifecycle.

#### `internal/reconciler/gateway_reconciler.go` — GatewayReconciler

Watches Gateway resource events via gRPC informer. Reconciles `kind: Gateway` API resources into Kubernetes gateway deployments (StatefulSet, Service, RBAC, certgen Job, NetworkPolicy) in the project namespace. Replaces the previous ConfigMap-based `internal/gateway/` package. Reuses manifest templating from `internal/gateway/manifests.go` and validation from `internal/gateway/validation.go`. See [gateway-provisioning.spec.md](./gateway-provisioning.spec.md) for the full specification.

#### `internal/reconciler/application_reconciler.go` — ApplicationReconciler

Git-based GitOps reconciler that syncs agent fleet definitions from git repositories. Uses the shared kustomize library (extracted from `acpctl apply`) to render manifests. Supports `kind: Gateway` documents in rendered manifests, applying them to the API server alongside Project, Agent, Credential, and RoleBinding resources.

#### `internal/reconciler/shared.go` — SDKClientFactory

Mints and caches per-project SDK clients. Each project uses the same bearer token but different project context. Also provides `namespaceForSession`, phase constants, and label helpers.

#### `internal/kubeclient/kubeclient.go` — KubeClient

Thin wrapper over `k8s.io/client-go` dynamic client. Provides typed `Create/Get/Delete` methods for Pod, Service, Secret, ServiceAccount, Namespace, RoleBinding. Eliminates raw unstructured map construction from reconciler code.

### Pod Provisioning

The CP creates a Pod (not a Job) for each session. Key pod attributes:

| Attribute | Value | Reason |
|---|---|---|
| `restartPolicy` | `Never` | Sessions are single-run; no automatic restart |
| `imagePullPolicy` | `IfNotPresent` for `localhost/` images, `Always` otherwise | kind uses local containerd — `Always` breaks `localhost/` image pulls |
| `serviceAccountName` | `session-{id}-sa` | Session-scoped; no cross-session access |
| `automountServiceAccountToken` | `true` | Runner uses the SA token to authenticate to the CP token endpoint |
| CPU request/limit | 500m / 2000m | Generous for Claude Code |
| Memory request/limit | 512Mi / 4Gi | Claude Code is memory-intensive |

The CP binds the `system:image-builder` ClusterRole to `session-{id}-sa` via a namespace-scoped RoleBinding at provision time. This grants the runner pod push access to the OpenShift internal image registry (`image-registry.openshift-image-registry.svc:5000`), enabling agents to build and push images using daemonless tools such as `crane`. Pull access is provided automatically to all SAs in the namespace by OpenShift via the `system:image-pullers` RoleBinding created at namespace initialization.

### Start Context Assembly

`assembleInitialPrompt` builds the initial prompt from four sources in order:

```
1. Project.prompt        — workspace-level context (shared by all agents in this project)
2. Agent.prompt          — who this agent is (if session has AgentID)
3. Inbox messages        — unread InboxMessage.Body items addressed to this agent
4. Session.prompt        — what this specific run should do
```

Each section is joined with `\n\n`. Empty sections are omitted. If all four are empty, the prompt is not delivered and the runner waits for a user message via gRPC.

**Delivery mechanism varies by runtime:**
- **Gateway (OpenShell) sandboxes:** The assembled prompt is written to `/tmp/initial_prompt.txt` via SSH payload upload before the runner entrypoint executes. The `INITIAL_PROMPT` env var is NOT set — OpenShell strips env vars containing newlines, which the assembled prompt always contains.
- **Operator (Job) pods:** The assembled prompt is set as the `INITIAL_PROMPT` env var on the Job container spec.

### Environment Variables Injected into Runner Pod

| Var | Value | Purpose |
|---|---|---|
| `SESSION_ID` | session.ID | Primary session identifier |
| `PROJECT_NAME` | session.ProjectID | Project context |
| `WORKSPACE_PATH` | `/workspace` | Claude Code working directory |
| `AGUI_PORT` | `8001` | Runner HTTP listener port |
| `BACKEND_API_URL` | CP config | api-server base URL |
| `AMBIENT_GRPC_URL` | CP config | api-server gRPC address |
| `AMBIENT_GRPC_USE_TLS` | CP config | TLS flag for gRPC |
| `AMBIENT_CP_TOKEN_URL` | CP config | CP token endpoint URL (e.g. `http://ambient-control-plane.{ns}.svc:8080/token`) |
| `INITIAL_PROMPT` | assembled prompt | Auto-execute on startup (operator Job path only; gateway sandboxes receive the prompt via `/tmp/initial_prompt.txt` file upload) |
| `IS_RESUME` | `"true"` | Set when `session.StartTime != nil` (session has been started before); tells the runner to skip `INITIAL_PROMPT` auto-execute |
| `RESUME_AFTER_SEQ` | max `seq` from session_messages | Set alongside `IS_RESUME` when messages exist; runner's gRPC listener starts watching from this seq to prevent replay of historical messages |
| `USE_VERTEX` / `ANTHROPIC_VERTEX_PROJECT_ID` / `CLOUD_ML_REGION` | CP config | Vertex AI config (when enabled) |
| `GOOGLE_APPLICATION_CREDENTIALS` | `/app/vertex/ambient-code-key.json` | Vertex service account path |
| `LLM_MODEL` / `LLM_TEMPERATURE` / `LLM_MAX_TOKENS` | session fields | Per-session model config |
| `CREDENTIAL_IDS` | JSON map `{provider: credential_id}` | Resolved credentials for this session; runner calls `/credentials/{id}/token` per provider |

### Session Restart Behavior

When the CP provisions a runner pod for a session that has been started before (`session.StartTime != nil`), it sets restart-specific env vars to prevent the runner from replaying the initial prompt and historical messages:

```
if session.StartTime != nil:
    1. Set IS_RESUME=true
    2. Query api-server: GET /api/ambient/v1/session_messages?search=session_id='...'&orderBy=seq desc&size=1
    3. If messages exist, set RESUME_AFTER_SEQ=<max_seq>
```

The CP uses the Go SDK's `SessionMessages().List()` with `size=1`, `orderBy=seq desc` to resolve the maximum sequence number. This translates to a `GET /api/ambient/v1/session_messages` call against the api-server.

On the runner side:
- `IS_RESUME=true` causes `INITIAL_PROMPT` to be skipped (no auto-execute on startup)
- `RESUME_AFTER_SEQ=N` causes the gRPC listener to start `WatchSessionMessages` from `last_seq=N`, skipping all messages with `seq <= N`

This ensures a restarted session picks up from where it left off without replaying the initial prompt or re-processing historical user messages.

---

## Runner

### What It Is

The Runner is a Python FastAPI application (`ambient-runner`) that runs inside each session pod. It:

1. **Owns** the Claude Code execution lifecycle (start, run, interrupt, shutdown)
2. **Bridges** between the AG-UI protocol (HTTP SSE) and the gRPC message store
3. **Listens** to the api-server gRPC stream for inbound user messages
4. **Pushes** conversation records back to the api-server via `PushSessionMessage`
5. **Exposes** a local SSE endpoint for live AG-UI event observation

One runner pod runs per session. The pod is ephemeral — it exists only while the session is active.

### Internal Structure

```
app.py                          ← FastAPI application factory + lifespan
  │
  ├── endpoints/
  │     ├── run.py              ← POST / (AG-UI run endpoint)
  │     ├── events.py           ← GET /events/{thread_id} (SSE tap — NEW)
  │     ├── interrupt.py        ← POST /interrupt
  │     ├── health.py           ← GET /health
  │     └── ...                 (capabilities, repos, workflow, mcp_status, content)
  │
  ├── bridges/claude/
  │     ├── bridge.py           ← ClaudeBridge (PlatformBridge impl)
  │     ├── grpc_transport.py   ← GRPCSessionListener + GRPCMessageWriter
  │     ├── session.py          ← SessionManager + SessionWorker
  │     ├── auth.py             ← Vertex AI / Anthropic auth setup
  │     ├── mcp.py              ← MCP server config
  │     └── prompts.py          ← System prompt builder
  │
  ├── _grpc_client.py           ← AmbientGRPCClient (codegen)
  ├── _session_messages_api.py  ← SessionMessagesAPI (codegen, hand-rolled proto codec)
  │
  └── middleware/
        └── grpc_push.py        ← grpc_push_middleware (HTTP path fire-and-forget)
```

### Startup Sequence

When `AMBIENT_GRPC_URL` is set (standard deployment):

```
1. app.py lifespan() starts
2. RunnerContext created from env vars (SESSION_ID, WORKSPACE_PATH)
3. bridge.set_context(context)
4. bridge._setup_platform() called eagerly:
     - SessionManager initialized
     - Vertex AI / Anthropic auth configured
     - MCP servers loaded
     - System prompt built
     - GRPCSessionListener instantiated and started
       → If RESUME_AFTER_SEQ set: listener initializes last_seq from env var,
         skipping all historical messages (seq <= RESUME_AFTER_SEQ)
       → WatchSessionMessages RPC opens
       → listener.ready asyncio.Event set
5. await bridge._grpc_listener.ready.wait()
   (blocks until WatchSessionMessages stream is confirmed open)
6. If not IS_RESUME, read initial prompt:
     a. Try /tmp/initial_prompt.txt (gateway file upload)
     b. Fall back to INITIAL_PROMPT env var (operator Job path)
   If prompt found:
     _auto_execute_initial_prompt(prompt, session_id, grpc_url)
     → _push_initial_prompt_via_grpc()
       → PushSessionMessage(event_type="user", payload=prompt)
       → listener receives its own push → triggers bridge.run()
7. yield (app is ready, uvicorn serving)
8. On shutdown: bridge.shutdown() → GRPCSessionListener.stop()
```

### gRPC Transport Layer

#### `GRPCSessionListener` (pod-lifetime)

Subscribes to `WatchSessionMessages` for this session via a blocking iterator running in a `ThreadPoolExecutor`. For each inbound message:

- `event_type == "user"` → parse payload as `RunnerInput` → call `bridge.run()` → fan out events
- All other types → logged and skipped (runner only drives runs on user messages)

Sets `self.ready` (asyncio.Event) once the stream is open. Reconnects with exponential backoff on stream failure. Tracks `last_seq` to resume after reconnect.

Fan-out during a turn:
```
bridge.run() yields events
  ├── bridge._active_streams[thread_id].put_nowait(event)   ← SSE tap queue
  └── writer.consume(event)                                 ← GRPCMessageWriter
```

#### `GRPCMessageWriter` (per-turn)

Accumulates `MESSAGES_SNAPSHOT` events during a turn. On `RUN_FINISHED` or `RUN_ERROR`, calls `PushSessionMessage(event_type="assistant")` with the assembled payload.

**Current payload format (proposed for change — see below):**

```json
{
  "run_id": "...",
  "status": "completed",
  "messages": [
    {"role": "user", "content": "..."},
    {"role": "reasoning", "content": "..."},
    {"role": "assistant", "content": "..."}
  ]
}
```

This payload includes the user echo and reasoning content, making it verbose and difficult to display in the CLI.

#### `grpc_push_middleware` (HTTP path, secondary)

Wraps the HTTP run endpoint event stream. Calls `PushSessionMessage` once per AG-UI event as events flow out of `bridge.run()`. Fire-and-forget. Active only on the HTTP POST `/` path, not the gRPC listener path.

**Note:** With the gRPC listener as the primary path, `grpc_push_middleware` fires only when a run is triggered via HTTP (external POST). This is a secondary path for backward compatibility; the gRPC listener path is preferred.

### Two Message Streams

| Stream | Source | Content | Persistence | Purpose |
|---|---|---|---|---|
| `WatchSessionMessages` (gRPC DB stream) | api-server DB | `event_type=user` and `event_type=assistant` rows | Persisted; replay from seq=0 | Durable conversation record; CLI, history |
| `GET /events/{thread_id}` (SSE tap) | Runner in-memory queue | All AG-UI events: tokens, tool calls, reasoning chunks, status events | Ephemeral; runner-local; lost on reconnect | Live UI; streaming display; observability |

### `GET /events/{thread_id}` — SSE Tap Endpoint

Added to `endpoints/events.py`. Registered as a core (always-on) endpoint.

Behavior:
1. Registers `asyncio.Queue(maxsize=256)` into `bridge._active_streams[thread_id]`
2. Streams every AG-UI event as SSE until `RUN_FINISHED` / `RUN_ERROR` or client disconnect
3. Sends `: keepalive` pings every 30s to hold the connection
4. On exit (any reason), removes the queue from `_active_streams`

This endpoint is read-only. It never calls `bridge.run()` or modifies any state. It is a pure observer.

`thread_id` in the runner corresponds to the session ID (same value as `SESSION_ID` env var).

---

## SessionMessage Payload Contract

### Current State (as-built)

`event_type=user` payload: plain string — the user's message text.

`event_type=assistant` payload: JSON blob containing:
- `run_id` — the run that produced this turn
- `status` — `"completed"` or `"error"`
- `messages` — array of all MESSAGES_SNAPSHOT messages including:
  - `role=user` (echo of the input)
  - `role=reasoning` (extended thinking content)
  - `role=assistant` (Claude's reply)

This is verbose, inconsistent with the user payload format, and leaks reasoning content into the durable record.

### Proposed State

`event_type=user` payload: plain string — unchanged.

`event_type=assistant` payload: plain string — the assistant's reply text only.

Specifically: extract only the `role=assistant` message's `content` field from the final `MESSAGES_SNAPSHOT` and store that as the payload. Symmetric with `event_type=user`.

**What moves where:**
- `role=reasoning` content → flows through `GET /events/{thread_id}` SSE only (ephemeral, live)
- `role=assistant` content → stored as plain string in `event_type=assistant` DB row
- `role=user` echo → already in `event_type=user` DB row; no need to repeat

**Rationale:**
- CLI can display `event_type=user` and `event_type=assistant` identically — both are plain strings
- Reasoning is observability data, not conversation record data
- Payload size drops dramatically (reasoning can be 10x longer than the reply)
- Replay via `WatchSessionMessages` returns a clean conversation thread

### Implementation Target: `GRPCMessageWriter._write_message()`

Current:
```python
payload = json.dumps({
    "run_id": self._run_id,
    "status": status,
    "messages": self._accumulated_messages,
})
```

Proposed:
```python
assistant_text = next(
    (m.get("content", "") for m in self._accumulated_messages
     if m.get("role") == "assistant"),
    "",
)
payload = assistant_text
```

---

## API Server Proxy: `GET /sessions/{id}/events`

The runner's `GET /events/{thread_id}` is only accessible within the cluster (pod-to-pod via ClusterIP Service). External clients need a proxy through the api-server.

The CP creates a `session-{id}` Service (ClusterIP, port 8001) pointing at the runner pod. The api-server can reach it at:

```
http://session-{kube_cr_name}.{kube_namespace}.svc.cluster.local:8001/events/{kube_cr_name}
```

The proposed `GET /api/ambient/v1/sessions/{id}/events` endpoint on the api-server:

1. Looks up the session from DB — gets `kube_cr_name` and `kube_namespace`
2. Constructs the runner URL
3. Opens an HTTP GET with `Accept: text/event-stream`
4. Streams the runner's SSE body verbatim to the client response
5. Passes keepalive pings through unchanged
6. Closes the client stream when the runner closes or client disconnects

This endpoint is implemented in `plugins/sessions/plugin.go` as `GET /sessions/{id}/events` → `sessionHandler.StreamRunnerEvents` (status: ✅ implemented).

---

## Generic Backend Proxy

`plugins/proxy/plugin.go` (ambient-api-server) forwards every request whose path does NOT start with `/api/ambient/` verbatim to `BACKEND_URL` (default `http://localhost:8080`). Method, path, query string, headers (including `Authorization`), and body are forwarded unchanged. The response — headers, status code, body — is copied back unchanged.

Implementation: `pkgserver.RegisterPreAuthMiddleware` wraps the entire HTTP server before routing. Native paths (`/api/ambient/...`, `/metrics`, `/favicon.ico`) fall through to the next handler; all others are proxied.

Status: ✅ implemented — `plugins/proxy/plugin.go`; blank-imported in `cmd/ambient-api-server/main.go`.

---

## CLI: `acpctl session events`

Streams live AG-UI events for a session via `GET /sessions/{id}/events`.

```
acpctl session events <session-id>
```

Behavior:
- Opens SSE connection to api-server `/sessions/{id}/events`
- Renders each event type distinctly:
  - `TEXT_MESSAGE_CONTENT` → print token to stdout (no newline — streaming)
  - `RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR` → status line
  - `TOOL_CALL_START` / `TOOL_CALL_END` → tool name + status
  - `: keepalive` → ignored
- Exits on `RUN_FINISHED`, `RUN_ERROR`, or Ctrl+C

Status: 🔲 planned

---

## CP Token Endpoint

### Problem

Runner pods authenticate to the api-server gRPC interface using a `BOT_TOKEN` injected at pod start and refreshed by the CP every 4 minutes via a K8s Secret update. In OIDC environments (e.g. S0), `BOT_TOKEN` is an OIDC client-credentials JWT with a 15-minute TTL.

This creates a three-way async race:

1. CP ticker writes a fresh token to the Secret every 4 minutes
2. Kubelet propagates the Secret update to the pod's file mount (30–60s delay in busy clusters)
3. Runner reads the file mount on gRPC reconnect

When the CP writes a token that is already close to expiry — because its in-memory `OIDCTokenProvider` cache had a short buffer — the runner reconnects with an already-expired token and enters an `UNAUTHENTICATED` loop.

The fundamental issue is that the Secret-write model is an **async push** with no synchronization guarantee between when the token is written and when the runner reads it.

### Solution

The CP exposes a lightweight HTTP endpoint that runners call **synchronously on demand** to obtain a guaranteed-fresh token. This eliminates the async race entirely.

```
GET /token
```

- Served by a new `net/http` listener on the CP (port 8080, separate from any existing listener)
- Runner authenticates using its K8s service account token (mounted at `/var/run/secrets/kubernetes.io/serviceaccount/token`) — validated by the CP via the K8s `TokenReview` API
- CP calls `tokenProvider.Token(ctx)` at request time and returns the result — always fresh, always valid TTL
- Response: `{"token": "<value>", "expires_at": "<RFC3339>"}`

### Authentication

The runner's K8s SA token is a signed JWT issued by the K8s API server. The CP validates it using the K8s `authentication/v1` `TokenReview` resource:

```
POST /apis/authentication.k8s.io/v1/tokenreviews
{
  "spec": { "token": "<runner SA token>" }
}
```

A successful `TokenReview` returns `status.authenticated=true` and `status.user.username` (e.g. `system:serviceaccount:ambient-code--myproject:session-abc123-sa`). The CP verifies the username prefix matches a known runner SA pattern before returning a token.

This approach uses credentials already present in every pod — no new secrets required.

### Token Lifecycle

The CP token endpoint is the **sole source** of the api-server bearer token for all runner pods. There is no Secret write loop and no `BOT_TOKEN` env var or file mount.

| Phase | Mechanism |
|---|---|
| Initial startup | `GET /token` from CP endpoint — called in lifespan before gRPC channel opens |
| gRPC reconnect | `GET /token` from CP endpoint — synchronous, guaranteed fresh |

The CP is critical infrastructure. It creates the runner pod, so it is running before the runner makes its first token request. If the CP is unreachable, the runner cannot function regardless (the CP is also responsible for all K8s provisioning). No fallback is needed or provided.

### CP HTTP Server

The CP adds a minimal `net/http` server alongside its existing K8s controller loop:

```go
mux := http.NewServeMux()
mux.HandleFunc("/token", tokenHandler)
mux.HandleFunc("/healthz", healthHandler)
http.ListenAndServe(":8080", mux)
```

The server runs in a goroutine alongside `runKubeMode`. It shares the existing `tokenProvider` and `k8sClient` from the main CP config.

### Runner Changes

`_grpc_client.py` `reconnect()` is updated to call the CP token endpoint instead of re-reading the Secret file:

```python
def reconnect(self) -> None:
    fresh_token = _fetch_token_from_cp()   # GET AMBIENT_CP_TOKEN_URL/token with SA token
    self.close()
    self._token = fresh_token
```

`AMBIENT_CP_TOKEN_URL` is injected by the CP as an env var when creating the runner pod. In local dev environments where the CP is not present, `BOT_TOKEN` env var may be set directly and the runner skips the CP endpoint call.

### New CP Internal Packages

| Package | Purpose |
|---|---|
| `internal/tokenserver/server.go` | HTTP server setup and graceful shutdown |
| `internal/tokenserver/handler.go` | `GET /token` handler — TokenReview validation + tokenProvider call |

Status: 🔲 planned — RHOAIENG-56711

---

## Runner Credential Fetch

The runner fetches provider credentials at session start before invoking Claude. Credentials are resolved by the CP and injected into the runner pod as `CREDENTIAL_IDS` — a JSON-encoded map of `provider → credential_id`:

```
CREDENTIAL_IDS={"gitlab": "01JX...", "github": "01JY...", "jira": "01JZ..."}
```

The CP builds this map from the Credential Kind RBAC resolver: for each provider, walk agent → project → global scope and take the most specific matching credential. Credentials not visible to this session are excluded.

The runner calls `GET /api/ambient/v1/credentials/{id}/token` for each provider present in `CREDENTIAL_IDS`. The token endpoint is gated by `credential:token-reader` — the CP grants this role to the runner pod's service account at session start for each injected credential ID.

**Token response shape:**

```json
{ "provider": "gitlab", "token": "glpat-...",      "url": "https://gitlab.myco.com" }
{ "provider": "github", "token": "github_pat_...", "url": "https://github.com" }
{ "provider": "jira",   "token": "ATATT3x...",     "url": "https://myco.atlassian.net", "email": "bot@myco.com" }
{ "provider": "google", "token": "{\"type\":\"service_account\", ...}" }
```

`token` is always present. `url` and `email` are included when set on the Credential. The runner maps each response to environment variables and on-disk files consumed by Claude Code and its tools.

### Environment Variables Set by Runner After Credential Fetch

| Provider | Env vars set | Files written |
|----------|-------------|---------------|
| `google` | `USER_GOOGLE_EMAIL` | `credentials.json` (token value is full SA JSON) |
| `jira`   | `JIRA_URL`, `JIRA_API_TOKEN`, `JIRA_EMAIL` | — |
| `gitlab` | `GITLAB_TOKEN` | `/tmp/.ambient_gitlab_token` |
| `github` | `GITHUB_TOKEN` | `/tmp/.ambient_github_token` |

### Additional Environment Variable Injected by CP

| Var | Value | Purpose |
|-----|-------|---------|
| `CREDENTIAL_IDS` | JSON map `{provider: id}` | Resolved credential IDs for this session; runner uses to call `/credentials/{id}/token` |

Status: ✅ implemented — Credential Kind live (PR #1110); CP integration pending (Wave 5)

---

## Sandbox Snapshot Collection

The CP persists sandbox logs and policy to the API server's sessions table so they survive sandbox shutdown. This enables the UI to display historical sandbox data for stopped sessions, matching the pattern used for chat message history.

### Policy Extraction (every 15s — zero additional cost)

`PodStatusSyncer.syncSandboxStatus()` already calls `GetSandbox` on each 15s sync cycle. Policy is extracted from the existing response using exported helpers in `internal/openshell/sandbox_helpers.go`:

- `SandboxPhaseString(phase)` — converts proto phase enum to human-readable string
- `PolicyToMap(policy)` — converts proto policy to a JSON-serializable map

The policy envelope is JSON-marshaled and included in the `UpdateStatus` patch as `sandbox_policy_snapshot`. No additional network calls.

### Log Fetch (every 15s)

After policy extraction, the CP calls `GatewayClient.FetchSandboxLogs()` — a method that wraps `WatchSandbox` with `FollowLogs: false, LogTailLines: openshell.LogTailLines` (500). This returns a bounded snapshot of the most recent log entries as a JSON array matching the SSE log format. The result is included in the same `UpdateStatus` patch as `sandbox_logs_snapshot`.

The tail line count is defined as the exported constant `openshell.LogTailLines` to keep it consistent across the periodic syncer and pre-delete final snapshot.

### Pre-Delete Final Snapshot

In `deprovisionSessionSandbox()`, a final snapshot of both logs and policy is taken **before** `DeleteSandbox` is called. This guarantees the stored data matches the live SSE stream for normal stop flows:

```
deprovisionSessionSandbox():
    1. Resolve gateway namespace
    2. Compute sandbox name
    3. GetSandbox → extract policy snapshot     ← NEW
    4. FetchSandboxLogs → extract log snapshot   ← NEW
    5. UpdateStatus with both snapshots          ← NEW
    6. DeleteSandbox                             (existing)
    7. UpdateSessionPhase                        (existing)
```

For abnormal termination (sandbox crash without `deprovisionSessionSandbox`), the most recent periodic snapshot (at most 15s stale) serves as fallback.

### Error Handling

Snapshot errors (gateway unreachable, gRPC timeout, policy marshal failure) are logged at WARN/DEBUG level and never block the status sync or sandbox deletion. The periodic 15s snapshots provide redundancy — a failed final snapshot still has the recent periodic data as fallback.

`FetchSandboxLogs` returns both partial data AND the error when the stream fails mid-read. Callers log the error and persist whatever entries were collected, so partial snapshots are never silently dropped. When the stream errors before any entries are received, only the error is returned.

### Shared Helpers

`internal/openshell/sandbox_helpers.go` exports shared functions used by both the token server and the reconciler:

- `SandboxPhaseString(phase)` — converts proto phase enum to human-readable string
- `PolicyToMap(policy)` — converts proto policy to a JSON-serializable map
- `BuildSnapshotPatch(sbx)` — builds the complete `UpdateStatus` patch map from a `*pb.Sandbox`, including the policy envelope with version, hash, status, source, config_revision, and policy fields. Returns `(patch, error)`. Both `snapshotSandboxData` (periodic sync) and `finalSandboxSnapshot` (pre-delete) call this shared helper to keep the envelope structure and field names in one place.
- `LogTailLines` — exported constant (`500`) for the log tail line count

Both `tokenserver` and `reconciler` import `openshell`, so no import cycles are introduced.

Status: ✅ implemented

---

## Namespace Deletion RBAC Gap

The CP's `cleanupSession` calls `kube.DeleteNamespace()`. This currently fails in kind with:

```
namespaces "bond" is forbidden: User "system:serviceaccount:ambient-code:ambient-control-plane" cannot delete resource "namespaces" in API group "" in the namespace "bond"
```

The `ambient-control-plane` ServiceAccount does not have `delete` on `namespaces` at cluster scope. The namespace is left behind after session cleanup.

**Proposed fix:** Add a ClusterRole with `delete` on `namespaces` and bind it to `ambient-control-plane` SA in the deployment manifests.

---

## Design Decisions

| Decision | Rationale |
|---|---|
| CP provisions Pods, not Jobs | Sessions are single-run; operator-style Job retry semantics don't apply |
| CP assembles INITIAL_PROMPT, not api-server | CP has K8s access and can read the full start context; api-server does not know which pod to address |
| gRPC listener started eagerly, not lazily | Prevents chicken-and-egg: listener must be subscribed before INITIAL_PROMPT push |
| Runner self-pushes INITIAL_PROMPT via gRPC | Avoids HTTP call to old backend; ensures message is durable before Claude runs |
| `WatchSessionMessages` as the inbound trigger | User messages arrive once (persisted in DB); listener replays from last_seq on reconnect |
| `MESSAGES_SNAPSHOT` as the assistant accumulator | Claude Agent SDK emits periodic full snapshots; last snapshot before RUN_FINISHED is the complete turn |
| SSE tap via `_active_streams` dict | Zero-copy fan-out from listener loop to any subscribed HTTP client; no additional gRPC round-trip |
| assistant payload → plain string | Symmetric with user payload; reasoning is observability data not conversation record |
| GET /events is runner-local | Runner has the event queue; api-server proxies it; no second fan-out layer needed |
| Namespace per project, not per session | Sessions within a project share a namespace; secrets and RBAC are project-scoped |
| CP token endpoint over Secret-write renewal | Secret writes are async push with no synchronization guarantee vs. token TTL; synchronous pull from CP eliminates the race entirely |
| Runner SA token for CP auth | K8s SA tokens are already mounted in every pod, long-lived, and K8s-managed — no new secrets or out-of-band key distribution required |
| CP is sole token source — no BOT_TOKEN Secret | CP creates the runner pod, so it is always reachable before the runner's first token request; retaining a Secret adds complexity and a second failure mode with the same blast radius |
| `system:image-builder` bound to session SA at provision time | Agents need push access to the internal image registry to build and distribute images; OpenShift grants pull automatically via `system:image-pullers` at namespace init but push requires an explicit RoleBinding; co-locating it with the other session SA grants keeps all RBAC provisioning in one place |
| 15-second grace period for sandbox `ERROR` during creation | Sandbox provisioning can hit transient errors that resolve on their own. Immediately failing the session on first `SANDBOX_PHASE_ERROR` causes unnecessary session failures. Both the provisioning poller and the status syncer enforce the same grace period to prevent one from short-circuiting the other |
| Sandbox snapshots in PostgreSQL, not a log store | Snapshots are bounded (500 lines), session-scoped, and low-frequency (15s writes). PostgreSQL handles this without a new dependency. A dedicated log store would be appropriate for unbounded historical search, not for session-scoped snapshots |
| Pre-delete final snapshot before `DeleteSandbox` | Periodic 15s snapshots provide good coverage, but the final state is most valuable for post-mortem. Fetching before delete guarantees stored data matches the live stream |
| Snapshot errors logged, partial data preserved | Snapshot collection must never block status sync or sandbox deletion — it is best-effort. `FetchSandboxLogs` returns partial data with the error so callers can persist whatever was collected. Periodic snapshots provide redundancy for failed final snapshots |
| Gateway as API resource, not ConfigMap | Gateway configuration lives in PostgreSQL as `kind: Gateway`, applied via `acpctl apply -k`. Eliminates the ConfigMap watcher, `initGatewayProvisioning()`, and the `internal/gateway/config.go` code path. The GatewayReconciler receives events via the same gRPC watch stream as all other resources — unified, testable, composable via kustomize |
| ProjectReconciler owns namespace lifecycle | Project = Namespace. The ProjectReconciler creates namespaces; the GatewayReconciler deploys gateways into existing namespaces. No ConfigMap needed to declare which namespaces exist |
| Shared kustomize library | The rendering engine from `acpctl apply` is extracted into a shared library consumed by both the CLI and the ApplicationReconciler, enabling unit testing without a running cluster |

---
