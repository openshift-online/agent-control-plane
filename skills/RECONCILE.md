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
│   └── kind/              # Kind with OpenShell gateway mode
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

**Last analyzed**: 2026-07-08 (PR #281 gateway spec reconciliation)
**Spec corpus**: 29 specs across 4 domains
**Codebase commit**: 8fb60a30 (reconcile/pr-281-gateway-spec-changes branch)

### Coverage Summary

| Domain | Specs | Requirements | Present | Partial | Missing | Coverage |
|--------|-------|-------------|---------|---------|---------|----------|
| Platform | 12 | 121 | 116 | 1 | 4 | 95.9% |
| Security | 6 | 55 | 45 | 5 | 5 | 81.8% |
| UI | 7 | 70 | 62 | 6 | 2 | 88.6% |
| CLI | 1 | 13 | 13 | 0 | 0 | 100% |
| **TOTAL** | **29** | **259** | **236** | **12** | **11** | **91.1%** |

### Spec Dependency Order

Reconciliation processes specs in this topological order:

```
Layer 0 (roots):  data-model, identity-boundaries, standards/*
Layer 1:          control-plane, sso-authentication, rbac-enforcement
Layer 2:          runner, agent-sandbox-config, credential-binding, gateway-rbac-policy
Layer 3:          gateway-provisioning, credential-encryption, openshell-sandbox
Layer 4:          openshell-sandbox-provisioning, agent-inheritance
Layer 5:          scheduled-session-execution, session-activity-tracking, mcp-server
Layer 6 (leaves): architecture, annotations, views, live-preview, project-sharing,
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
| S4 | gateway-rbac | Platform-info endpoint authentication | BE | **done** | critical | Converted from `RegisterPreAuthMiddleware` to `RegisterRoutes` with `AuthenticateAccountJWT`. |
| S5 | identity-boundaries | Cluster-internal caller validation | BE | **done** | critical | `GetToken` handler now requires `IsServiceCaller` or `IsGlobalAdmin`. |
| S6 | sso-authentication | K8s Impersonation headers | BE | missing | major | Backend doesn't implement `Impersonate-User`/`Impersonate-Group` headers. Deferred since API server uses PostgreSQL not K8s CRs. |
| S7 | credential-binding | Duplicate binding prevention at API level | BE | **done** | major | Already implemented: UNIQUE index `idx_role_bindings_unique` + `HandleCreateError` returns 409 Conflict. |
| S8 | gateway-rbac | Role-to-tier enforcement in handlers | BE | **done** | major | Shared `CheckEditorTier`/`CheckAdminTier` in `pkg/gateway/`. Integrated into agent, session, scheduled session handlers. |
| S9 | sso-authentication | API key dual-path (JWT + TokenReview) | BE | partial | major | JWT auth present. K8s TokenReview fallback for SA tokens not implemented. |
| S10 | rbac-enforcement | gRPC watch idle timeout | BE | partial | minor | gRPC interceptor populates AuthResult but no idle timeout for watch streams. |
| S11 | sso-authentication | E2E test auth helper | Tests | partial | minor | Keycloak client_credentials flow exists in CLI. No E2E test helper using Kind Keycloak. |
| S12 | identity-boundaries | Build agent SA scoping | Manifests | missing | minor | `ambient-agent` SA for OpenShift build workflows not implemented. Future feature. |

### Platform Gaps

| ID | Spec | Requirement | Layer | Status | Severity | Notes |
|----|------|-------------|-------|--------|----------|-------|
| P1 | data-model | Application GitOps sync engine | CP | partial | critical | Only syncs Agent kind. Missing: Project, Credential, RoleBinding, Inbox sync. No kustomize rendering, auto_sync, self_heal, per-resource status. |
| P11 | gateway-provisioning | Gateway as API Resource (DB, REST, gRPC) | BE | **done** | blocker | Gateway plugin implemented: model, DAO, service, handler, presenter, migration, mock DAO, OpenAPI spec. Project-scoped CRUD under `/projects/{id}/gateways`. RBAC tier checks, jsonb fields (server_dns_names, labels, annotations). SDKs generated (Go, Python, TypeScript). |
| P12 | gateway-provisioning | GatewayReconciler in internal/reconciler/ | CP | **done** | blocker | `gateway_reconciler.go` created with polling pattern (30s ticker). Lists all projects, lists gateways per project, reconciles via existing `ReconcileGateways`. Wired into `main.go` replacing `initGatewayProvisioning`. |
| P13 | gateway-provisioning | Shared Kustomize Library | SDK | **done** | blocker | Extracted kustomize engine from `acpctl apply/cmd.go` into `ambient-sdk/go-sdk/kustomize/kustomize.go`. Exports: Resource, PayloadDecl, InboxSeed types; LoadKustomize, LoadFile, LoadDir, ParseManifests, MergeResources, ApplyPatch, StrategicMerge functions. CLI refactored to use shared library. |
| P14 | gateway-provisioning | Elimination of ConfigMap-Based Provisioning | CP | **done** | critical | ConfigMap loading/watching functions removed from `config.go` (only type defs remain). `initGatewayProvisioning` removed from `main.go`. `setOwnerReference` removed from `reconciler.go`. `platformConfigCM` parameter eliminated from `ReconcileGateways`/`deployGateway`. `config_test.go` deleted. |
| P15 | gateway-provisioning | Gateway kind in acpctl apply | CLI | **done** | critical | Added `case "gateway"` to apply switch. `applyGateway` reconciles create/update with `buildGatewayPatch`. Resource struct includes `ServerDnsNames`, `Image`, `Config`. `strategicMerge` handles Gateway fields. |
| P16 | gateway-provisioning | Gateway Manifest Templating | CP | **done** | major | `internal/gateway/manifests.go` consumed by new `GatewayReconciler` via `gateway.LoadGatewayManifests` and `gateway.ReconcileGateways` which calls `ApplyManifestToNamespace` and `ApplyConfigOverrides`. |
| P17 | gateway-provisioning | Gateway Configuration Validation | CP | **done** | major | `internal/gateway/validation.go` consumed by `GatewayReconciler.reconcileGateway` — calls `gateway.ValidateGatewayConfig` before reconciling, skips invalid gateways with warning log. |
| P18 | gateway-provisioning | Kustomize Overlay Structure for Gateways | Examples | **done** | major | `examples/base/gateways/openshell-gateway.yaml` with `kind: Gateway`, image, server_dns_names, labels. `examples/base/gateways/kustomization.yaml`. Base kustomization updated. |
| P19 | gateway-provisioning | Gateway Deployment Failure Handling | CP | **done** | major | GatewayReconciler tracks per-gateway failures, updates `ambient.ai/reconcile-status` and `ambient.ai/last-reconciled-at` annotations on Gateway resources. Validation failures annotated as `ValidationFailed`. Reconcile loop counts and warns on partial failures. |
| P20 | gateway-provisioning | platform-config ConfigMap overlays removal | Manifests | **done** | minor | Deleted `platform-config.yaml` from `overlays/kind/` and `overlays/hcmais-dev/`. Removed references from both `kustomization.yaml` files. |
| P21 | control-plane | ProjectReconciler namespace lifecycle | CP | **done** | minor | Ordering already enforced: informer `initialSync` syncs `projects` before `sessions`, and `RegisterHandler` in main.go registers ProjectReconciler first. ProjectReconciler runs `ensureNamespace()` which creates namespaces before session reconcilers attempt to use them. |
| P22 | data-model | `acpctl apply` missing `sandbox_policy`, `sandbox_template`, `entrypoint` on Agent | CLI | missing | critical | `resource` struct and `buildAgentPatch()` in `apply/cmd.go` silently drop these fields during YAML parsing. API server and SDK fully support them. New deployments cannot declaratively set sandbox policies on agents. |
| P23 | data-model | `acpctl apply` missing `Policy` as supported kind | CLI | missing | critical | Policy has full CRUD in API server (`plugins/policies/`) and SDK (`Policys()` client) but is not in the `apply` dispatch switch. Policies must be created via REST API instead of declarative YAML. |
| P2 | data-model | Application CLI sync/refresh commands | CLI | **done** | major | SDK `Sync()`/`Refresh()` methods added. CLI calls `POST /sync` and `POST /refresh`. Flags: `--prune`, `--revision`, `--prune-project`. |
| P3 | data-model | Application frontend UI | FE | **done** | major | Full CRUD UI: domain types, port, adapter, mapper, query hooks, list page, detail page. Gated behind `feature.applications.enabled` flag. |
| P4 | data-model | SessionEvent runner-side compression | Runner | **done** | major | `EventCompressor` integrated into gRPC transport path. Compressed events pushed to `session_events.push()` with `event_count` and `completed_at`. |
| P5 | data-model | Scoped RoleBinding query endpoints | BE | **done** | major | 4 new scoped endpoints: `/users/{id}/role_bindings`, `/projects/{id}/role_bindings`, `/sessions/{id}/role_bindings`, `/credentials/{cred_id}/role_bindings`. |
| P6 | data-model | GET /applications/{id}/status endpoint | BE | **done** | major | Added `GetStatus` handler + `ApplicationStatusResponse` presenter. Also fixed `LastSyncedAt` in main presenter. |
| P7 | mcp-server | watch_session_messages SSE forwarding | MCP | **done** | major | SSE client added to MCP client. `WatchSessionMessages` opens SSE stream, forwards events as `notifications/progress`, polls session phase every 5s, auto-terminates on completion. |
| P8 | control-plane | RESUME_AFTER_SEQ env var | CP | **done** | minor | CP queries max seq via `SessionMessages().List()` on resume. Sets `RESUME_AFTER_SEQ` env var. Runner uses seq-based filtering with time-based fallback. |
| P9 | mcp-server | MCP HTTP endpoint in api-server | BE | partial | minor | Blocked: needs new api-server plugin, process spawning, `openapi.mcp.yaml`. Token exchange client exists in ambient-mcp. |
| P10 | scheduled-session | Idempotency UNIQUE constraint | BE | **done** | minor | Verified: UNIQUE index `idx_sessions_schedule_idempotency` exists in migration 202606230002. |

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
| D1 | gateway-rbac | Gateway mode activation | Hardcoded `true` in `IsGatewayModeActive()` | ~~Env-var gated~~ → Always-active | **Resolved in PR #281**: Spec updated to match code (always-active). |
| D2 | gateway-rbac | Agent CRUD gating | CRUD permitted; tests verify it is NOT blocked | ~~403 for CRUD~~ → CRUD permitted via API | **Resolved in PR #281**: Spec updated to match code. |
| D3 | data-model | Implementation coverage matrix | Application CRUD, credential bind, Events API implemented | ~~"planned"~~ → Matrix corrected | **Resolved in PR #281**: Spec matrix updated. |
| D4 | gateway-provisioning | ConfigMap vs API-driven gateway | ~~Code uses ConfigMap-based `platform-config`~~ | API-driven `kind: Gateway` resource | **Resolved**: Code migrated to API-driven Gateway (P11-P14). ConfigMap provisioning removed. |

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

**Partials** (S9, S10, S11, P1, P9) are low-severity and can be addressed opportunistically.

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
| 2026-07-08 | 8fb60a30 | PR #281 reconciliation: gap analysis | 86.9% | PR #281 merged: gateway-provisioning spec rewritten from ConfigMap to API-driven `kind: Gateway`. 11 new gaps (P11-P21), 3 divergences resolved (D1-D3), 1 new divergence (D4). Waves 10-13 planned for Gateway API resource implementation. |
| 2026-07-08 | (pending) | Wave 10 executed: P11 | 87.3% | Gateway API resource fully implemented: plugin (model, DAO, service, handler, presenter, migration, mock), OpenAPI spec, SDK codegen (Go/Python/TypeScript). `go vet ./...` clean, `golangci-lint run` 0 issues. |
| 2026-07-08 | (pending) | Wave 11 executed: P13, P15 | 88.0% | Shared kustomize library extracted to `ambient-sdk/go-sdk/kustomize/`. CLI refactored to use shared library. Gateway kind added to `acpctl apply` with reconcile semantics. |
| 2026-07-08 | (pending) | Wave 12 executed: P12, P14, P16, P17 | 89.6% | GatewayReconciler created (polling pattern, 30s ticker). ConfigMap-based provisioning eliminated. Manifests and validation consumed by new reconciler. `go build ./...` clean. |
| 2026-07-08 | (pending) | Wave 13 executed: P18, P19, P20, P21 | 91.1% | Gateway overlay examples added. Failure handling with annotation-based status tracking. platform-config.yaml removed from kind and hcmais-dev overlays. ProjectReconciler ordering verified as already enforced. |
