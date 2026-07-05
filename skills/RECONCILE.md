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
    └── memory/            # Project memory management
```

**SDLC flow**: `/reconcile` → `/spec` → `/full-stack-pipeline` → `/dev-cluster` → `/pr-test` → `/deploy-cluster`

---

## Reconciliation State

**Last analyzed**: 2026-07-05 (divergences resolved)
**Spec corpus**: 29 specs across 4 domains
**Codebase commit**: 999f1f06 (main)

### Coverage Summary

 < /dev/null |  Domain | Specs | Requirements | Present | Partial | Missing | Coverage |
|--------|-------|-------------|---------|---------|---------|----------|
| Platform | 12 | 110 | 97 | 5 | 8 | 88.2% |
| Security | 6 | 55 | 38 | 7 | 10 | 69.1% |
| UI | 7 | 70 | 56 | 8 | 6 | 80.0% |
| CLI | 1 | 13 | 13 | 0 | 0 | 100% |
| **TOTAL** | **29** | **248** | **204** | **20** | **24** | **82.3%** |

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
| S1 | identity-boundaries | Per-session RBAC Roles with resourceNames | CP | missing | blocker | Sessions can read other sessions' secrets in same namespace. No K8s Role/RoleBinding scoping per session SA. |
| S2 | credential-binding | credential:token-reader grant lifecycle | CP | missing | blocker | CP doesn't create/revoke `credential:token-reader` RoleBindings per session. Credentials resolved via env vars instead. |
| S3 | identity-boundaries | NetworkPolicy session isolation | CP | missing | blocker | No pod-to-pod network isolation between sessions in same namespace. |
| S4 | gateway-rbac | Platform-info endpoint authentication | BE | missing | critical | `/api/ambient/v1/platform-info` uses pre-auth middleware, bypasses JWT. Spec now requires authentication (401 for unauthenticated). |
| S5 | identity-boundaries | Cluster-internal caller validation | BE | missing | critical | No mechanism prevents external callers from reaching runner credential endpoints with valid token. |
| S6 | sso-authentication | K8s Impersonation headers | BE | missing | major | Backend doesn't implement `Impersonate-User`/`Impersonate-Group` headers. Deferred since API server uses PostgreSQL not K8s CRs. |
| S7 | credential-binding | Duplicate binding prevention at API level | BE | missing | major | Spec requires rejecting duplicate bindings at same scope for same provider. No validation in RoleBinding handler. |
| S8 | gateway-rbac | Role-to-tier enforcement in handlers | BE | partial | major | `TierResolver` exists with correct tiers but not integrated into handler-level access enforcement. |
| S9 | sso-authentication | API key dual-path (JWT + TokenReview) | BE | partial | major | JWT auth present. K8s TokenReview fallback for SA tokens not implemented. |
| S10 | rbac-enforcement | gRPC watch idle timeout | BE | partial | minor | gRPC interceptor populates AuthResult but no idle timeout for watch streams. |
| S11 | sso-authentication | E2E test auth helper | Tests | partial | minor | Keycloak client_credentials flow exists in CLI. No E2E test helper using Kind Keycloak. |
| S12 | identity-boundaries | Build agent SA scoping | Manifests | missing | minor | `ambient-agent` SA for OpenShift build workflows not implemented. Future feature. |

### Platform Gaps

| ID | Spec | Requirement | Layer | Status | Severity | Notes |
|----|------|-------------|-------|--------|----------|-------|
| P1 | data-model | Application GitOps sync engine | CP | partial | critical | Only syncs Agent kind. Missing: Project, Credential, RoleBinding, Inbox sync. No kustomize rendering, auto_sync, self_heal, per-resource status. |
| P2 | data-model | Application CLI sync/refresh commands | CLI | partial | major | `sync` does no-op PATCH. `refresh` returns current state without git fetch. |
| P3 | data-model | Application frontend UI | FE | missing | major | No pages, adapters, queries, or domain types for Application entity. |
| P4 | data-model | SessionEvent runner-side compression | Runner | missing | major | Schema/API/gRPC/SDK support compression fields. Runner doesn't compress -- all events stored with event_count=1. |
| P5 | data-model | Scoped RoleBinding query endpoints | BE | missing | major | Only agent-scoped list exists. Missing: by-user, by-project, by-session, by-credential (4 endpoints). |
| P6 | data-model | GET /applications/{id}/status endpoint | BE | missing | major | Spec defines dedicated status endpoint. Status only available on main GET. |
| P7 | mcp-server | watch_session_messages SSE forwarding | MCP | partial | major | Tool returns subscription_id. Actual SSE stream forwarding is stubbed (`_ = c`). |
| P8 | control-plane | RESUME_AFTER_SEQ env var | CP | missing | minor | Spec defines it for session restart. Not found in codebase. |
| P9 | mcp-server | MCP HTTP endpoint in api-server | BE | partial | minor | `tokenexchange/` dir exists in ambient-mcp. Proxy route registration in api-server unverified. |
| P10 | scheduled-session | Idempotency UNIQUE constraint | BE | partial | minor | Fields set on created session. UNIQUE(source_scheduled_session_id, scheduled_for) constraint in migration unverified. |

### UI Gaps

| ID | Spec | Requirement | Layer | Status | Severity | Notes |
|----|------|-------------|-------|--------|----------|-------|
| U1 | views | Virtual folder tree (ui/path annotation) | FE | missing | major | Annotation key registered but no tree panel component exists. |
| U2 | project-sharing | Ownership transfer | FE+BE | missing | major | No `POST /projects/{id}/transfer-ownership` endpoint or UI action. |
| U3 | project-sharing | Self-removal ("Leave project") | FE | missing | major | No leave-project flow in collaborator manager. |
| U4 | views | Settings: API Keys tab | FE | missing | minor | No API key management UI in settings page. |
| U5 | views | Settings: Feature Flags tab | FE | missing | minor | `use-feature-flags-admin.ts` hook exists. No UI tab. |
| U6 | live-preview | SSE fallback indicator | FE | missing | minor | No "stream unavailable" status when runner unreachable. |
| U7 | architecture | Sidebar "Configure" group label | FE | partial | minor | Uses "Admin" label. Settings in separate "Project" group instead of "Configure". |
| U8 | project-sharing | Settings access via gear icon | FE | partial | minor | Settings is sidebar nav item, not gear icon in nav header per spec. |

### Divergences (Require Human Decision)

These items intentionally differ from spec. Decision needed: update spec or update code?

| ID | Spec | Issue | Current Code | Spec Says |
|----|------|-------|-------------|-----------|
| D1 | gateway-rbac | Gateway mode activation | Hardcoded `true` in `IsGatewayModeActive()` | Env-var gated: `OPENSHELL_USE_GATEWAY=true AND OPENSHELL_ENABLED=true` |
| D2 | gateway-rbac | Agent CRUD gating | CRUD permitted; tests verify it is NOT blocked | 403 for create/update/delete in gateway mode |
| D3 | data-model | Implementation coverage matrix | Application CRUD, credential bind, Events API implemented | Matrix says "planned" / "not yet implemented" |

---

## Wave Plan

Gaps grouped by execution wave. Each wave gates the next.

| Wave | Layer | Items | IDs | Gate |
|------|-------|-------|-----|------|
| 2 | API | 3 | P5, P6, U2 (endpoint) | `make lint` on API server |
| 4 | BE + CP | 10 | S1, S2, S3, S4, S5, S7, S8, P1, P10, S6 | `go vet ./... && golangci-lint run` |
| 5 | CLI + Runner | 3 | P2, P4, P8 | CLI tests, `python -m pytest tests/` |
| 6 | FE | 7 | P3, U1, U2 (UI), U3, U4, U5, U6 | `npm run build` -- 0 errors |
| 7 | Integration | 2 | P7, P9 | MCP tool test in Kind |

**Partials** (U7, U8, S9, S10, S11) are low-severity and can be addressed opportunistically.

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
