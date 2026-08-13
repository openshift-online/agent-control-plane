# Skills Directory & Reconciliation Checkpoint

This file is the **entrypoint** for autonomous spec-to-code reconciliation.
It describes the skill directory, holds the current gap state, and is the
checkpoint that makes `/reconcile` idempotent across sessions.

**How it works**: The `/reconcile` skill reads this file first. If the gap
table below is populated, it skips Phases 1-4 (discovery, dependency graph,
gap analysis, merge) and jumps directly to Phase 5 (wave planning) or
Phase 6 (execution). After each wave or dry-run, the agent updates this
file with the new state. Because this file is committed to the repo, any
agent in any session can pick up where the last one left off.

**Idempotency contract**: Running `/reconcile` with no arguments always
produces the same result for the same spec+code state. If specs haven't
changed and code hasn't changed, the gap table stays the same and no
waves execute. If code was merged that closes gaps, the agent re-runs
gap analysis, updates this file, and the coverage numbers improve.

---

## Skill Directory

```
skills/
├── build/
│   ├── reconcile/         # Meta-orchestrator: reads this file, executes waves
│   ├── full-stack-pipeline/  # Single-spec wave-based implementation pipeline
│   └── dev-cluster/       # Kind cluster lifecycle for local testing
├── deploy/
│   ├── deploy-cluster/    # Production OpenShift deployment
│   └── kind/              # Kind cluster lifecycle
├── plan/
│   └── spec/              # Spec authoring (desired state)
├── review/
│   ├── acp-review-guidance/  # PR review checklists
│   ├── pr-fixer/          # Auto-fix PRs from review comments
│   └── ui-audit/          # 15-expert UI/UX audit
├── test/
│   └── pr-test/           # Deploy PR images to OpenShift for integration testing
└── tooling/
    ├── align/             # Convention compliance scoring
    ├── memory/            # Project memory management
    └── upgrade-upstream/  # rh-trex-ai framework dependency upgrades
```

**SDLC flow**: `/reconcile` → `/spec` → `/full-stack-pipeline` → `/dev-cluster` → `/pr-test` → `/deploy-cluster`

---

## Reconciliation State

**Last analyzed**: 2026-07-18 (openshell-cli-e2e-test gap analysis)
**Spec corpus**: 30 specs across 4 domains
**Codebase commit**: 40b550a7 (squizzi/amsterdam branch)

### Coverage Summary

| Domain | Specs | Requirements | Present | Partial | Missing | Coverage |
|--------|-------|-------------|---------|---------|---------|----------|
| Platform | 13 | 131 | 126 | 1 | 4 | 96.2% |
| Security | 6 | 55 | 47 | 3 | 5 | 85.5% |
| UI | 7 | 70 | 62 | 6 | 2 | 88.6% |
| CLI | 1 | 13 | 13 | 0 | 0 | 100% |
| **TOTAL** | **30** | **269** | **248** | **10** | **11** | **92.2%** |

### Spec Dependency Order

Reconciliation processes specs in this topological order:

```
Layer 0 (roots):  data-model, identity-boundaries, standards/*
Layer 1:          control-plane, sso-authentication, rbac-enforcement
Layer 2:          runner, agent-sandbox-config, credential-binding
Layer 3:          credential-encryption, agent-inheritance
Layer 4:          scheduled-session-execution, session-activity-tracking, mcp-server
Layer 5 (leaves): architecture, annotations, views, live-preview, project-sharing,
                  scheduled-sessions, work-tracking-dashboard, credentials-tui
```

---

## Gap Table

Each row is a gap between a spec requirement and the codebase. Status values:
- `missing` -- no implementation exists
- `partial` -- implementation started but incomplete
- `diverged` -- code intentionally differs from spec (needs decision)

Severity: `blocker` > `critical` > `major` > `minor`

### Security Gaps

| ID | Spec | Requirement | Layer | Status | Severity | Notes |
|----|------|-------------|-------|--------|----------|-------|
| S1 | identity-boundaries | Per-session RBAC Roles with resourceNames | CP | **done** | blocker | `ensureSessionRole` creates Role+RoleBinding with `resourceNames` scoping per session SA. |
| S2 | credential-binding | credential:token-reader grant lifecycle | CP | **done** | blocker | Already implemented: `grantTokenReaderBindings`/`revokeTokenReaderBindings` in reconciler. |
| S3 | identity-boundaries | NetworkPolicy session isolation | CP | **done** | blocker | `ensureSessionNetworkPolicy` creates per-session NetworkPolicy restricting ingress to CP + self only. |
| S5 | identity-boundaries | Cluster-internal caller validation | BE | **done** | critical | `GetToken` handler now requires `IsServiceCaller` or `IsGlobalAdmin`. |
| S6 | sso-authentication | K8s Impersonation headers | BE | missing | major | Backend doesn't implement `Impersonate-User`/`Impersonate-Group` headers. Deferred since API server uses PostgreSQL not K8s CRs. |
| S7 | credential-binding | Duplicate binding prevention at API level | BE | **done** | major | Already implemented: UNIQUE index `idx_role_bindings_unique` + `HandleCreateError` returns 409 Conflict. |
| S9 | sso-authentication | API key dual-path (JWT + TokenReview) | BE | partial | major | JWT auth present. K8s TokenReview fallback for SA tokens not implemented. |
| S10 | rbac-enforcement | gRPC watch idle timeout | BE | partial | minor | gRPC interceptor populates AuthResult but no idle timeout for watch streams. |
| S11 | sso-authentication | E2E test auth helper | Tests | partial | minor | Keycloak client_credentials flow exists in CLI. No E2E test helper using Kind Keycloak. |
| S12 | identity-boundaries | Build agent SA scoping | Manifests | missing | minor | `ambient-agent` SA for OpenShift build workflows not implemented. Future feature. |
| S13 | rbac-enforcement | Provider RBAC resource registration | BE | **done** | blocker | `provider` resource missing from RBAC permission system — middleware returned 404 before handler ran. Fixed: resource constants, isListEndpoint allowlist, role permissions migration. |
| S14 | rbac-enforcement | Provider handler SQL injection + missing RBAC | BE | **done** | critical | Provider List handler used raw string concat for project filter (SQL injection). Missing `ApplyListFilter`, input validation, and editor tier check. Fixed to match gateway handler pattern. |

### Platform Gaps

| ID | Spec | Requirement | Layer | Status | Severity | Notes |
|----|------|-------------|-------|--------|----------|-------|
| P1 | data-model | Application GitOps sync engine | CP | partial | critical | Only syncs Agent kind. Missing: Project, Credential, RoleBinding, Inbox sync. No kustomize rendering, auto_sync, self_heal, per-resource status. |
| P21 | control-plane | ProjectReconciler namespace lifecycle | CP | **done** | minor | Ordering already enforced: informer `initialSync` syncs `projects` before `sessions`, and `RegisterHandler` in main.go registers ProjectReconciler first. ProjectReconciler runs `ensureNamespace()` which creates namespaces before session reconcilers attempt to use them. |
| P22 | data-model | `acpctl apply` missing `sandbox_policy`, `sandbox_template`, `entrypoint` on Agent | CLI | **done** | critical | `sandbox_policy` added to `resource` struct, `applyAgent()` create path, and `buildAgentPatch()` update diffing. `strategicMerge()` handles kustomize overlays. All example agents wired with `sandbox_policy: permissive`. |
| P23 | data-model | `acpctl apply` missing `Policy` as supported kind | CLI | **done** | critical | `case "policy":` added to apply dispatch switch. `applyPolicy()` implements create-or-update with spec/labels/annotations diffing. `strategicMerge()` deep-merges `Spec` keys. `permissive` example policy ships in `examples/base/policies/`. Stored JSONB specs use the upstream `filesystem_policy` key name. |
| P24 | mlflow-tracing | Runner Image INTERNAL_BUILD conditional CA | Runner | partial | minor | CA cert installed unconditionally via `COPY` in `Dockerfile.openshell`. Missing `INTERNAL_BUILD` build arg, conditional logic, and remote fetch from `certs.corp.redhat.com`. |
| P25 | mlflow-tracing | OpenShell resolve token handling in autolog | Runner | partial | major | `mlflow_autolog.py` always calls `set_tracking_uri()`/`set_experiment()` unconditionally. Missing detection of `openshell:resolve:env:` prefix to defer URI config to supervisor. |
| P26 | mlflow-tracing | Tracing Token Security (regex redaction) | Runner | missing | major | No runner-wide regex redaction filter for `MLFLOW_TRACKING_TOKEN` in logs/errors/API responses. Spec acknowledges as TODO — no existing redaction infrastructure to extend. |
| P27 | mlflow-tracing | MLflow URI domain allowlist validation | BE | missing | minor | Spec requires HTTP 400 at credential-bind time when URI host not in allowlist. Spec acknowledges as TODO — requires new API server capability. |
| P2 | data-model | Application CLI sync/refresh commands | CLI | **done** | major | SDK `Sync()`/`Refresh()` methods added. CLI calls `POST /sync` and `POST /refresh`. Flags: `--prune`, `--revision`, `--prune-project`. |
| P3 | data-model | Application frontend UI | FE | **done** | major | Full CRUD UI: domain types, port, adapter, mapper, query hooks, list page, detail page. Gated behind `feature.applications.enabled` flag. |
| P4 | data-model | SessionEvent runner-side compression | Runner | **done** | major | `EventCompressor` integrated into gRPC transport path. Compressed events pushed to `session_events.push()` with `event_count` and `completed_at`. |
| P5 | data-model | Scoped RoleBinding query endpoints | BE | **done** | major | 4 new scoped endpoints: `/users/{id}/role_bindings`, `/projects/{id}/role_bindings`, `/sessions/{id}/role_bindings`, `/credentials/{cred_id}/role_bindings`. |
| P6 | data-model | GET /applications/{id}/status endpoint | BE | **done** | major | Added `GetStatus` handler + `ApplicationStatusResponse` presenter. Also fixed `LastSyncedAt` in main presenter. |
| P7 | mcp-server | watch_session_messages SSE forwarding | MCP | **done** | major | SSE client added to MCP client. `WatchSessionMessages` opens SSE stream, forwards events as `notifications/progress`, polls session phase every 5s, auto-terminates on completion. |
| P8 | control-plane | RESUME_AFTER_SEQ env var | CP | **done** | minor | CP queries max seq via `SessionMessages().List()` on resume. Sets `RESUME_AFTER_SEQ` env var. Runner uses seq-based filtering with time-based fallback. |
| P9 | mcp-server | MCP HTTP endpoint in api-server | BE | partial | minor | Blocked: needs new api-server plugin, process spawning, `openapi.mcp.yaml`. Token exchange client exists in ambient-mcp. |
| P10 | scheduled-session | Idempotency UNIQUE constraint | BE | **done** | minor | Verified: UNIQUE index `idx_sessions_schedule_idempotency` exists in migration 202606230002. |
| P11 | agent-sandbox-config | Git repo payload clone + SSH delivery | CP | **done** | major | `cloneRepo()` via go-git, `tarDirectory()` streams tar excluding `.git`, `writeRepoPayloadViaSSH()` extracts via SSH. `convertPayloads()` dispatches content vs repo. 5min timeout for repo payloads. |
| P12 | agent-sandbox-config | Payload mutual exclusivity validation | CP | partial | minor | `convertPayloads()` warns and skips payloads with both `content` and `repo_url`. API-level OpenAPI `oneOf` validation not yet enforced. |
| P13 | openshell-gateway | failSession condition format for UI visibility | CP+FE | **done** | major | Conditions now include `status: "False"`, `reason: "SetupFailed"`, `message: <detail>`. `SandboxFailure` added to UI `CONDITION_TITLES` map. Users now see clone/upload failures in session detail. |
| P28 | data-model | SDK status/heartbeat methods (Go, Python, TypeScript) | SDK | **done** | critical | Generator extended: `status` and `heartbeat` added to `knownActions`, `ResponseSchema` support for action return types. All 3 SDKs generated with `ClusterStatusResponse` type and `Status()`/`Heartbeat()` methods. |
| P29 | control-plane | ClusterHealthSyncer periodic health checker | CP | **done** | critical | `cluster_health_syncer.go` polls cluster heartbeat endpoint on configurable interval (default 30s). Wired into `main.go` with error channel pattern. Config: `CLUSTER_HEALTH_INTERVAL`. |
| P30 | control-plane | PlacementStrategy interface + RoundRobinPlacement | CP | **done** | critical | `internal/placement/strategy.go` with `PlacementStrategy` interface, `PlacementRequest`/`PlacementDecision` types, `RoundRobinPlacement` default. Filters by role, status, labels, heartbeat threshold. Config: `PLACEMENT_HEARTBEAT_THRESHOLD`. |

### UI Gaps

| ID | Spec | Requirement | Layer | Status | Severity | Notes |
|----|------|-------------|-------|--------|----------|-------|
| U1 | views | Virtual folder tree (ui/path annotation) | FE | **done** | major | `FolderTreePanel` component with recursive tree, `buildFolderTree` utility, `sessionMatchesPath` filter. Integrated into sessions page with toggle. |
| U2 | project-sharing | Ownership transfer | BE+FE | **done** | major | Backend handler + UI: SDK `transferOwnership` method, port/adapter/query hook, typed-confirmation dialog in collaborator manager. |
| U3 | project-sharing | Self-removal ("Leave project") | FE | **done** | major | Leave-project flow exists. Added tooltip on sole-owner row: "Transfer project ownership before leaving". |
| U4 | views | Settings: API Keys tab | FE | missing | minor | Blocked: no API key entity/migration/handlers in backend. |
| U5 | views | Settings: Feature Flags tab | FE | missing | minor | Blocked: `useWorkspaceFlag` is a stub. No Unleash integration yet. |
| U6 | live-preview | SSE fallback indicator | FE | missing | minor | Blocked: no SSE client exists. Uses polling only. |
| U7 | architecture | Sidebar "Configure" group label | FE | **done** | minor | Sidebar uses "Config" label. Non-OpenShell dual-mode code path removed. |
| U8 | project-sharing | Settings access via gear icon | FE | **done** | minor | Gear icon added to nav header. Visible only on project-scoped pages. |

### Divergences (Require Human Decision)

These items intentionally differ from spec. Decision needed: update spec or update code?

| ID | Spec | Issue | Current Code | Spec Says | Resolution |
|----|------|-------|-------------|-----------|------------|
| D3 | data-model | Implementation coverage matrix | Application CRUD, credential bind, Events API implemented | ~~"planned"~~ → Matrix corrected | **Resolved in PR #281**: Spec matrix updated. |

---

## Wave Plan

Gaps grouped by execution wave. Each wave gates the next.

| Wave | Layer | Items | IDs | Gate |
|------|-------|-------|-----|------|
| ~~2~~ | ~~API~~ | ~~3~~ | ~~P5, P6, U2~~ | ✅ Completed 2026-07-05 |
| ~~4~~ | ~~BE + CP~~ | ~~10~~ | ~~S1–S8, P10, S6~~ | ✅ Completed 2026-07-05 |
| ~~5~~ | ~~CLI + Runner~~ | ~~3~~ | ~~P2, P4, P8~~ | ✅ Completed 2026-07-05 |
| ~~6~~ | ~~FE~~ | ~~7~~ | ~~P3, U1, U2(UI), U3~~ | ✅ Completed 2026-07-05 (U4/U5/U6 blocked) |
| ~~7~~ | ~~Integration~~ | ~~2~~ | ~~P7~~ | ✅ Completed 2026-07-05 (P9 blocked) |
| ~~8~~ | ~~FE~~ | ~~2~~ | ~~U7, U8~~ | ✅ Completed 2026-07-06 |
| ~~9~~ | ~~FE~~ | ~~0 new~~ | ~~(cleanup)~~ | ✅ Completed 2026-07-06 |
| ~~10~~ | ~~BE (API Server)~~ | ~~1~~ | ~~P11~~ | ✅ Completed 2026-07-08 |
| ~~11~~ | ~~SDK + CLI~~ | ~~2~~ | ~~P13, P15~~ | ✅ Completed 2026-07-08 |
| ~~12~~ | ~~CP~~ | ~~4~~ | ~~P12, P14, P16, P17~~ | ✅ Completed 2026-07-08 |
| ~~13~~ | ~~Examples + Manifests~~ | ~~4~~ | ~~P18, P19, P20, P21~~ | ✅ Completed 2026-07-08 |
| ~~14~~ | ~~BE (RBAC)~~ | ~~2~~ | ~~S13, S14~~ | ✅ Completed 2026-07-08 |
| ~~15~~ | ~~Tests + CLI~~ | ~~2~~ | ~~P28, P29~~ | ✅ Completed 2026-07-16 |
| ~~16~~ | ~~SDK~~ | ~~1~~ | ~~P28~~ | ✅ Completed 2026-07-18 |
| ~~17~~ | ~~CP~~ | ~~2~~ | ~~P29, P30~~ | ✅ Completed 2026-07-18 |


**Partials** (S9, S10, S11, P1, P9) are low-severity and can be addressed opportunistically.

Gateway-related gaps (P11-P20, P31-P43) removed — gateway operations now owned by HyperShell project.

---

## How to Use This File

### As an agent running `/reconcile`

1. Read this file first. If the gap table is populated and `Last analyzed` is
   recent, skip to Phase 5 (wave planning) or Phase 6 (execution).
2. If specs or code have changed since `Last analyzed`, re-run Phase 3 (gap
   analysis) for affected specs only. Update the gap table in place.
3. After executing a wave, update: move completed items to the history section,
   update coverage numbers, update `Last analyzed` date and commit hash.
4. Commit this file with the wave's code changes so the next session sees the
   updated state.

### As a human

- Read the coverage summary to see where the project stands.
- Read the gap table to see what's missing and at what severity.
- Read divergences to see where spec and code intentionally disagree.
- Run `/reconcile --dry-run` to refresh the gap table against current code.

### Keeping it current

- After merging a PR that closes gaps, run `/reconcile --dry-run` to refresh.
- After adding or modifying a spec, run `/reconcile --dry-run` to detect new gaps.
- The agent updates this file in-place. Git history tracks coverage over time.

---

## Reconciliation History

| Date | Commit | Action | Coverage | Notes |
|------|--------|--------|----------|-------|
| 2026-07-05 | 999f1f06 | Initial dry-run gap analysis | 82.3% | 29 specs, 248 requirements, 24 missing, 20 partial |
| 2026-07-05 | (pending) | Divergences D1/D2/D3 resolved -- specs updated | 82.3% | gateway-rbac-policy.spec.md renamed to OpenShell RBAC, data-model matrix corrected |
| 2026-07-05 | (pending) | Wave 2 executed: P5, P6, U2(BE) | 84.5% | 3 API gaps closed. Bug fix: agents/subresource_handler.go scope_id→agent_id |
| 2026-07-05 | (pending) | Wave 4 executed: S1,S2,S3,S4,S5,S7,S8,P10 | 87.1% | 8 gaps closed (5 implemented, 3 already done). P1,S6 deferred. |
| 2026-07-05 | (pending) | Wave 5 executed: P2,P4,P8 | 88.3% | 3 gaps closed. SDK Sync/Refresh, runner compression, RESUME_AFTER_SEQ. |
| 2026-07-05 | (pending) | Wave 6 executed: P3,U1,U2(UI),U3 | 89.9% | 4 gaps closed. Application CRUD UI, folder tree, transfer ownership UI, sole-owner tooltip. U4/U5/U6 blocked on backend. |
| 2026-07-05 | (pending) | Wave 7 executed: P7 | 90.3% | SSE stream forwarding implemented in MCP watch tool. P9 blocked on api-server plugin. |
| 2026-07-05 | (pending) | E2E validation: Kind deploy + LLM round-trip | 90.3% | All 3 components rebuilt and deployed to Kind. LLM round-trip confirmed: Hello world + 2+2=4. |
| 2026-07-06 | 2213d3cc | Wave 8 executed: U7, U8 + OpenShell cleanup | 90.7% | Sidebar label → "Config". Gear icon in nav header. Removed non-OpenShell dual-mode paths, GitOps info boxes, "Generate YAML" button labels. |
| 2026-07-06 | 1fbebf75 | Wave 9: FE consistency + type safety | 90.7% | Dynamic lifecycle badges for providers/policies (was hardcoded GitOps). Narrow YAML input types (AgentYamlInput, ProviderYamlInput, PolicyYamlInput). Removed namespace fields from all create sheets (inherited from project). Renamed configmap-yaml-preview → yaml-preview. Provider types narrowed to github/vertex/generic. Image field disabled (coming soon). All buttons → "Generate X Manifest". |
| 2026-07-07 | 8d5903d3 | Git repo payload support: P11,P13 done, P12 partial | 89.6% | go-git clone + tar SSH delivery, failSession condition fix, UI SandboxFailure title. 3 new reqs tracked (251 total). |
| 2026-07-08 | 8fb60a30 | PR #281 reconciliation: gap analysis | 86.9% | PR #281 merged: gateway-provisioning spec rewritten from ConfigMap to API-driven `kind: Gateway`. 11 new gaps (P11-P21), 3 divergences resolved (D1-D3), 1 new divergence (D4). Waves 10-13 planned for Gateway API resource implementation. |
| 2026-07-08 | (pending) | Wave 10 executed: P11 | 87.3% | Gateway API resource fully implemented: plugin (model, DAO, service, handler, presenter, migration, mock), OpenAPI spec, SDK codegen (Go/Python/TypeScript). `go vet ./...` clean, `golangci-lint run` 0 issues. |
| 2026-07-08 | (pending) | Wave 11 executed: P13, P15 | 88.0% | Shared kustomize library extracted to `ambient-sdk/go-sdk/kustomize/`. CLI refactored to use shared library. Gateway kind added to `acpctl apply` with reconcile semantics. |
| 2026-07-08 | (pending) | Wave 12 executed: P12, P14, P16, P17 | 89.6% | GatewayReconciler created (polling pattern, 30s ticker). ConfigMap-based provisioning eliminated. Manifests and validation consumed by new reconciler. `go build ./...` clean. |
| 2026-07-08 | (pending) | Wave 13 executed: P18, P19, P20, P21 | 91.1% | Gateway overlay examples added. Failure handling with annotation-based status tracking. platform-config.yaml removed from kind and hcmais-dev overlays. ProjectReconciler ordering verified as already enforced. |
| 2026-07-08 | (pending) | Wave 14 executed: S13, S14 | 91.9% | Provider/Gateway RBAC fix: added ResourceProvider/ResourceGateway to permissions.go, isListEndpoint allowlist, role permissions migration (202607080001). Provider handler hardened: SQL injection fix (TSLEqual), ApplyListFilter, input validation (validIDPattern), CheckEditorTier on writes. Tests added. |
| 2026-07-16 | 40b550a7 | Wave 15 executed: P28, P29 | 92.2% | openshell-cli-e2e-test spec fully implemented. E2E test script (8 sections, 37 scenarios) and tmux demo script created. Coverage up from 91.9% to 92.2%. |
| 2026-07-18 | (pending) | Waves 15-16 executed: P28, P29, P30 | 92.0% | SDK generator extended for action response schemas (`status`/`heartbeat` knownActions, `ResponseSchema` types). ClusterHealthSyncer reconciler (30s polling, heartbeat probing). PlacementStrategy interface + RoundRobinPlacement (role filtering, label matching, heartbeat threshold). |
| 2026-07-20 | 922dbc40 | Spec consolidation pass | 91.6% | 3 gateway specs (gateway-provisioning, gateway-oidc, gateway-route-exposure) consolidated into openshell-gateway.spec.md (45 reqs). project-gateway-lifecycle.spec.md added (6 reqs). 13 new done entries (P31-P38, P42-P43, cert-manager, OIDC, route exposure, SCC). 3 new missing gaps (P39 database provisioning, P40 cross-cluster exposure, P41 E2E test). CI: test-local-dev-simulation removed from workflows. |
