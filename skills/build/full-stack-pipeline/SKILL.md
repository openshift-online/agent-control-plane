---
name: full-stack-pipeline
description: >
  Autonomous workflow for implementing spec-driven changes across the Ambient platform.
  Orchestrates gap analysis, wave-based execution, and cross-component integration.
  Use when: "implement this spec", "build this feature end-to-end", "run the pipeline",
  "gap analysis", "what waves do we need", "full-stack change".
---

# Full-Stack Pipeline

Implement spec-driven changes across all Ambient platform components using a wave-based pipeline.

## User Input

```text
$ARGUMENTS
```

## The Pipeline

Changes flow downstream in a fixed dependency order:

```
Spec (ambient-model.spec.md)
  └─► API (openapi.yaml)
        └─► SDK Generator
              └─► Go SDK (types, builders, clients)
                    ├─► BE  (REST handlers, DAOs, migrations)
                    ├─► CLI (commands, output formatters)
                    ├─► CP  (gRPC middleware, interceptors)
                    ├─► Control Plane (gRPC reconciler, Job spawning)
                    ├─► Runners (Python SDK calls, gRPC push)
                    └─► FE  (TypeScript API layer, UI components)
```

Each stage depends on the stage above it being settled.

## Workflow Steps

### Step 1 — Acknowledge Iteration

Before doing anything, internalize that this run may not succeed. The workflow is the product. If a step fails, capture the failure and what the step actually requires, then retry.

Checklist:

- [ ] Read the spec in full
- [ ] Confirm you are on the correct branch and project
- [ ] Verify the kind cluster name: `podman ps  < /dev/null |  grep kind`

### Step 2 — Read the Spec

Read the relevant spec in full. Extract and hold in working memory:

- All entities and their fields
- All relationships and API routes
- CLI table (implemented / planned)
- Design decisions
- Session start context assembly order

This is the **desired state**. Everything else is measured against it.

### Step 3 — Assess What Has Changed (Gap Analysis)

Compare the spec against the current state of the code. For each component:

| Component    | What to check |
| ------------ | ------------- |
| **API**      | Does `openapi/openapi.yaml` have all spec entities, routes, and fields? Check schema `required[]` arrays field-by-field. |
| **SDK**      | Do generated types/builders/clients exist for all spec entities? |
| **BE**       | Read `plugins/<kind>/model.go` for every Kind. Compare field-by-field against the Spec. |
| **CP**       | Does middleware handle new RBAC scopes and auth requirements? |
| **CLI**      | Does `acpctl` implement every route marked implemented in the spec CLI table? |
| **Operator** | Does the control plane handle Agent-scoped session start? |
| **Runners**  | Does the runner drain inbox at session start and push correct event types? |
| **FE**       | Do API service layer, queries, and components exist for all new entities? Run the ui-audit skill. |

Check all three directions for every Kind:
1. Spec ERD → `model.go` — spec says field exists; is it in the model?
2. `model.go` → Spec ERD — model has a field; is it documented in the spec?
3. OpenAPI `required[]` → Spec ERD — OpenAPI marks it required; does the spec agree?

Produce a gap table:

```
ENTITY          COMPONENT   STATUS      GAP
Agent           API         missing     no routes in openapi.yaml
Agent           SDK         missing     no generated type
Session.prompt  BE          present     —
```

### Step 4 — Break Into Waves

**Wave 1 — Spec consensus** (no code; human approval)
- Confirm gap table is complete and agreed upon
- Freeze spec for this run

**Wave 2 — API** (gates everything downstream)
- Update `openapi/openapi.yaml` for all new entities and routes
- Register routes in `routes.go`; add handler stubs
- Security gate: new routes use `environments.JWTMiddleware`; no user token logged
- Acceptance: `make test`, `make binary`, `make lint` clean

**Wave 3 — SDK** (gates BE, CLI, FE)
- Run SDK generator against updated `openapi.yaml`
- Commit generated types, builders, client methods
- Verify TS and Python client paths for nested resources
- Acceptance: `go build ./...` clean; Python SDK tests pass

**Wave 4 — BE + CP** (parallel after Wave 3)
- BE: migrations, DAOs, service logic, gRPC presenters
- CP: runner fan-out compatibility verified (see CP-Runner contract below)
- Security gate: all handler paths check user token; no tokens in logs
- Acceptance: `make test`, `go vet ./... && golangci-lint run` clean

**Wave 5 — CLI + Operator + Runners** (parallel after Wave 3 + BE)
- CLI: implement all planned commands
- Control Plane: reconciler updates
- Runners: inbox drain at session start, correct event types
- Security gate: Job pods set restricted SecurityContext; OwnerReferences on all child resources
- Acceptance: CLI tests pass; Runner tests pass; tested in kind cluster

**Wave 6 — FE** (after Wave 4 BE)
- API service layer and React Query hooks for new entities
- UI components
- Security gate: no tokens in frontend state or logs
- Acceptance: `npm run build` — 0 errors, 0 warnings

**Wave 7 — Integration**
- End-to-end smoke test
- `make test` and `make lint` across all components
- Push new image to kind cluster

Each wave is a gate. Do not start downstream work against an unstable upstream.

### Step 5 — Verify Each Wave

After each wave:
- Re-run the gap table for that component only
- If gaps remain, return to Step 4 for that wave
- If clean, mark complete and proceed

## CP-Runner Compatibility Contract

The Control Plane is a fan-out multiplexer between the api-server and runner pods. Preserve these invariants:

| Concern | Runner expects | CP must preserve |
|---|---|---|
| Session start | Job pod scheduled by operator | CP does not reschedule |
| Event emission | Runner pushes AG-UI events via gRPC | CP forwards in order, never drops |
| `RUN_FINISHED` | Emitted once at end | CP forwards exactly once |
| `MESSAGES_SNAPSHOT` | Emitted periodically | CP forwards in order |
| Token | Runner receives token from K8s secret | CP does not touch runner token |

Runner compat test before any CP PR:
```bash
acpctl create session --project my-project --name test-cp "echo hello"
acpctl session messages -f --project my-project test-cp
```

## Constraints

- **Pipeline order is strict**: no downstream wave starts until upstream is merged and SDK is regenerated
- **One active session per wave**: runs to completion before next wave begins
- **Spec is frozen during execution**: queue changes for next cycle
- **PRs are atomic per wave per component**: one PR per agent per wave
- **Agents stay in their lane**: cross-component edits require a spec change and new wave assignment

## Code Generation

All new Kinds must use the generator in `components/ambient-api-server/templates/`:

```bash
go run ./scripts/generator.go \
  --kind Agent \
  --fields "project_id:string:required,name:string:required,prompt:string" \
  --project ambient \
  --repo github.com/ambient-code/platform/components \
  --library github.com/openshift-online/rh-trex-ai
```

## SDK Generator Pitfalls

- **Nested resource base path (TS + Python):** Generator uses first path segment as base — wrong for nested resources. Write hand-crafted extension files.
- **Auxiliary DTO schemas:** Must live in `openapi.yaml` main components, not sub-spec files. Generator picks schemas alphabetically; if first candidate lacks `allOf`, parse fails.
- **Generated handler variable names:** `mux.Vars` key must match route variable name. Nested routes use `{msg_id}`, not `{id}`.
- **Generated middleware import:** Must use `environments.JWTMiddleware`, not `auth.JWTMiddleware`.
- **Top-level resource paths:** Generator does NOT produce `basePath()` for non-nested resources — it inlines paths. Update extension files accordingly.

## Known Code Invariants

- **gRPC presenter completeness:** `sessionToProto()` must map every field in both DB model and proto message
- **Inbox handler scoping:** List must always inject `agent_id` from URL; never return cross-agent data
- **Inbox handler agent_id enforcement:** Create must set `agent_id` from URL, ignoring request body
- **InboxMessagePatchRequest scope:** Only `Read *bool` is permitted
- **StartResponse field name:** `ignition_prompt` is canonical across openapi, Go SDK, TS SDK
- **Start HTTP status:** 201 on new session creation, 200 when already active
- **Nested resource URL encoding:** Use `encodeURIComponent` (TS) / `url.PathEscape` (Go) on every path segment
- **Proto field addition:** Edit `.proto` → `make proto` → verify `*.pb.go` → wire through presenter
- **Step 3 must be field-level:** Route existence is necessary but not sufficient; field-level drift is the most common gap

## Mandatory Image Push Playbook

After every wave, push images before testing:

```bash
CLUSTER=$(podman ps --format '{{.Names}}' | grep 'kind' | grep 'control-plane' | sed 's/-control-plane//')
podman build --no-cache -t localhost/acp_api_server:latest components/ambient-api-server
podman save localhost/acp_api_server:latest | \
  podman exec -i ${CLUSTER}-control-plane ctr --namespace=k8s.io images import -
kubectl rollout restart deployment/ambient-api-server -n ambient-code
kubectl rollout status deployment/ambient-api-server -n ambient-code --timeout=60s
```

---

## Scaffolding (from plan/scaffold)

Generate the complete file set for a new integration, endpoint, or feature flag.

## Usage

```bash
/scaffold integration <name>    # Full integration scaffold
/scaffold endpoint <name>       # API endpoint scaffold
/scaffold feature-flag <name>   # Feature flag scaffold (delegates to /unleash-flag)
```

## Integration Scaffold

Based on the established integration pattern (Jira, CodeRabbit, Google Drive), generate the full file set.

### Backend Files

| File | Purpose | Template |
|------|---------|----------|
| `components/ambient-api-server/pkg/{provider}_auth.go` | Auth handlers + K8s Secret CRUD | Follow `jira_auth.go` pattern |
| `components/ambient-api-server/pkg/integration_validation.go` | Add validation + test endpoint | Add `Validate{Provider}` function |
| `components/ambient-api-server/pkg/integrations_status.go` | Add to unified status | Add provider to status aggregation |
| `components/ambient-api-server/pkg/runtime_credentials.go` | Session credential fetch with RBAC | Add `fetch{Provider}Credentials` |
| `components/ambient-api-server/pkg/api/` | Register endpoints | Add route group with auth middleware |

### Frontend Files

| File | Purpose | Template |
|------|---------|----------|
| `components/ambient-ui/src/components/integrations/{provider}-connection-card.tsx` | Integration card UI | Follow existing integration card (e.g., Jira) |
| `components/ambient-ui/src/services/api/{provider}-auth.ts` | API client | Follow existing auth service pattern |
| `components/ambient-ui/src/services/queries/use-{provider}.ts` | React Query hooks | Follow existing query hook pattern |
| `components/ambient-ui/src/app/api/auth/{provider}/route.ts` | Next.js proxy route | Follow existing auth proxy |
| `components/ambient-ui/src/components/integrations/IntegrationsClient.tsx` | Add card import | Update imports + render |
| `components/ambient-ui/src/components/integrations/integrations-panel.tsx` | Add to panel | Update panel |

> **Note:** Before scaffolding, verify the reference files exist by checking `components/ambient-ui/src/components/integrations/` and `components/ambient-ui/src/services/`. File names may differ from examples above.

### Runner Files

| File | Purpose | Template |
|------|---------|----------|
| `components/runners/ambient-runner/src/auth.py` | Add `fetch_{provider}_credentials()` | Follow `fetch_jira_credentials` pattern |

### Feature Flag

| File | Purpose |
|------|---------|
| `components/manifests/base/core/flags.json` | Add `integration.{provider}.enabled` |

### Checklist

After scaffolding, verify:

- [ ] All backend handlers use `GetK8sClientsForRequest` for user operations
- [ ] Credentials stored in K8s Secret with OwnerReferences
- [ ] Frontend uses React Query hooks (no manual fetch)
- [ ] Frontend uses Shadcn UI components
- [ ] Feature flag gates the integration card
- [ ] Tests mock the feature flag hook
- [ ] Runner credential fetch is added to `populate_runtime_credentials()`

## Endpoint Scaffold

For adding a new API endpoint with full-stack support.

### Files to Create/Modify

| Layer | File | Action |
|-------|------|--------|
| Backend handler | `components/ambient-api-server/pkg/{resource}.go` | Create |
| Backend routes | `components/ambient-api-server/pkg/api/` | Add routes |
| Backend types | `components/ambient-api-server/types/{resource}.go` | Create if needed |
| Frontend API | `components/ambient-ui/src/services/api/{resource}.ts` | Create |
| Frontend queries | `components/ambient-ui/src/services/queries/{resource}.ts` | Create |
| Frontend proxy | `components/ambient-ui/src/app/api/{resource}/route.ts` | Create |

### Backend Handler Template

```go
func List{Resource}(c *gin.Context) {
    projectName := c.Param("projectName")

    reqK8s, reqDyn := GetK8sClientsForRequest(c)
    if reqK8s == nil || reqDyn == nil {
        c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid or missing token"})
        return
    }

    // RBAC check
    // List operation with reqDyn
    // Return response
}
```

### Frontend Query Template

```typescript
export function use{Resource}(projectName: string) {
  return useQuery({
    queryKey: ["{resource}", projectName],
    queryFn: () => {resource}Api.list(projectName),
  })
}
```

## Feature Flag Scaffold

Delegates to the `/unleash-flag` skill for the full feature flag workflow.

Run `/unleash-flag` with the flag name and follow its checklist.

---

## UI Wave Standards

When implementing Wave 6 (Frontend), the ambient-ui component follows additional standards:

### UI Development Standards

- **Technology:** React/Next.js with shadcn/ui components exclusively
- **Tabs:** Must persist active tab in URL via `?tab=` query parameter
- **No `any` types** -- use proper types, `unknown`, or generics
- **React Query** for all data fetching -- no manual `fetch()` in components
- **`type` over `interface`** always
- **Port/adapter pattern** -- React Query hooks consume port interfaces, not raw API calls
- **Fakes over mocks** in tests

### UI Design System

Typefaces, accessibility requirements, color palette (78 hex values), and color semantics are defined in the [UI Architecture spec](../../../specs/ui/architecture.spec.md#design-system).
