# Runner

**Date:** 2026-04-05
**Last Updated:** 2026-07-13
**Status:** Living Document — current state documented, desired state (OpenShell) appended
**Related:** `control-plane.spec.md` — CP provisioning, token endpoint, start context assembly

---

## Overview

The Ambient Runner is a Python FastAPI application that runs inside each session pod. It is the execution engine for one session: it owns the Claude Code subprocess lifecycle, bridges between the AG-UI HTTP protocol and the gRPC message store, streams results in real time, and exposes a local SSE tap for live event observation.

One runner pod runs per session. The pod is ephemeral — created by the CP when a session starts, deleted when the session ends.

```
CP creates runner pod
    │  env vars (SESSION_ID, INITIAL_PROMPT, AMBIENT_GRPC_URL, ...)
    ▼
Runner Pod (FastAPI + uvicorn)
    │
    ├── gRPC listener ←── WatchSessionMessages (api-server)
    │        │
    │        └──► bridge.run() ──► Claude Code subprocess
    │                    │
    │                    ├──► PushSessionMessage (api-server)       ← durable record
    │                    └──► _active_streams[thread_id] queue      ← SSE tap
    │
    └── HTTP endpoints
          ├── GET /events/{thread_id}      ← live SSE tap (drained by backend proxy)
          ├── POST /                       ← AG-UI run (HTTP path, backup)
          ├── POST /model                  ← runtime LLM model switch
          ├── POST /interrupt
          └── GET /health
```

---

## What the Runner Is

The runner is a **bridge**. It translates between three different message-passing systems:

| System | Protocol | Direction | Purpose |
|--------|----------|-----------|---------|
| api-server gRPC | `WatchSessionMessages` | inbound | User messages that trigger Claude turns |
| Claude Agent SDK | subprocess stdin/stdout | bidirectional | Drives Claude Code execution |
| api-server gRPC | `PushSessionMessage` | outbound | Durable conversation record (assistant turns) |
| SSE tap | `GET /events/{thread_id}` | outbound | Live event stream for the frontend and CLI |

The runner has no database. All persistent state (session messages, session phase) lives in the api-server.

---

## Source Layout

```
ambient_runner/
  app.py                          ← FastAPI application factory + lifespan
  bridge.py                       ← PlatformBridge ABC (integration contract)
  _grpc_client.py                 ← AmbientGRPCClient (RSA-OAEP auth, channel build)
  _session_messages_api.py        ← SessionMessagesAPI (hand-rolled proto codec)
  _inbox_messages_api.py          ← InboxMessagesAPI
  observability.py                ← ObservabilityManager (Langfuse)
  observability_config.py         ← Observability configuration
  observability_models.py         ← Langfuse event model types
  observability_privacy.py        ← Privacy-aware observability filtering
  mlflow_observability.py         ← MLflow observability integration

  platform/
    context.py                    ← RunnerContext dataclass (shared runtime state)
    config.py                     ← Config loaders (.ambient/ambient.json, payload .mcp.json, REPOS_JSON)
    auth.py                       ← Credential fetching + git identity + env population
    workspace.py                  ← Working directory resolution (workflow / multi-repo / default)
    prompts.py                    ← System prompt constants + workspace context builder
    utils.py                      ← Pure helpers (redact_secrets, get_bot_token, url_with_token)
    security_utils.py             ← Input validation helpers
    feedback.py                   ← User feedback storage

  bridges/claude/
    bridge.py                     ← ClaudeBridge (PlatformBridge impl)
    session.py                    ← SessionManager + SessionWorker (Claude subprocess isolation)
    grpc_transport.py             ← GRPCSessionListener + GRPCMessageWriter
    auth.py                       ← Vertex AI setup + model resolution
    mcp.py                        ← MCP server assembly
    tools.py                      ← In-process MCP tools (refresh_credentials, evaluate_rubric)
    backend_tools.py              ← acp_* MCP tools (backend API access for Claude)
    prompts.py                    ← SDK system prompt builder
    corrections.py                ← Correction detection and logging
    operational_events.py         ← Operational event emission (session lifecycle, errors)
    mock_client.py                ← Local dev mock (no Claude subprocess)
    fixtures/                     ← JSONL fixtures for local dev mock

  bridges/gemini_cli/             ← Gemini CLI bridge (separate impl, same ABC)
  bridges/langgraph/              ← LangGraph bridge (stub)

  # Baked-in config files (copied into runner image at build time)
  claude.json                     ← Claude Code onboarding state + trusted folders
  claude-settings.json            ← Tool permissions (allow/deny lists) for standard mode
  claude-settings-local.json      ← Tool permissions for local dev mode
  mcp.json                        ← Baked-in MCP servers (e.g. mcp-atlassian with env var refs)

  endpoints/
    run.py                        ← POST / (AG-UI run endpoint)
    events.py                     ← GET /events/{thread_id} (SSE tap)
    interrupt.py                  ← POST /interrupt
    health.py                     ← GET /health
    capabilities.py               ← GET /capabilities
    repos.py                      ← GET /repos
    workflow.py                   ← GET /workflow
    mcp_status.py                 ← GET /mcp-status
    content.py                    ← GET /content
    tasks.py                      ← GET /tasks
    feedback.py                   ← POST /feedback
    model.py                      ← POST /model (runtime LLM model switch)

  middleware/
    grpc_push.py                  ← grpc_push_middleware (HTTP-path event fan-out)
    developer_events.py           ← Dev-mode event logging
    secret_redaction.py           ← Token scrubbing from event payloads
    tracing.py                    ← Langfuse span injection

  tools/
    backend_api.py                ← BackendAPIClient (sync HTTP client for api-server REST)
```

---

## Startup Sequence

```
1. main.py calls run_ambient_app(bridge)
2. uvicorn starts; FastAPI lifespan() runs:

3. RunnerContext created from env vars:
     SESSION_ID, WORKSPACE_PATH, BACKEND_API_URL, ...

4. bridge.set_context(context)

5. If AMBIENT_GRPC_ENABLED=true:
     a. AmbientGRPCClient.from_env() called:
          - AMBIENT_CP_TOKEN_URL set → fetch token from CP /token
            (RSA-OAEP: encrypt SESSION_ID with public key, send as Bearer)
          - set_bot_token(token) — wires into get_bot_token() for all HTTP calls
          - Build gRPC channel with token
     b. GRPCSessionListener.start() → WatchSessionMessages RPC opens
          - If RESUME_AFTER_SEQ set: listener initializes last_seq from env var,
            skipping all historical messages (seq <= RESUME_AFTER_SEQ)
     c. await listener.ready.wait()  ← blocks until stream confirmed open
     d. Pre-register SSE queue for SESSION_ID (prevents race with backend)

6. If not IS_RESUME, read initial prompt:
     a. Try /tmp/initial_prompt.txt (gateway file upload path); on any OS-level read error (permissions, I/O), log a warning and fall back
     b. Fall back to INITIAL_PROMPT env var (operator Job path)
   If prompt found:
     _auto_execute_initial_prompt(prompt, session_id, grpc_url)
       In gRPC mode: push via PushSessionMessage("user", prompt)
         → listener receives its own push → triggers bridge.run()
       In HTTP mode: POST to backend /agui/run with exponential backoff

7. yield (app ready, uvicorn serving on AGUI_HOST:AGUI_PORT)

8. On shutdown: bridge.shutdown() → GRPCSessionListener.stop()
```

### First-Run Platform Setup (deferred, on first `bridge.run()` call)

```
bridge._setup_platform():
  1. validate_prerequisites(context)         ← phase-based slash command gating
  2. setup_sdk_authentication(context)       ← Vertex AI or Anthropic API key
  3. populate_runtime_credentials(context)   ← GitHub, GitLab, Google, Jira from backend
  4. resolve_workspace_paths(context)        ← CWD: workflow / multi-repo / artifacts
  5. setup_workspace(context)                ← log workspace state
  6. ObservabilityManager init               ← Langfuse (best-effort, no-op on failure)
  6a. MLflow autologging activation           ← if MLFLOW_TRACKING_URI is set and MLFLOW_TRACING_ENABLED is not false:
                                                 mlflow.set_tracking_uri(), mlflow.set_experiment(), mlflow.autolog(...),
                                                 and configured GenAI autolog integrations
                                                 Best-effort: log warning on failure, continue the session
  7. build_mcp_servers(context, cwd_path)    ← external + platform MCP servers
  8. build_sdk_system_prompt(...)            ← preset + workspace context string
```

---

## Token Authentication

The runner has two token identities:

| Token | Source | Used for |
|-------|--------|----------|
| **CP OIDC token** | `GET AMBIENT_CP_TOKEN_URL/token` (RSA-OAEP auth) | gRPC channel to api-server; all `PushSessionMessage` calls |
| **Caller token** | `x-caller-token` header on each run request | Backend HTTP credential fetches (`GET /credentials/{id}/token`) — scoped to the requesting user |

### CP Token Flow

```python
## _grpc_client.py
bearer = _encrypt_session_id(public_key_pem, session_id)   # RSA-OAEP
token  = _fetch_token_from_cp(cp_token_url, bearer)         # HTTP GET
set_bot_token(token)                                         # cache in utils.py
```

`_fetch_token_from_cp` retries up to 30 attempts with a fixed 2-second delay
between attempts. This accommodates slow-starting control plane pods in large
clusters where the CP HTTP server may not be listening when the runner first
boots. Each failed attempt is logged at WARNING with the attempt number and
error.

`get_bot_token()` priority (platform/utils.py):
1. CP-fetched token cache (`_cp_fetched_token`)
2. File mount `/var/run/secrets/ambient/bot-token` (kubelet-rotated)
3. `BOT_TOKEN` env var (local dev fallback)

On gRPC `UNAUTHENTICATED`, the listener calls `grpc_client.reconnect()` which re-fetches from the CP endpoint and rebuilds the channel.

### AGUI_TOKEN Session Authentication

When the `AGUI_TOKEN` env var is set (injected by the Operator), the runner registers an HTTP middleware that requires all non-health requests to include an `X-Ambient-Session-Token` header matching the token. Comparison uses `secrets.compare_digest()` to prevent timing attacks.

This prevents cross-session attacks where an attacker who discovers a runner's in-cluster URL could send requests to another session's runner. Health endpoints (`/health`, `/healthz`) are exempted so liveness/readiness probes continue to work.

---

## Bridge Layer

`PlatformBridge` (bridge.py) defines the integration contract:

| Method | Required | Purpose |
|--------|----------|---------|
| `capabilities()` | yes | Declare feature support to `/capabilities` endpoint |
| `run(input_data)` | yes | Async generator — execute one turn, yield AG-UI events |
| `interrupt(thread_id)` | yes | Halt the active run for a thread |
| `set_context(ctx)` | no | Receive `RunnerContext` before first run |
| `_setup_platform()` | no | Deferred first-run initialization |
| `shutdown()` | no | Graceful teardown |
| `mark_dirty()` | no | Force full re-setup on next run |
| `inject_message(msg)` | no | gRPC path — listener injects parsed `RunnerInput` |

`ClaudeBridge` is the production implementation. `GeminiCLIBridge` and `LangGraphBridge` exist as alternate bridge implementations using the same ABC.

---

## Claude Bridge Internals

### Session Isolation

Each `thread_id` (= session ID) gets one `SessionWorker`. The worker owns a single `ClaudeSDKClient` in a background `asyncio.Task` with a long-running stdin/stdout connection to the Claude Code subprocess.

```
SessionManager
  └── SessionWorker(thread_id)
        ├── _client: ClaudeSDKClient  ← Claude subprocess connection
        ├── _active_output_queue      ← yields events during a turn
        └── _between_run_queue        ← background messages between turns
```

`SessionWorker.query(prompt, session_id)` enqueues the request and yields SDK messages until the `None` sentinel. Worker death is detected on the next `query()` call — dead workers are replaced automatically.

`SessionManager` persists `thread_id → sdk_session_id` to `{state_dir}/claude_session_ids.json` on every new session. This enables `--resume` on pod restart.

### Requirement: Claude CLI Connect Retry

The `SessionWorker._run()` method SHALL retry `client.connect()` with exponential
backoff when the initial connection to the Claude CLI subprocess fails. Transient
failures (binary not ready, OpenShell supervisor file lock, temp directory race)
are common in sandbox environments and MUST NOT cause a permanent worker death.

| Parameter | Default | Env Var Override |
|-----------|---------|-----------------|
| Max attempts | 3 | `CLAUDE_CONNECT_MAX_RETRIES` |
| Initial delay | 2 seconds | `CLAUDE_CONNECT_RETRY_DELAY` |
| Backoff factor | 2x (exponential) | — |

On each failed attempt, the worker SHALL:
1. Log at WARNING with the attempt number, delay, exception type, and message
2. Disconnect and discard the failed client instance
3. Sleep for the backoff delay
4. Create a fresh `ClaudeSDKClient` and retry `connect()`

On final failure (all attempts exhausted), the worker SHALL log at ERROR and
store the exception for immediate caller notification (see below).

#### Requirement: Connect Readiness Signal

`SessionWorker` SHALL expose a connect-readiness mechanism so callers detect
startup failure immediately instead of hanging on `worker.query()`:

- An `asyncio.Event` (`_connect_ready`) is set after successful `connect()`.
- If all connect retries fail, the exception is stored in `_connect_error` and
  the event is set (signaling failure).
- `wait_for_connect(timeout)` awaits the event and raises `_connect_error` if set.
- `SessionManager.get_or_create()` SHALL call `await worker.wait_for_connect(timeout=60)`
  after `worker.start()`. If it fails, the manager destroys the worker and raises
  so the caller receives an immediate error rather than a hung stream.

#### Scenario: Transient connect failure recovers

- GIVEN the Claude CLI subprocess fails on the first `connect()` call (e.g. sandbox file lock)
- AND the second `connect()` call succeeds
- WHEN `SessionManager.get_or_create()` is called
- THEN the worker connects successfully after one retry
- AND `wait_for_connect()` returns without error
- AND subsequent `worker.query()` calls succeed

#### Scenario: All connect retries exhausted

- GIVEN the Claude CLI subprocess fails on all 3 `connect()` attempts
- WHEN `SessionManager.get_or_create()` calls `wait_for_connect()`
- THEN `wait_for_connect()` raises the last connection exception
- AND the worker is destroyed
- AND the caller receives a `RunErrorEvent` (not a hung stream)

### Per-Turn Lifecycle

```
bridge.run(input_data):
  1. _initialize_run(): set user context, refresh credentials if stale
  2. session_manager.get_or_create_worker(thread_id)
  3. worker.acquire_lock()                            ← prevent concurrent turns
  4. worker.query(prompt, session_id)
  5. wrap stream: tracing_middleware → secret_redaction_middleware
  6. yield events
  7. Detect HITL halt: _halted_by_thread[thread_id] = True → interrupt worker
```

Credentials are populated before step 1. They persist across turns within the same pod lifetime — credential isolation is enforced by sidecar containers, not by per-turn cleanup.

### Adapter Rebuild (`mark_dirty()`)

`mark_dirty()` is called when the MCP configuration changes (e.g. different user context). It:
1. Snapshots all `thread_id → sdk_session_id` mappings
2. Tears down the existing `SessionManager` (async, non-blocking)
3. Clears `_adapter` and `_ready` → next `run()` triggers full `_setup_platform()`
4. Restores saved session IDs after rebuild so `--resume` still works

---

## gRPC Transport Layer

### `GRPCSessionListener` (pod-lifetime)

```
WatchSessionMessages(session_id, last_seq)
    │
    │  [thread pool — blocking gRPC iterator]
    │
    ▼
  asyncio bridge (run_coroutine_threadsafe)
    │
    │  event_type == "user"
    ├──► parse RunnerInput → bridge.run()
    │         │
    │         ├──► _active_streams[thread_id].put_nowait(event)   ← SSE tap
    │         └──► GRPCMessageWriter.consume(event)               ← durable record
    │
    │  other event_type
    └──► log and skip
```

- Sets `self.ready` asyncio.Event once the stream is confirmed open
- Reconnects with exponential backoff (1s → 30s) on stream failure
- On `UNAUTHENTICATED`: calls `grpc_client.reconnect()` before retry
- Tracks `last_seq` to resume without replay
- On session restart: reads `RESUME_AFTER_SEQ` env var and initializes `last_seq` to that value, causing `WatchSessionMessages` to skip all messages with `seq <= RESUME_AFTER_SEQ`. This prevents replay of historical user messages that would trigger duplicate Claude turns.

### `GRPCMessageWriter` (per-turn)

Accumulates `MESSAGES_SNAPSHOT` events (keeping only the latest — each snapshot is a full replacement). On `RUN_FINISHED` or `RUN_ERROR`, calls:

```python
PushSessionMessage(
    session_id=session_id,
    event_type="assistant",
    payload=assistant_text,   # extracted from last MESSAGES_SNAPSHOT
)
```

Push is synchronous gRPC; runs in a `ThreadPoolExecutor` to avoid blocking the event loop.

**Payload contract:**
- `event_type=user`: plain string (the user's message text)
- `event_type=assistant`: plain string (Claude's reply text only — no reasoning, no user echo)

---

## SSE Tap: `GET /events/{thread_id}`

The SSE tap endpoint in `endpoints/events.py` is a pure observer. It never calls `bridge.run()`.

```
Sequence:
  1. Backend registers GET /events/{thread_id} (before POST /sessions/{id}/messages)
  2. endpoints/events.py registers asyncio.Queue in bridge._active_streams[thread_id]
  3. User POST /sessions/{id}/messages → PushSessionMessage("user", text)
  4. GRPCSessionListener receives its own push → bridge.run()
  5. bridge.run() yields events → put_nowait into _active_streams[thread_id]
  6. GET /events stream reads from queue → SSE to client
  7. On RUN_FINISHED or RUN_ERROR: close stream
```

- Queue size: 100 (events dropped silently if consumer is slow)
- Heartbeat: `: keepalive` comment every 30s
- `MESSAGES_SNAPSHOT` events are filtered out (internal accumulator state, not for clients)
- Queue is removed from `_active_streams` on client disconnect or run end

---

## Credential Management

Integration credentials are **isolated in sidecar containers**. The runner container
has no integration tokens in its environment or filesystem. Each credential-bearing
MCP sidecar holds only its own credentials and exposes tools via SSE on a localhost
port.

LLM provider credentials (Anthropic API key, Vertex AI service account) remain in
the runner container — they are necessary for inference.

### Sidecar Credential Flow

```
CP resolves CREDENTIAL_IDS for the Project
  → For each bound credential:
      CP adds a sidecar container to the pod spec
      Sidecar environment contains only its own credential
      Sidecar exposes MCP tools on localhost:{port}/sse
  → Runner connects to sidecars as SSE MCP clients
  → Agent calls MCP tools — never sees raw tokens
```

Credential sidecars manage their own token refresh cycles. The `refresh_credentials`
MCP tool (registered under the `session` MCP server) signals sidecars to re-fetch
tokens from the backend API. Rate-limited to once per 30 seconds.

The credential-free fallback: Projects with no bound credentials get no credential
sidecars. The runner operates without integration credentials.

### Git Operations

The runner container has no git credential helper and no GitHub/GitLab tokens.
Git write operations use MCP tools exclusively:

- **Push commits**: `github-mcp` → `PushFiles` tool (commits and pushes via GitHub API)
- **Create PRs**: `github-mcp` → `CreatePullRequest` tool
- **Clone repos**: Init container (runs before the agent, credential-isolated)

Direct `git push` and `gh pr create` from the runner container are not supported
— they require tokens in the runner environment, which violates the isolation
model. System prompts instruct the agent to use MCP tools for all git write
operations. See the [MCP server spec](#mcp-server) for
sidecar details.

---

## MCP Servers

The runner assembles the full MCP server configuration at setup time. Claude sees these servers as tools:

| Server | Transport | Tools | Source |
|--------|-----------|-------|--------|
| External (`.mcp.json`) | stdio / SSE | whatever the server exposes | user config |
| `ambient` | SSE (`AMBIENT_MCP_URL`) | 16 platform tools (sessions, agents, projects) | CP-injected sidecar |
| `github-mcp` | SSE (`:8091`) | GitHub API tools (repos, issues, PRs, actions) | CP-injected sidecar, only if `github` credential bound |
| `jira-mcp` | SSE (`:8092`) | Jira API tools (issues, search, transitions) | CP-injected sidecar, only if `jira` credential bound |
| `k8s-mcp` | SSE (`:8093`) | Kubernetes tools (kubectl via MCP) | CP-injected sidecar, only if `kubeconfig` credential bound |
| `google-mcp` | SSE (`:8094`) | Google Workspace tools (Gmail, Drive) | CP-injected sidecar, only if `google` credential bound |
| `session` | in-process | `refresh_credentials` | always registered |
| `rubric` | in-process | `evaluate_rubric` | registered if `.ambient/rubric.md` found |
| `corrections` | in-process | `log_correction` | always registered |

### Migration: `acp` In-Process MCP Server Removed

The previous `acp` in-process MCP server (9 tools: `acp_list_sessions`,
`acp_get_session`, `acp_create_session`, `acp_stop_session`, `acp_send_message`,
`acp_get_session_status`, `acp_restart_session`, `acp_list_workflows`,
`acp_get_api_reference`) is replaced by the `ambient` SSE sidecar on `:8090`.

The `ambient-mcp` sidecar exposes the same platform tools (sessions, agents,
projects) via the MCP protocol over SSE. Tool names change from `acp_*` prefix
to unprefixed (`list_sessions`, `get_session`, etc.). Existing agent prompts
referencing `acp_*` tool names must be updated.

---

## System Prompt Construction

The system prompt is assembled once during `_setup_platform()` and passed to the Claude SDK:

```python
{
  "type": "preset",
  "preset": "claude_code",
  "append": f"{DEFAULT_AGENT_PREAMBLE}\n\n{workspace_context}"
}
```

`DEFAULT_AGENT_PREAMBLE` establishes Ambient platform identity and behavioral guidelines.

`workspace_context` is built by `build_workspace_context_prompt()` and includes:
- Fixed workspace paths (`/workspace/artifacts`, `/workspace/file-uploads`)
- Active workflow CWD and name
- List of uploaded files
- Repository list with URLs and branches
- Git push instructions (for auto-push repos)
- HITL interrupt instructions
- MCP integration-specific instructions (Google, Jira, GitLab, GitHub)
- Token presence hints
- Workflow-specific system prompt (from `ambient.json` `systemPrompt` field)
- Rubric evaluation section (if `rubric.md` found)
- Corrections feedback instructions

---

## Environment Variables

All env vars are injected by the CP at pod creation time.

| Var | Purpose |
|-----|---------|
| `SESSION_ID` | Primary session identifier; also the `thread_id` for AG-UI |
| `PROJECT_NAME` | Project context |
| `WORKSPACE_PATH` | Claude Code working directory root (`/workspace`) |
| `AGUI_HOST` / `AGUI_PORT` | Runner HTTP listener (default `0.0.0.0:8001`) |
| `BACKEND_API_URL` | api-server base URL (cluster-local) |
| `AMBIENT_GRPC_URL` | api-server gRPC address |
| `AMBIENT_GRPC_USE_TLS` | TLS flag for gRPC channel |
| `AMBIENT_CP_TOKEN_URL` | CP token endpoint (e.g. `http://ambient-control-plane.{ns}.svc:8080/token`) |
| `AMBIENT_CP_TOKEN_PUBLIC_KEY` | RSA public key PEM for CP token auth |
| `AMBIENT_GRPC_ENABLED` | Enables gRPC listener path (default: `true` when `AMBIENT_GRPC_URL` set) |
| `INITIAL_PROMPT` | Auto-execute prompt on startup |
| `IS_RESUME` | Set to `"true"` on pod restart (session previously started); skips `INITIAL_PROMPT` auto-execute |
| `RESUME_AFTER_SEQ` | Maximum message `seq` from the previous run; gRPC listener starts watching from this seq to skip historical messages |
| `USE_VERTEX` | Enable Vertex AI (vs Anthropic API) |
| `ANTHROPIC_VERTEX_PROJECT_ID` / `CLOUD_ML_REGION` | Vertex AI config |
| `GOOGLE_APPLICATION_CREDENTIALS` | Vertex service account path |
| `LLM_MODEL` / `LLM_TEMPERATURE` / `LLM_MAX_TOKENS` | Per-session model config |
| `LLM_MODEL_VERTEX_ID` | Explicit Vertex model ID (overrides static map) |
| `CREDENTIAL_IDS` | JSON map `{provider: id}` — resolved credential IDs for this session |
| `AMBIENT_MCP_URL` | Ambient MCP sidecar URL (SSE transport) |
| `REPOS_JSON` | JSON array of `{url, branch, autoPush}` repo configs |
| `ACTIVE_WORKFLOW_GIT_URL` | Active workflow repo URL (overrides REPOS_JSON workspace setup) |
| `SESSION_CONFIG_PATH` | Existing absolute path to a mounted session-config harness repo; appended to Claude SDK `add_dirs` and enables SDK skills |
| `AGUI_TOKEN` | Session-scoped bearer token; when set, all non-health endpoints require `X-Ambient-Session-Token` header (constant-time comparison) |
| `PAYLOAD_MCP_CONFIG_FILE` | Path to payload `.mcp.json` (default `/sandbox/.mcp.json`); merged on top of baked-in MCP config |
| `SDK_OPTIONS` | JSON string of additional Claude SDK options |
| `CLAUDE_CONNECT_MAX_RETRIES` | Max `client.connect()` attempts before giving up (default: `3`) |
| `CLAUDE_CONNECT_RETRY_DELAY` | Initial backoff delay in seconds for connect retries (default: `2`) |
| `MLFLOW_TRACKING_URI` | MLflow tracking server URL (HTTPS); platform-owned global default from control-plane env |
| `MLFLOW_TRACKING_TOKEN` | MLflow tracking server auth token (secret — must not appear in logs); injected via `mlflow` credential provider |
| `MLFLOW_EXPERIMENT_NAME` | MLflow experiment name for trace logging; global default from control-plane env, overridable per-agent |
| `MLFLOW_CREDENTIAL_SECRET_NAME` | Control-plane-only source secret name for the global MLflow credential; defaults to `mlflow` |
| `MLFLOW_CREDENTIAL_SECRET_NAMESPACE` | Control-plane-only source namespace for the global MLflow credential; defaults to the control-plane runtime namespace |
| `MLFLOW_TRACING_ENABLED` | Optional kill switch; only `false` / `0` / `no` / `off` disables MLflow when a tracking URI is present |
| `MLFLOW_AUTOLOG_EXCLUDE_FLAVORS` | Optional comma-separated generic MLflow autolog flavor exclusions |
| `MLFLOW_GENAI_AUTOLOG_INTEGRATIONS` | Optional comma-separated provider autolog integrations; default `anthropic,openai` |

---

## Two Message Paths

| Path | Trigger | Fan-out | Persistence |
|------|---------|---------|-------------|
| **gRPC listener** | `WatchSessionMessages` stream receives `event_type=user` | SSE tap queue + `GRPCMessageWriter` | Assistant turn pushed to api-server DB |
| **HTTP POST `/`** | Direct HTTP AG-UI run request | `grpc_push_middleware` fire-and-forget | Each event pushed individually |

The gRPC listener path is the primary path in standard deployment. The HTTP POST path is the backup path and is used in local dev environments without a CP.

---

## Workspace Resolution

`resolve_workspace_paths(context)` determines the Claude working directory:

```
Priority order:
1. ACTIVE_WORKFLOW_GIT_URL set  →  /workspace/workflows/<name>
                                    add_dirs: all repos, artifacts, file-uploads
2. REPOS_JSON set               →  /workspace/<primary_repo>
                                    add_dirs: remaining repos
3. Default                      →  /workspace/artifacts
```

The resolved `(cwd_path, add_dirs)` tuple is passed to the Claude SDK via `ClaudeAgentAdapter`. Claude Code sees `cwd_path` as its working directory and `add_dirs` as additional indexed directories.

If `SESSION_CONFIG_PATH` is set to an existing absolute directory, the runner
SHALL append it to `add_dirs` without replacing `cwd_path`. This supports
Git-backed session-config harness repositories mounted by sandbox payloads:

```yaml
payloads:
  - sandbox_path: /sandbox/session-config
    repo_url: https://github.com/example/team-session-config
    ref: main
environment:
  SESSION_CONFIG_PATH: /sandbox/session-config
```

For Claude sessions, the bridge SHALL also enable SDK skills when
`SESSION_CONFIG_PATH` resolves successfully so skills in the mounted harness can
be discovered and activated by semantic prompt intent.

---

## Logging

### Requirement: Persistent File Logging

The runner SHALL write logs to `/sandbox/.runner/logs/runner.log` in addition to
stdout/stderr. This enables post-mortem debugging via `kubectl exec` when container
stdout has been rotated or truncated by the container runtime.

**Configuration:**

| Parameter | Value |
|-----------|-------|
| Log path | `/sandbox/.runner/logs/runner.log` |
| Handler type | `RotatingFileHandler` |
| Max file size | 50 MB |
| Backup count | 3 (total ~200 MB max disk) |
| Format | Same as stdout handler (`%(levelname)s:%(name)s:%(message)s`) |
| Failure mode | Graceful degradation — if `/sandbox/.runner/logs` cannot be created or written to, log a warning and continue with stdout-only logging |

The file handler SHALL be added to the root logger alongside the existing
`StreamHandler` (tee pattern — both stdout and file receive all log output).

The log directory is created at runtime via `os.makedirs(exist_ok=True)`. No
Dockerfile changes are required — `/sandbox` is already writable in both the
standard and OpenShell runner images.

#### Scenario: Logs written to file and stdout

- GIVEN the runner starts in a container with `/sandbox/.runner/logs` writable
- WHEN the runner logs a message
- THEN the message appears in both stdout (visible via `kubectl logs`) AND `/sandbox/.runner/logs/runner.log`

#### Scenario: Log directory not writable

- GIVEN `/sandbox/.runner/logs` does not exist or is not writable (e.g. read-only rootfs)
- WHEN the runner starts
- THEN the runner logs a warning about file logging being unavailable
- AND continues operating with stdout-only logging
- AND no crash or startup failure occurs

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Bridge ABC over direct Claude dependency | Enables Gemini CLI, LangGraph, and future bridges without changing app or platform layer |
| `SessionWorker` isolates Claude subprocess | Claude SDK uses anyio internally — running it in a background asyncio.Task with queue-based API prevents anyio/asyncio event loop conflicts |
| `_setup_platform()` deferred to first run | App startup must be fast; credential fetching, MCP server loading, and system prompt construction are I/O-heavy and done once per pod lifetime |
| Credentials isolated in sidecar containers | Prevents token exfiltration by the agent via Bash/Read tools; each sidecar holds only its own credential |
| RSA-OAEP for CP token auth | CP SA cannot create `tokenreviews` at cluster scope (tenant RBAC restriction); asymmetric encryption with a self-generated keypair (persisted in S0 Secret) requires no cluster-scoped permissions |
| `set_bot_token()` module-level cache | CP-fetched OIDC token must be available to `get_bot_token()` for all HTTP API calls (credential fetches, backend tools); gRPC token and HTTP token are the same identity |
| `GRPCMessageWriter` stores only last `MESSAGES_SNAPSHOT` | Each snapshot is a complete replacement; accumulating all would waste memory for long turns |
| Assistant payload = plain string | Symmetric with user payload; reasoning content is observability data not durable conversation record; payload size reduction is dramatic (reasoning can be 10x longer than reply) |
| SSE queue pre-registered before `INITIAL_PROMPT` push | Backend opens `GET /events/{thread_id}` before `PushSessionMessage`; pre-registration in lifespan eliminates the race |
| `--resume` via persisted session IDs | Claude Code saves state to `.claude/` on graceful subprocess shutdown; session IDs survive `mark_dirty()` rebuilds via JSON file and `_saved_session_ids` snapshot |
| Credential URL validated to cluster-local hostname | Prevents exfiltration of user tokens to external hosts if `BACKEND_API_URL` is tampered with |
| LLM credentials (Anthropic/Vertex) remain in runner | These are necessary for inference and cannot be moved to sidecars without changing the SDK contract |
| `AGUI_TOKEN` session auth middleware | Prevents cross-session attacks where an attacker uses another session's runner URL; uses `secrets.compare_digest()` for constant-time comparison |
| Runtime model switching via `POST /model` | Allows the frontend/CLI to change `LLM_MODEL` without restarting the pod; acquires a lock to prevent concurrent switches and rejects if agent is mid-generation |
| Connect retry with readiness signal | `client.connect()` is the most fragile step in the startup chain — sandbox file locks, binary readiness races, and network namespace setup delays all cause transient failures. Retry with backoff matches the pattern used by `_auto_execute_initial_prompt`. The readiness event prevents the caller from hanging indefinitely on a dead worker's queue. |
| File logging tee (not replacement) | stdout/stderr must remain active for `kubectl logs`; the file handler is additive. `RotatingFileHandler` prevents unbounded disk growth. Graceful degradation (skip file handler on permission error) ensures the runner starts on read-only root filesystems. Log directory placed under `/sandbox/.runner/logs` (not `/var/log/runner`) because `/sandbox` is writable in both standard and OpenShell images and avoids Dockerfile changes. |

---

## OpenShell Sandbox Isolation

> **Status:** Implemented — validated end-to-end on ROSA OpenShift (kernel 5.14+)
> **Companion docs:** `docs/internal/agents/openshell-runner-adaptation.md` (implementation details), `docs/internal/agents/openshell-security-analysis.md` (threat model)
> **Formal requirements:** `specs/security/openshell-sandbox.spec.md`

The runner wraps the Claude Code subprocess inside NVIDIA OpenShell's Supervisor
binary (`openshell-sandbox` v0.0.56), applying five defense-in-depth isolation
layers. The Supervisor operates in **file mode** — policy is provided via local
Rego + YAML files mounted from a ConfigMap. No OpenShell Gateway is required.

### Architecture

```
Runner Pod (FastAPI + uvicorn) — runs UNSANDBOXED
  │
  └── bridge.py sets cli_path = /app/standard-claude-wrapper.sh
        │
        └── Claude Agent SDK spawns wrapper as subprocess
              │
              └── standard-claude-wrapper.sh
                    │
                    └── exec /openshell-sandbox \
                          --policy-rules /etc/openshell/policy.rego \
                          --policy-data /etc/openshell/policy.yaml \
                          -- /usr/local/bin/claude "$@"
                              │
                              ├── fork()
                              │     pre_exec closure (in child, before exec):
                              │       1. setns(CLONE_NEWNET) → enter sandbox network namespace
                              │       2. drop_privileges(setgroups/setgid/setuid → sandbox:sandbox)
                              │       3. harden_child_process(RLIMIT_CORE=0, PR_SET_DUMPABLE=0, PR_SET_NO_NEW_PRIVS=1)
                              │       4. landlock::enforce(restrict_self) → filesystem allowlist
                              │       5. seccomp::apply(bpf_filter) → syscall blocklist
                              │
                              └── exec(/usr/local/bin/claude) ← runs as sandbox user in isolated netns
```

The runner process (FastAPI, gRPC client, credential fetching) runs outside the
sandbox boundary. Only the Claude CLI subprocess is sandboxed. This means the
gRPC client, SSE tap, and health endpoints are unaffected.

### Five Isolation Layers (All Verified Working)

| Layer | Mechanism | Verified Evidence |
|-------|-----------|-------------------|
| **1. Network namespace** | `ip netns add` + veth pair (`10.200.0.1`↔`10.200.0.2`), default route via proxy | `OCSF CONFIG:CREATED [INFO] Network namespace created [ns:sandbox-* host_ip:10.200.0.1 sandbox_ip:10.200.0.2]` |
| **2. TLS proxy (L7)** | HTTP CONNECT proxy at `10.200.0.1:3128`, ephemeral per-sandbox CA, `HTTPS_PROXY`/`SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS` injected | `HTTP/1.1 200 Connection Established` for policy-allowed hosts; `000` (refused) for blocked hosts |
| **3. Landlock LSM** | Filesystem allowlist via `landlock_restrict_self` (12 rules: 8 read-only, 4 read-write) | `OCSF CONFIG:BUILT [INFO] Landlock ruleset built [rules_applied:12 skipped:0]` |
| **4. seccomp-BPF** | Three-layer filter: supervisor prelude → clone3 ENOSYS → main runtime (blocks `ptrace`, `memfd_create`, raw sockets) | `Blocking socket domain via seccomp` (3 domains blocked) |
| **5. OPA policy enforcement** | Per-binary network ACLs via Rego rules; binary identity checked per-request | Allowed endpoints return HTTP status; blocked hosts return connection refused |

### Policy Files

Policy is stored in a ConfigMap (`openshell-policy`) in the CP namespace and
propagated to each runner namespace by the reconciler's `ensureOpenShellPolicy()`.

**Filesystem policy** (`policy.yaml`):

| Access | Paths |
|--------|-------|
| Read-only | `/usr`, `/lib`, `/opt`, `/proc`, `/dev/urandom`, `/app`, `/runner`, `/etc`, `/var/log` |
| Read-write | `/sandbox`, `/tmp`, `/dev/null`, `/sandbox/.runner/logs` |

**Network policy** (`policy.yaml`):

| Policy | Endpoints | Allowed Binaries |
|--------|-----------|-----------------|
| `anthropic-api` | `api.anthropic.com:443`, `statsig.anthropic.com:443` | `claude`, `node`, `curl` |
| `vertex-ai` | `us-east5-aiplatform.googleapis.com:443`, `europe-west1-aiplatform.googleapis.com:443`, `us-central1-aiplatform.googleapis.com:443`, `oauth2.googleapis.com:443` | `claude`, `node`, `curl` |
| `github` | `github.com:443`, `api.github.com:443` | `git`, `gh`, `curl` |
| `npm-registry` | `registry.npmjs.org:443` | `npm`, `node`, `npx` |
| `pypi` | `pypi.org:443`, `files.pythonhosted.org:443` | `pip3`, `python3` |
| `gitlab` | `gitlab.com:443` | `git`, `glab` |
| `atlassian` | `*.atlassian.net:443`, `*.atlassian.com:443`, `auth.atlassian.com:443`, `api.atlassian.com:443` | `/sandbox/.venv/bin/python`, `/sandbox/.venv/bin/python3`, `/sandbox/.uv/python/cpython-*/bin/python*` |

**Rego rules** (`policy.rego`): Official policy from the OpenShell repository
(`package openshell.sandbox`). Evaluates `allow_network`, `network_action`,
`deny_reason`, and `allow_request` based on host, port, binary path, HTTP method,
and canonicalized request path.

### Required Linux Capabilities

The Supervisor needs elevated capabilities for sandbox setup. These are granted
only when `OPENSHELL_ENABLED=true` in the CP config:

| Capability | Required For |
|------------|-------------|
| `NET_ADMIN` | Create network namespace (`ip netns add`), configure veth pair and routing |
| `SYS_ADMIN` | Mount propagation for `/var/run/netns`, `nsenter` for in-namespace commands |
| `SYS_PTRACE` | Process tracing for binary identity verification |
| `SETUID` | `drop_privileges()`: switch from root to `sandbox` user via `setuid` |
| `SETGID` | `drop_privileges()`: switch group via `setgid`/`setgroups` |
| `CHOWN` | Set ownership on sandbox directories (`/workspace`, `/tmp`) |
| `DAC_OVERRIDE` | Access directories during privilege transition |

The container also requires:
- `allowPrivilegeEscalation: true` (needed for `setuid`/`setns` in the pre_exec closure)
- `runAsUser: 0` (Supervisor must start as root to set up netns and drop privileges)
- `seccompProfile: Unconfined` at the pod level (Supervisor applies its own seccomp filter)

### OpenShift SCC

On OpenShift clusters, a custom SecurityContextConstraints object (`openshell-sandbox`)
MUST be created and bound to the runner service account. The SCC allows the seven
capabilities listed above, `allowPrivilegeEscalation: true`, `runAsUser: RunAsAny`,
and all seccomp profiles.

### Control Plane Integration

The CP reconciler (`kube_reconciler.go`) conditionally enables OpenShell via the
`OPENSHELL_ENABLED` environment variable:

| CP Config | Env Var | Default | Purpose |
|-----------|---------|---------|---------|
| `OpenShellEnabled` | `OPENSHELL_ENABLED` | `false` | Master toggle for sandbox isolation |
| `OpenShellPolicyName` | `OPENSHELL_POLICY_CONFIGMAP` | `openshell-policy` | ConfigMap name for policy files |

When enabled, the reconciler:
1. Copies the policy ConfigMap from the CP namespace to the runner namespace (`ensureOpenShellPolicy`)
2. Adds the policy ConfigMap as a volume + mount at `/etc/openshell`
3. Injects `OPENSHELL_ENABLED=true`, `OPENSHELL_POLICY_RULES`, `OPENSHELL_POLICY_DATA` env vars
4. Overrides the runner security context with elevated capabilities and root UID
5. Sets pod-level seccomp profile to `Unconfined`

### Gateway Mode (OpenShell Gateway)

When `OPENSHELL_USE_GATEWAY=true`, the runner operates inside an OpenShell gateway-managed sandbox instead of a file-mode sandbox. The runner image is built from `Dockerfile.openshell` and uses a separate image (`OPENSHELL_RUNNER_IMAGE`, default `quay.io/ambient_code/acp_runner_openshell:latest`).

Key differences from file mode:

| Aspect | File Mode | Gateway Mode |
|--------|-----------|--------------|
| Image | `Dockerfile` (`RUNNER_IMAGE`) | `Dockerfile.openshell` (`OPENSHELL_RUNNER_IMAGE`) |
| Runner path | `/app/ambient-runner` | `/runner/ambient-runner` |
| Process start | Container `CMD` | `ExecSandbox` gRPC after sandbox reaches Ready |
| Credentials | Sidecar containers | Gateway providers (egress proxy injection) |
| Sandbox isolation | In-container Supervisor (file mode) | Gateway-managed Supervisor |
| Inference routing | Runner env vars (`USE_VERTEX`, `CLAUDE_CODE_USE_VERTEX`, `ANTHROPIC_VERTEX_PROJECT_ID`) | Gateway `SetClusterInference` + `providers_v2_enabled` setting; `USE_VERTEX` and `CLAUDE_CODE_USE_VERTEX` are NOT set |

#### Inference Configuration

In gateway mode, the control plane configures the gateway's [inference routing](https://docs.nvidia.com/openshell/sandboxes/inference-routing) after creating credential providers. The gateway exposes an `inference.local` HTTPS endpoint inside each sandbox that strips sandbox credentials, injects backend credentials, and forwards requests to the configured LLM provider.

Before configuring providers or inference, the control plane enables `providers_v2_enabled=true` on the gateway via `UpdateConfig`. This is required for gateway versions 0.0.72+ to proxy inference traffic correctly. The control plane then iterates all bound credentials and configures inference routing for every inference-capable provider type (e.g., `google-vertex-ai`, `claude`, `anthropic`, `nvidia`, `openai`, `aws-bedrock`). For each qualifying provider, it calls `SetClusterInference` with `provider_name`, `model_id` (derived from `session.LlmModel`, defaulting to `claude-sonnet-4-6`), and `no_verify=true`.

The gateway's privacy router uses these settings to route inference requests through the configured provider, injecting credentials transparently. In gateway mode, the control plane sets `ACP_OPENSHELL_INFERENCE=true` for **all** provider types — not only Vertex. This ensures the runner activates inference routing mode regardless of which credential backend is configured (Vertex, Anthropic, NVIDIA, OpenAI, AWS Bedrock, etc.). The control plane does NOT set `USE_VERTEX`, `CLAUDE_CODE_USE_VERTEX`, or `ANTHROPIC_VERTEX_PROJECT_ID` in the sandbox environment — per the [OpenShell Vertex AI docs](https://docs.nvidia.com/openshell/providers/google-vertex-ai), setting these flags inside sandboxes causes Claude Code to bypass the gateway proxy and attempt direct connections with credential discovery, which fails because sandboxes don't expose provider credentials. The gateway handles routing transparently via the configured provider.

See `openshell-sandbox-provisioning.spec.md` § Inference Configuration via SetClusterInference and § Providers V2 Enablement for the full requirements.

#### Runner-Side Inference Routing (`ACP_OPENSHELL_INFERENCE`)

When the control plane sets `ACP_OPENSHELL_INFERENCE=true` in the sandbox environment, the runner's `setup_sdk_authentication()` (`bridges/claude/auth.py`) activates inference routing mode instead of direct Vertex AI or Anthropic API key authentication.

In inference routing mode, the runner sets:

| Env Var | Value | Purpose |
|---------|-------|---------|
| `ANTHROPIC_API_KEY` | `"inference-routing"` | Placeholder — Claude SDK requires a non-empty key |
| `ANTHROPIC_BASE_URL` | `https://inference.local` (default) | Virtual hostname intercepted by the supervisor proxy; set via `os.environ.setdefault()` so an agent-provided value takes precedence |
| `HTTPS_PROXY` | `http://10.200.0.1:3128` | Route all HTTPS through the supervisor's CONNECT proxy |
| `SSL_CERT_FILE` | `/etc/openshell-tls/openshell-ca.pem` | Trust the sandbox's ephemeral CA (Python `ssl` module) |
| `REQUESTS_CA_BUNDLE` | `/etc/openshell-tls/openshell-ca.pem` | Trust the sandbox's ephemeral CA (`requests` library) |
| `NODE_EXTRA_CA_CERTS` | `/etc/openshell-tls/openshell-ca.pem` | Trust the sandbox's ephemeral CA (Node.js / Claude Code CLI) |

`ANTHROPIC_BASE_URL` uses `setdefault` rather than a hard assignment. If the agent declares a custom `ANTHROPIC_BASE_URL` in its environment (e.g., pointing to a mock LLM server for e2e testing), the control plane injects it into the sandbox environment before the runner starts, and `setdefault` preserves it. This enables testing workflows that bypass the gateway inference proxy entirely.

The runner also clears `USE_VERTEX` and `CLAUDE_CODE_USE_VERTEX` — inference routing replaces direct Vertex API access with the proxy-mediated path. The model is set from `LLM_MODEL` env var or defaults to `claude-sonnet-4-6`.

`inference.local` has no DNS entry. The supervisor proxy intercepts the CONNECT request by hostname and routes it to the upstream inference provider configured via `UpdateConfig`. The proxy terminates TLS using the sandbox's ephemeral self-signed CA.

#### Sandbox Network Namespace and Proxy Routing

In gateway mode, the runner process runs inside a sandbox network namespace with no direct route to cluster IPs or DNS. All traffic MUST traverse the supervisor's HTTP CONNECT proxy at `10.200.0.1:3128`.

**Critical constraint — `NO_PROXY`:** The control plane sets `NO_PROXY=127.0.0.1,localhost` for gateway-mode sandboxes. `NO_PROXY` MUST NOT include `.svc.cluster.local` or any cluster-internal domain suffix. If it does, the runner's HTTP/gRPC clients will attempt direct connections to cluster services that fail because the sandbox namespace has no route to those IPs. This is different from non-gateway modes where the pod has direct cluster connectivity.

**Automatic proxy/TLS injection:** The supervisor's SSH path (used by `ExecSandbox`) calls `env_clear()` on the child process and rebuilds the environment from:
- `child_env::proxy_env_vars()` — 9 vars: `ALL_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, lowercase variants, `grpc_proxy`, `NODE_USE_ENV_PROXY=1`
- `child_env::tls_env_vars()` — 6 vars: `NODE_EXTRA_CA_CERTS`, `DENO_CERT`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`
- `user_environment` from the `CreateSandboxRequest`

The runner does not need to set proxy or TLS CA vars for general cluster traffic — the supervisor handles this. The runner only sets inference-specific vars (`ANTHROPIC_BASE_URL`, `HTTPS_PROXY` for inference.local routing) via `setup_sdk_authentication()`.

#### OPA Network Policy for ACP Internal Traffic

The sandbox's OPA network policy MUST include an `_acp_internal` network policy rule that whitelists the control plane and API server endpoints for the runner's Python binaries. Without this, the supervisor proxy denies all cluster-internal traffic from the runner with `DENIED FORWARD`.

The runner image bundles a default `policy.yaml` (via `Dockerfile.openshell`) that includes a static `_acp_internal` entry with hardcoded `ambient-code` namespace endpoints. In gateway mode, this baked-in policy becomes the sandbox's default policy. The control plane **overwrites** the `_acp_internal` entry after sandbox creation using OpenShell's `UpdateConfig` RPC with `merge_operations` (equivalent to `openshell policy update --add-allow`) to set the correct namespace-specific endpoints. All other rules in the baked-in default policy (e.g., `claude_code_vertex`, `github_ssh_over_https`, `pypi`) are preserved. See `agent-sandbox-config.spec.md` (ACP Internal Policy Injection) and `openshell-sandbox-provisioning.spec.md` (ACP Internal Network Policy Injection) for the injection mechanism.

Required endpoints (namespace varies by deployment):

| Host | Port | Purpose |
|------|------|---------|
| `ambient-control-plane.{namespace}.svc[.cluster.local]` | 8080 | CP token endpoint |
| `ambient-api-server.{namespace}.svc[.cluster.local]` | 8000 | API server HTTP |
| `ambient-api-server.{namespace}.svc[.cluster.local]` | 9000 | API server gRPC |

Allowed binaries: `/sandbox/.venv/bin/python`, `/sandbox/.venv/bin/python3`, `/sandbox/.venv/bin/uvicorn`, `/sandbox/.uv/python/cpython-*/bin/python*`

Both short (`svc`) and fully-qualified (`svc.cluster.local`) hostnames must be listed because the proxy matches on the exact hostname in the CONNECT request.

### Environment Variables (OpenShell-specific)

| Var | Injected By | Purpose |
|-----|-------------|---------|
| `OPENSHELL_ENABLED` | CP reconciler | Enables sandbox wrapper in `bridge.py` |
| `OPENSHELL_POLICY_RULES` | CP reconciler | Path to Rego policy file (`/etc/openshell/policy.rego`) |
| `OPENSHELL_POLICY_DATA` | CP reconciler | Path to YAML policy data (`/etc/openshell/policy.yaml`) |
| `OPENSHELL_LOG_LEVEL` | Wrapper script default | Supervisor log level (`warn` default) |
| `ACP_OPENSHELL_INFERENCE` | CP reconciler (gateway mode) | When `true`, activates runner-side inference routing via `inference.local` proxy instead of direct Vertex/Anthropic API |

### Files Modified

| File | Component | Change |
|------|-----------|--------|
| `Dockerfile` | Runner | Added `openshell-sandbox` v0.0.56 binary, `sandbox` user, `/workspace` dir, `/usr/local/bin/claude` symlink, `iproute` package |
| `standard-claude-wrapper.sh` | Runner | Wrapper script: dispatches to supervisor or direct claude based on `OPENSHELL_ENABLED` |
| `bridges/claude/bridge.py` | Runner | `cli_path = "/app/standard-claude-wrapper.sh"` when OpenShell enabled |
| `.openshell-ref/policy.rego` | Runner | Official OPA Rego policy from OpenShell repository |
| `.openshell-ref/policy.yaml` | Runner | Network + filesystem + process policy data |
| `internal/reconciler/kube_reconciler.go` | Control Plane | `buildRunnerSecurityContext`, `buildVolumes`, `buildVolumeMounts`, `buildEnv`, `ensureOpenShellPolicy` |
| `internal/config/config.go` | Control Plane | `OpenShellEnabled`, `OpenShellPolicyName` config fields |
| `internal/kubeclient/kubeclient.go` | Control Plane | `ConfigMapGVR`, `GetConfigMap`, `CreateConfigMap` methods |
| `cmd/ambient-control-plane/main.go` | Control Plane | Thread OpenShell config into reconciler |

### Known Limitations

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| `nftables` not installed in runner image | Bypass detection iptables rules not installed; supervisor logs `DEGRADED` warning | Network namespace still enforces proxy routing via default route; add `nftables` package to Dockerfile in a future iteration |
| `cgroup pids.max` unlimited | Supervisor warns about missing PID limit | Configure pod resource limits or cgroup constraints at the node level |
| Network namespace cleanup on crash | If the supervisor crashes, leftover netns/veth pairs may cause `Address in use` on next start | Pod restart cleans up; the supervisor's cleanup logic handles most cases |
| Credential proxy pattern not yet implemented | Agent still has LLM credentials in environment (Vertex AI service account) | LLM credentials are necessary for inference; placeholder/proxy rewrite is a future phase |
| Kernel 5.14+ required for Landlock ABI v2+ | Landlock `restrict_self` with flags requires kernel 6.10+; v0.0.56 uses flags=0 on older kernels | `best_effort` compatibility mode ensures graceful degradation |

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| File mode (no Gateway) | Eliminates operational dependency on OpenShell Gateway; policy is static per-deployment and distributed via ConfigMap |
| Wrapper script instead of direct SDK modification | Minimal change surface in bridge.py (1 line); wrapper handles supervisor dispatch vs. direct execution |
| Supervisor v0.0.56 pinned | Reproducible builds; version tested end-to-end on ROSA |
| Root UID for runner when sandbox enabled | Supervisor must create network namespaces and drop privileges to sandbox user; running as non-root prevents netns setup |
| ConfigMap propagation from CP namespace | Runner namespace may not exist when the CP starts; propagation on session provision ensures policy availability |
| `/usr/local/bin/claude` symlink | Claude SDK bundles its CLI at a version-dependent path; symlink provides a stable path for the policy's `binaries` list |

---
