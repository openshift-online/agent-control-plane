# Runner Gap Analysis: Spec vs Implementation

**Date:** 2026-07-11
**Spec Reference:** `specs/platform/runner.spec.md` (2026-07-05)
**Runner Source:** `components/runners/ambient-runner/ambient_runner/`
**Test Suite:** `components/runners/ambient-runner/tests/` (46 test files)

---

## Methodology

1. Read the runner spec end-to-end (810 lines covering startup, bridge, gRPC transport, SSE tap, credentials, MCP servers, OpenShell sandbox)
2. Mapped every spec section to actual source files, read all 60+ implementation files
3. Inventoried all 46 existing test files and their coverage
4. Cross-referenced live pod failure logs (`exec process exited with code 1` in `ambient-control-plane-5b755b8db7-4vlpj`) with the OpenShell gateway exec path
5. Identified spec requirements that have no test, implementation deviations from spec, and runtime-observable gaps

---

## A. Spec-vs-Implementation Feature Parity

| Spec Feature | Spec Section | Status | Implementation File(s) | Notes |
|---|---|---|---|---|
| FastAPI app + uvicorn | Overview | **Match** | `app.py`, `main.py` | |
| `GET /events/{thread_id}` SSE tap | §SSE Tap | **Match** | `endpoints/events.py` | Filters `MESSAGES_SNAPSHOT`, heartbeat 30s, close on `RUN_FINISHED`/`RUN_ERROR` |
| `GET /events/{thread_id}/wait` | — | **Impl extra** | `endpoints/events.py` | Polling fallback not in spec — defensive addition for slow listener startup |
| `POST /` AG-UI run | §Two Message Paths | **Match** | `endpoints/run.py` | With `grpc_push_middleware` fan-out |
| `POST /model` | §Design Decisions | **Match** | `endpoints/model.py` | Lock, reject-if-generating, between-run queue event |
| `POST /interrupt` | §Bridge Layer | **Match** | `endpoints/interrupt.py` | |
| `GET /health` | §Bridge Layer | **Match** | `endpoints/health.py` | |
| `GET /capabilities` | §Bridge Layer | **Match** | `endpoints/capabilities.py` | Dynamic feature scan of registered routes |
| `GET /repos`, `POST /repos/add`, `POST /repos/remove` | — | **Impl extra** | `endpoints/repos.py` | Runtime repo management, not in spec |
| `POST /workflow` | — | **Impl extra** | `endpoints/workflow.py` | Runtime workflow change, not in spec |
| `GET /mcp/status` | — | **Impl extra** | `endpoints/mcp_status.py` | MCP server diagnostics |
| `GET /content/*` | — | **Impl extra** | `endpoints/content.py` | File/git operations, replaces Go content sidecar |
| `GET /tasks`, `POST /tasks/{id}/stop` | — | **Impl extra** | `endpoints/tasks.py` | Background task management |
| `POST /feedback` | — | **Impl extra** | `endpoints/feedback.py` | Langfuse score creation |
| gRPC `WatchSessionMessages` listener | §gRPC Transport | **Match** | `bridges/claude/grpc_transport.py` | Resume-by-seq, backoff 1s→30s, `UNAUTHENTICATED` reconnect |
| `GRPCMessageWriter` | §gRPC Transport | **Deviation** | `bridges/claude/grpc_transport.py` | Spec says accumulate `MESSAGES_SNAPSHOT` and extract text. Impl uses `TEXT_MESSAGE_START/CONTENT/END` buffering — functionally equivalent, simpler |
| `PushSessionMessage` push | §gRPC Transport | **Match** | `_session_messages_api.py` | Hand-rolled protobuf, UNAUTHENTICATED retry |
| `PushSessionEvent` push | — | **Impl extra** | `_session_events_api.py` + `middleware/event_compressor.py` | Compressed event push not in spec |
| CP token (RSA-OAEP) | §Token Authentication | **Match** | `_grpc_client.py` | Encrypt session ID, fetch from CP `/token` |
| `get_bot_token()` priority | §Token Authentication | **Match** | `platform/utils.py` | CP cache → file mount → env var |
| `AGUI_TOKEN` middleware | §AGUI_TOKEN Session Auth | **Match** | `app.py` | `secrets.compare_digest()`, exempt `/health` and `/healthz` |
| Bridge ABC | §Bridge Layer | **Match** | `bridge.py` | `capabilities`, `run`, `interrupt` + lifecycle hooks |
| `ClaudeBridge` | §Claude Bridge | **Match** | `bridges/claude/bridge.py` | Session isolation, per-turn lifecycle, `mark_dirty()` |
| `SessionManager` + `SessionWorker` | §Session Isolation | **Match** | `bridges/claude/session.py` | Persistent reader, between-run queue, `--resume` via JSON |
| Deferred `_setup_platform()` | §First-Run Platform Setup | **Match** | `bridges/claude/bridge.py` | 8-step setup per spec |
| Workspace resolution | §Workspace Resolution | **Match** | `platform/workspace.py` | Workflow → multi-repo → default |
| `SESSION_CONFIG_PATH` | §Workspace Resolution | **Match** | `platform/config.py` | Validates abs, exists, is_dir; enables skills |
| Credential sidecar isolation | §Credential Management | **Match** | `platform/auth.py` | Sidecar mode skips env population |
| Git operations via MCP | §Git Operations | **Match** | `platform/prompts.py` | System prompt instructs MCP tools; no `git push` from runner |
| MCP server assembly | §MCP Servers | **Match** | `bridges/claude/mcp.py` | All server types present |
| `acp` MCP server fallback | §MCP Servers | **Match** | `bridges/claude/backend_tools.py` | Only registered when `AMBIENT_MCP_URL` unset |
| OpenShell file-mode sandbox | §OpenShell Sandbox | **Match** | `standard-claude-wrapper.sh` | Supervisor dispatch with stale netns cleanup |
| OpenShell gateway mode | §Gateway Mode | **Match** | `Dockerfile.openshell`, `openshell-claude-wrapper.sh`, `entrypoint.sh` | |
| Inference routing (`ACP_OPENSHELL_INFERENCE`) | §Runner-Side Inference Routing | **Match** | `bridges/claude/auth.py` | Sets `ANTHROPIC_BASE_URL=https://inference.local`, proxy vars, clears Vertex flags |

---

## B. Identified Gaps

### B1. Gaps with Missing or Zero Test Coverage

| # | Gap | Risk | Affected File(s) | Current Test Coverage |
|---|-----|------|-------------------|----------------------|
| **G1** | `AGUI_TOKEN` session auth middleware — prevents cross-session attacks via `X-Ambient-Session-Token` header | **CRITICAL** — security boundary | `app.py:264-283` | **Zero tests** |
| **G2** | SSE event stream end-to-end through OpenShell gateway `ExecSandbox` path | **HIGH** — the exact failure path from pod logs | `endpoints/events.py`, `grpc_transport.py`, `entrypoint.sh` | **Zero integration tests** for gateway-specific SSE delivery |
| **G3** | OpenShell inference routing auth setup (`setup_sdk_authentication` when `ACP_OPENSHELL_INFERENCE=true`) — env var population for proxy/TLS | **HIGH** — makes inference work through the OpenShell proxy | `bridges/claude/auth.py:86-125` | **Zero tests** |
| **G4** | Content endpoint path traversal validation — validates paths stay within `WORKSPACE_PATH` | **HIGH** — security | `endpoints/content.py` | **Zero explicit security tests** |
| **G5** | `RESUME_AFTER_SEQ` gRPC listener resume filtering — prevents duplicate Claude turns on pod restart | **MEDIUM** — correctness on restart | `bridges/claude/grpc_transport.py` | **Zero targeted tests** |
| **G6** | `mark_dirty()` session ID preservation across adapter rebuild — ensures `--resume` survives MCP config changes | **MEDIUM** — session continuity | `bridges/claude/bridge.py` | **Zero tests** |
| **G7** | `PermissionError` retry in `_handle_user_message` — token refresh + retry once | **MEDIUM** — gRPC transport resilience | `bridges/claude/grpc_transport.py` | **Zero tests** |
| **G8** | `GRPCMessageWriter` edge cases — empty text, very large text, mid-stream error flush | **MEDIUM** — data integrity | `bridges/claude/grpc_transport.py` | Partial (basic consume tested, no edge cases) |
| **G9** | Event compressor → `SessionEventsAPI` push integration — combined path through `grpc_push_middleware` | **MEDIUM** — event delivery | `middleware/grpc_push.py`, `middleware/event_compressor.py`, `_session_events_api.py` | Partial (unit tests exist separately, no integration test) |
| **G10** | `openshell-claude-wrapper.sh` recursion guard and env setup | **HIGH** — guards infinite recursion, sets proxy/TLS env | `openshell-claude-wrapper.sh` | **Zero tests** (shell script) |
| **G11** | `entrypoint.sh` ndots patching — resolv.conf rewrite for musl libc DNS | **MEDIUM** — the exact ndots:5 issue from pod logs | `entrypoint.sh` | **Zero tests** (shell script) |
| **G12** | SSE heartbeat keepalive (30s timeout → `: heartbeat\n\n`) | **LOW** — correctness under slow consumers | `endpoints/events.py` | **Zero tests** |
| **G13** | `POST /model` between-run event delivery to SSE consumers | **LOW** — model switch notification | `endpoints/model.py`, `bridges/claude/session.py` | Partial (structural test exists, no SSE integration) |
| **G14** | `STOP_ON_RUN_FINISHED` — calls `os._exit(0)` after run completes | **LOW** — one-shot session mode | `bridges/claude/grpc_transport.py` | **Zero tests** |

### B2. Runtime-Observable Gaps (from pod failure at 2026-07-11T11:11:45Z)

| # | Observation | Root Cause Hypothesis | Evidence |
|---|---|---|---|
| **R1** | `exec process exited with code 1` — runner exec failed 2s after token issuance | Entrypoint or uvicorn startup crashed inside the sandbox. Possible causes: missing deps at `/runner/ambient-runner`, Python venv not activated, proxy misconfiguration blocking pip/import, or ndots issue preventing DNS resolution for gRPC channel setup. | CP log: `"failed to start runner exec"` at 11:11:45, sandbox `session-3gm4lrutcm9dtery27bmsxffwx4` |
| **R2** | `pr-reviewer` session (`3GM9fQ9KNznJnQlXCsgMbuk0x5R`) never appeared in the watch stream | gRPC watch stream reconnection gap or the session was created during a stream interruption. The watch reconnected once at 11:01:46 with 935ms backoff. If `pr-reviewer` was created during a subsequent reconnect gap, the event could be lost. | CP log: zero events matching session ID `3GM9fQ9KNznJnQlXCsgMbuk0x5R` across entire log |
| **R3** | ndots:5 pod recreation dance — sandbox pod started with ndots:5 despite CR patch | OpenShell gateway controller creates the pod from the sandbox CR spec before the CP's ndots:1 patch propagates to the pod template. The CP detected the mismatch at 11:11:09 and deleted the pod for recreation. | CP log: `"sandbox pod has ndots:5, deleting for recreation from patched CR"` |

### B3. Spec Deviations (Non-Gap — Implementation Differs from Spec Text)

| # | Spec Says | Implementation Does | Impact |
|---|-----------|---------------------|--------|
| **D1** | `GRPCMessageWriter` accumulates `MESSAGES_SNAPSHOT` events, keeps only the latest, extracts assistant text on `RUN_FINISHED` or `RUN_ERROR` | Writer uses `TEXT_MESSAGE_START/CONTENT/END` event buffering — appends `delta` on CONTENT, pushes accumulated text on END | **None** — functionally equivalent, simpler implementation. Spec should be updated. |
| **D2** | SSE queue size: 100 | Queue is `asyncio.Queue()` with no explicit maxsize in the events endpoint (unbounded). The `_active_streams` queue pre-registered in lifespan also has no explicit size. | **Low risk** — could grow under pathological conditions but practical runs are bounded |
| **D3** | Spec lists `AGUI_PORT` default as `8001` in the overview diagram but env var table says `0.0.0.0:8001` | `app.py` defaults `AGUI_HOST=0.0.0.0` and `AGUI_PORT=8000`. `entrypoint.sh` (OpenShell image) forces port `8001`. | **Potential confusion** — spec and non-OpenShell default disagree on port number |

---

## C. Proposed Test Plan

### C1. Security Tests — CRITICAL

**File:** `tests/test_agui_token_middleware.py`

| Test | Validates |
|------|-----------|
| `test_token_correct_passes_through` | Valid token in `X-Ambient-Session-Token` header → request succeeds |
| `test_token_incorrect_returns_401` | Wrong token → 401 Unauthorized |
| `test_token_absent_returns_401` | Missing header → 401 Unauthorized |
| `test_health_exempt_with_token_set` | `GET /health` succeeds without token when `AGUI_TOKEN` is set |
| `test_healthz_exempt_with_token_set` | `GET /healthz` succeeds without token when `AGUI_TOKEN` is set |
| `test_no_token_env_no_middleware` | `AGUI_TOKEN` unset → all requests pass without header |
| `test_timing_safe_comparison` | Verify `secrets.compare_digest` is used (not `==`) |
| `test_non_health_paths_require_token` | `/events/x`, `/`, `/model`, `/interrupt`, `/capabilities` all require token |

**File:** `tests/test_content_path_traversal.py`

| Test | Validates |
|------|-----------|
| `test_path_within_workspace_allowed` | Valid path under `WORKSPACE_PATH` succeeds |
| `test_path_traversal_dot_dot_rejected` | `../../etc/passwd` → 400/403 |
| `test_symlink_escape_rejected` | Symlink pointing outside workspace → rejected |
| `test_absolute_path_outside_workspace_rejected` | `/etc/shadow` → rejected |
| `test_null_byte_injection_rejected` | Path with `%00` → rejected |

### C2. AG-UI SSE Event Stream Tests — HIGH

**File:** `tests/test_sse_event_stream_e2e.py`

| Test | Validates |
|------|-----------|
| `test_events_endpoint_streams_text_message_events` | Full text message lifecycle (START → CONTENT → END) delivered via SSE |
| `test_events_endpoint_filters_messages_snapshot` | `MESSAGES_SNAPSHOT` events never reach the SSE consumer |
| `test_events_endpoint_closes_on_run_finished` | Stream terminates after `RUN_FINISHED` event |
| `test_events_endpoint_closes_on_run_error` | Stream terminates after `RUN_ERROR` event |
| `test_events_endpoint_heartbeat_on_timeout` | `: heartbeat\n\n` sent after 30s of no events |
| `test_events_endpoint_queue_cleanup_on_disconnect` | Queue removed from `_active_streams` after client disconnects |
| `test_events_endpoint_concurrent_consumers` | Two consumers on the same `thread_id` both receive events |
| `test_events_wait_endpoint_polls_until_queue_appears` | `/wait` variant waits up to timeout for queue registration |
| `test_events_wait_endpoint_returns_404_on_timeout` | `/wait` returns 404 if queue never appears |
| `test_events_endpoint_with_grpc_listener_fanout` | gRPC listener `_handle_user_message` → bridge.run() → SSE tap receives events |

### C3. gRPC Transport Tests — HIGH

**File:** `tests/test_grpc_message_writer_extended.py`

| Test | Validates |
|------|-----------|
| `test_multi_fragment_text_accumulation` | 10+ `TEXT_MESSAGE_CONTENT` deltas concatenated correctly |
| `test_empty_text_message` | `TEXT_MESSAGE_START` → `TEXT_MESSAGE_END` with no CONTENT → pushes empty string |
| `test_large_text_accumulation` | 100KB+ of content → single push with full text |
| `test_push_error_flushes_buffered_text` | `push_error()` pushes any buffered text before the error |
| `test_push_failure_logged_not_raised` | gRPC push failure → logged at warning, no exception propagated |
| `test_interleaved_tool_and_text_events` | Tool events between text messages don't corrupt text accumulation |

**File:** `tests/test_grpc_listener_resume.py`

| Test | Validates |
|------|-----------|
| `test_resume_after_seq_skips_old_messages` | Messages with `seq <= RESUME_AFTER_SEQ` are filtered out |
| `test_resume_after_seq_processes_new_messages` | Messages with `seq > RESUME_AFTER_SEQ` trigger `bridge.run()` |
| `test_time_based_resume_filtering` | Messages before the 5-second lookback cutoff are skipped |
| `test_permission_error_triggers_token_refresh_and_retry` | `PermissionError` in `_handle_user_message` → refresh token → retry once |
| `test_stop_on_run_finished_exits` | `STOP_ON_RUN_FINISHED=true` → `os._exit(0)` after run completes |

### C4. OpenShell Gateway Mode Tests — HIGH

**File:** `tests/test_openshell_inference_routing.py`

| Test | Validates |
|------|-----------|
| `test_inference_routing_sets_anthropic_base_url` | `ANTHROPIC_BASE_URL` → `https://inference.local` |
| `test_inference_routing_sets_https_proxy` | `HTTPS_PROXY` → `http://10.200.0.1:3128` |
| `test_inference_routing_sets_ssl_cert_file` | `SSL_CERT_FILE` → `/etc/openshell-tls/openshell-ca.pem` |
| `test_inference_routing_sets_requests_ca_bundle` | `REQUESTS_CA_BUNDLE` → same CA path |
| `test_inference_routing_sets_node_extra_ca_certs` | `NODE_EXTRA_CA_CERTS` → same CA path |
| `test_inference_routing_clears_vertex_flags` | `USE_VERTEX` and `CLAUDE_CODE_USE_VERTEX` removed from env |
| `test_inference_routing_returns_placeholder_api_key` | Returns `("inference-routing", False, model)` |
| `test_inference_routing_default_model` | Model defaults to `claude-sonnet-4-6` |
| `test_inference_routing_disabled_when_env_unset` | Falls through to Vertex/Anthropic path when `ACP_OPENSHELL_INFERENCE` absent |
| `test_inference_routing_disabled_for_false_values` | `ACP_OPENSHELL_INFERENCE=false` → not enabled |

**File:** `tests/test_openshell_wrapper.sh` (bash/bats)

| Test | Validates |
|------|-----------|
| `test_wrapper_dispatches_to_supervisor_when_enabled` | `OPENSHELL_ENABLED=true` → execs `/openshell-sandbox` |
| `test_wrapper_dispatches_direct_when_disabled` | `OPENSHELL_ENABLED` unset → execs Claude directly |
| `test_wrapper_recursion_guard_prevents_infinite_loop` | Second invocation hits guard file → execs `--bare` directly |
| `test_wrapper_sets_home_sandbox` | `HOME=/sandbox` in wrapper environment |
| `test_wrapper_cleans_stale_netns` | Stale `/var/run/netns/sandbox-*` entries cleaned before supervisor launch |

### C5. Bridge Lifecycle Tests — MEDIUM

**File:** `tests/test_mark_dirty_session_preservation.py`

| Test | Validates |
|------|-----------|
| `test_mark_dirty_preserves_session_ids` | `_saved_session_ids` snapshot taken before manager shutdown |
| `test_mark_dirty_triggers_adapter_rebuild` | `_adapter` and `_ready` cleared → next `run()` calls `_setup_platform()` |
| `test_mark_dirty_restores_session_ids_after_rebuild` | Session IDs restored in new `SessionManager` after rebuild |
| `test_mark_dirty_concurrent_with_active_run` | `mark_dirty()` during an active run → run completes, rebuild happens after |

**File:** `tests/test_model_switch_integration.py`

| Test | Validates |
|------|-----------|
| `test_model_switch_emits_between_run_event` | `ambient:model_switched` custom event placed on worker between-run queue |
| `test_model_switch_rejected_during_generation` | Returns 422 when session worker lock is held |
| `test_model_switch_updates_env_var` | `LLM_MODEL` env var updated, `LLM_MODEL_VERTEX_ID` cleared if Vertex |
| `test_model_switch_triggers_mark_dirty` | `bridge.mark_dirty()` called after env update |

### C6. Event Compressor + Push Integration — MEDIUM

**File:** `tests/test_grpc_push_integration.py`

| Test | Validates |
|------|-----------|
| `test_text_message_compressed_to_single_push` | START + N×CONTENT + END → single `PushSessionEvent` with `event_count=N+2` |
| `test_tool_call_compressed_to_single_push` | TOOL_CALL_START + N×TOOL_CALL_ARGS + TOOL_CALL_END → single push |
| `test_standalone_events_pushed_individually` | `RUN_STARTED`, `TOOL_CALL_RESULT` → individual pushes with `event_count=1` |
| `test_flush_on_stream_end` | Incomplete accumulation flushed when stream ends without END event |
| `test_dual_push_session_messages_and_events` | Each event pushed to both `session_messages` and `session_events` APIs |
| `test_no_op_when_grpc_unconfigured` | `AMBIENT_GRPC_URL` unset → events pass through with zero gRPC calls |

---

## D. Summary

### Spec Coverage

All major spec features are implemented. The implementation has grown beyond the spec in useful ways (event compression via `PushSessionEvent`, `/wait` endpoint, `content`/`tasks`/`repos`/`workflow`/`feedback` endpoints, runtime model switching).

### Key Risk Areas (ranked)

1. **AGUI_TOKEN middleware** (G1) — zero tests for a security boundary that prevents cross-session attacks
2. **Content endpoint path traversal** (G4) — zero explicit security tests for file access validation
3. **OpenShell inference routing auth** (G3) — zero tests for the env var population that makes inference work through the proxy
4. **SSE event stream through gateway exec** (G2) — the exact path that failed in the pod logs
5. **OpenShell wrapper recursion guard** (G10) — shell script with zero test harness, guards infinite recursion
6. **gRPC listener resume** (G5) — zero targeted tests for the duplicate-turn prevention mechanism (`RESUME_AFTER_SEQ`)
7. **`mark_dirty()` session ID preservation** (G6) — zero tests for the `--resume` survival path across MCP rebuilds

### Pod Failure Analysis

The `hello-world` session failure at 11:11:45 (`exec process exited with code 1`) is in the gateway `ExecSandbox` path. The control plane successfully created the sandbox, configured OPA policy, and called `ExecSandbox` with entrypoint `/runner/entrypoint.sh`, but the process inside the sandbox died within 2 seconds. Root cause candidates:

- Python venv not properly activated inside the sandbox (path mismatch between `Dockerfile.openshell` and `entrypoint.sh`)
- Proxy misconfiguration blocking Python imports or gRPC channel setup
- ndots issue (patched but possibly re-emerging) preventing DNS resolution for `ambient-api-server` during startup
- Missing runtime dependency in the OpenShell sandbox image

The `pr-reviewer` session never appearing in the watch stream is a separate issue: either the gRPC watch stream had a reconnection gap that dropped the event, or the session creation occurred during a period where the listener was not connected.
