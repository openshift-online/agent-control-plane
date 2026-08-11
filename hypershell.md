# ACP ↔ HyperShell: Gateway Decoupling Plan

## Executive Summary

ACP (Agent Control Plane) and HyperShell are sister projects with a clean ownership split:

- **HyperShell** owns gateway infrastructure — provisioning, lifecycle, TLS, routing, database,
  cluster management, progressive delivery. It exposes gateways as a managed service.
- **ACP** owns the application layer — projects, sessions, agents, providers, policies, runners,
  credentials. It *consumes* HyperShell-managed gateways to run agent sandboxes.

Today ACP acts as both the application layer **and** the gateway operator. It deploys
StatefulSets, generates `gateway.toml` ConfigMaps, runs certgen Jobs, creates Routes and
NetworkPolicies — all ~200 files of gateway infrastructure that now belongs in HyperShell.

This document plans the removal of gateway operations from ACP and the integration of ACP
as a HyperShell consumer. The HyperShell bootstrap (building the new project from scratch)
is tracked separately in the HyperShell repo.

**Repositories:**
- ACP: `~/projects/src/github.com/openshift-online/agent-control-plane`
- HyperShell: `~/projects/src/github.com/openshift-online/hypershell`

---

## Part 1: Ownership Boundary

### What HyperShell Owns (gateway infrastructure)

| Concern | HyperShell Resource | Notes |
|---------|---------------------|-------|
| Gateway lifecycle | Fleet, Gateway, GatewayRelease | StatefulSet, ConfigMap, Service, certgen Job, health monitoring |
| Cluster management | ManagedCluster | Kubeconfig validation, agent installation, capacity reporting |
| Database provisioning | ManagedDatabase | External PG validation, AWS RDS creation |
| TLS bootstrap | GatewayReconciler | certgen Job, `openshell-server-tls`, `openshell-client-tls`, `openshell-gateway-jwt-keys` |
| Routing | GatewayReconciler | GRPCRoute / OpenShift passthrough Route |
| Network isolation | GatewayReconciler | NetworkPolicy (sandbox→gateway, ingress→gateway) |
| RBAC for gateway SA | GatewayReconciler | ServiceAccount, ClusterRole, ClusterRoleBinding |
| Progressive delivery | ReleaseReconciler | Canary state machine, promotion timers |

### What ACP Keeps (application layer)

| Concern | ACP Component | Notes |
|---------|---------------|-------|
| Projects, Sessions, Agents | API server plugins | Core domain, unchanged |
| Providers, Policies | API server plugins | Credential and policy management |
| Sandbox lifecycle | Control plane `kube_reconciler.go` | `CreateSandbox`, `ExecSandbox`, `DeleteSandbox` via gRPC — **interface unchanged, endpoint resolution changes** |
| Provider mapping | `internal/openshell/provider_mapping.go` | Maps ACP provider types to OpenShell provider types |
| Sandbox SSH/upload | `internal/openshell/ssh_upload.go` | Payload upload via gateway relay |
| Runner images | `components/runners/` | `Dockerfile`, `Dockerfile.openshell`, `openshell-claude-wrapper.sh` |
| CLI (acpctl) | `components/ambient-cli/` | Session/agent/project commands — gateway commands removed |
| UI | `components/ambient-ui/` | Session management, sandbox logs — gateway management UI removed |
| SDKs | `components/ambient-sdk/` | Session/agent/project types — gateway types removed |

### The Integration Seam

The `gatewayClient` interface (`internal/reconciler/gateway_iface.go`) is the clean boundary.
It defines 13 gRPC operations (sandbox CRUD, provider management, inference routing, exec,
upload, logs) that work against any OpenShell gateway regardless of who provisioned it.

**Today:** `GatewayClient.gatewayEndpoint(namespace)` constructs
`dns:///openshell-gateway.<namespace>.svc.cluster.local:8080` — ACP deploys the gateway
into the same cluster and connects via in-cluster DNS.

**After:** `GatewayClient` resolves the endpoint from HyperShell's API or from a
project-level `gateway_url` field — the gateway runs on a HyperShell-managed cluster,
and ACP connects via the external Route/Ingress endpoint with HyperShell-issued credentials.

---

## Part 2: ACP Removal Inventory

~200 files across 10 categories. Organized into removal waves.

### Wave 1: Control Plane Gateway Reconciler (delete)

Gateway infrastructure reconciliation — the entire "gateway operator" role.

**Package: `internal/gateway/`** (7 files — delete entire directory)
- `components/ambient-control-plane/internal/gateway/reconciler.go`
- `components/ambient-control-plane/internal/gateway/reconciler_test.go`
- `components/ambient-control-plane/internal/gateway/manifests.go`
- `components/ambient-control-plane/internal/gateway/manifests_test.go`
- `components/ambient-control-plane/internal/gateway/config.go`
- `components/ambient-control-plane/internal/gateway/validation.go`
- `components/ambient-control-plane/internal/gateway/validation_test.go`

**Reconciler integration** (2 files — delete)
- `components/ambient-control-plane/internal/reconciler/gateway_reconciler.go`
- `components/ambient-control-plane/internal/reconciler/gateway_iface.go` — **wait**: the
  interface itself is still used. Only the *gateway infrastructure reconciler* is deleted.
  The `gatewayClient` interface stays because `kube_reconciler.go` uses it for sandbox ops.

**Embedded manifests** (8 files — delete entire directory)
- `components/ambient-control-plane/manifests/gateway/statefulset.yaml`
- `components/ambient-control-plane/manifests/gateway/service.yaml`
- `components/ambient-control-plane/manifests/gateway/configmap.yaml`
- `components/ambient-control-plane/manifests/gateway/certgen-job.yaml`
- `components/ambient-control-plane/manifests/gateway/rbac.yaml`
- `components/ambient-control-plane/manifests/gateway/serviceaccount.yaml`
- `components/ambient-control-plane/manifests/gateway/networkpolicy.yaml`
- `components/ambient-control-plane/manifests/gateway/route.yaml`

**Control plane entry point** (modify)
- `components/ambient-control-plane/cmd/ambient-control-plane/main.go` — remove gateway
  reconciler goroutine, remove `OPENSHELL_GATEWAY_IMAGE` env var, remove gateway manifest
  loading

**TLS resolver** (modify)
- `components/ambient-control-plane/internal/openshell/tls_resolver.go` — change from
  reading per-namespace `openshell-client-tls` secrets to using HyperShell-provided
  credentials

**Gateway client** (modify)
- `components/ambient-control-plane/internal/openshell/gateway_client.go` — change
  `gatewayEndpoint()` to resolve from HyperShell API or project config instead of
  constructing `svc.cluster.local` DNS names

**Placement** (modify or delete)
- `components/ambient-control-plane/internal/placement/strategy.go` — simplify if
  gateway cluster selection moves to HyperShell

**Config** (modify)
- `components/ambient-control-plane/internal/config/config.go` — remove gateway-specific
  env vars (`OPENSHELL_GATEWAY_IMAGE`, gateway sync interval, manifest dir)

**Token server** (evaluate)
- `components/ambient-control-plane/internal/tokenserver/sandbox_handler.go` — may need
  changes if sandbox token issuance changes with HyperShell credentials

### Wave 2: API Server Gateway Plugin (delete)

**Plugin: `plugins/gateways/`** (11 files — delete entire directory)
- `components/ambient-api-server/plugins/gateways/plugin.go`
- `components/ambient-api-server/plugins/gateways/handler.go`
- `components/ambient-api-server/plugins/gateways/service.go`
- `components/ambient-api-server/plugins/gateways/dao.go`
- `components/ambient-api-server/plugins/gateways/model.go`
- `components/ambient-api-server/plugins/gateways/migration.go`
- `components/ambient-api-server/plugins/gateways/presenter.go`
- `components/ambient-api-server/plugins/gateways/mock_dao.go`
- `components/ambient-api-server/plugins/gateways/integration_test.go`
- `components/ambient-api-server/plugins/gateways/factory_test.go`
- `components/ambient-api-server/plugins/gateways/testmain_test.go`

**Gateway package** (5 files — delete entire directory)
- `components/ambient-api-server/pkg/gateway/resolver.go`
- `components/ambient-api-server/pkg/gateway/tier_resolver.go`
- `components/ambient-api-server/pkg/gateway/tier_resolver_test.go`
- `components/ambient-api-server/pkg/gateway/config.go`
- `components/ambient-api-server/pkg/gateway/config_test.go`

**OpenAPI spec** (1 file — delete)
- `components/ambient-api-server/openapi/openapi.gateways.yaml`

**Generated models** (6 files — regenerate after removing gateway spec)
- `components/ambient-api-server/pkg/api/openapi/model_gateway.go`
- `components/ambient-api-server/pkg/api/openapi/model_gateway_database.go`
- `components/ambient-api-server/pkg/api/openapi/model_gateway_list.go`
- `components/ambient-api-server/pkg/api/openapi/model_gateway_oidc.go`
- `components/ambient-api-server/pkg/api/openapi/model_gateway_patch_request.go`
- `components/ambient-api-server/pkg/api/openapi/model_gateway_route.go`

**Generated docs** (6 files — regenerate)
- `components/ambient-api-server/pkg/api/openapi/docs/Gateway.md`
- `components/ambient-api-server/pkg/api/openapi/docs/GatewayDatabase.md`
- `components/ambient-api-server/pkg/api/openapi/docs/GatewayList.md`
- `components/ambient-api-server/pkg/api/openapi/docs/GatewayOidc.md`
- `components/ambient-api-server/pkg/api/openapi/docs/GatewayPatchRequest.md`
- `components/ambient-api-server/pkg/api/openapi/docs/GatewayRoute.md`

**Cross-cutting references** (modify — remove gateway imports/registrations)
- `components/ambient-api-server/plugins/sessions/model.go` — remove `GatewayClusterId` field
- `components/ambient-api-server/plugins/sessions/handler.go` — remove gateway resolution
- `components/ambient-api-server/plugins/sessions/migration.go` — migration to drop `gateway_id`
- `components/ambient-api-server/plugins/agents/start_handler.go` — remove gateway resolver call
- `components/ambient-api-server/plugins/agents/handler.go` — remove gateway references
- `components/ambient-api-server/plugins/clusters/handler.go` — remove gateway association
- `components/ambient-api-server/plugins/clusters/service.go` — remove gateway lookup
- `components/ambient-api-server/plugins/providers/handler.go` — remove gateway reference
- `components/ambient-api-server/plugins/roles/migration.go` — remove gateway permissions
- `components/ambient-api-server/plugins/roles/plugin.go` — remove gateway role definitions
- `components/ambient-api-server/plugins/proxy/plugin.go` — remove gateway proxy routes
- `components/ambient-api-server/plugins/platformInfo/plugin.go` — remove gateway status
- `components/ambient-api-server/plugins/scheduledSessions/handler.go` — remove gateway ref
- `components/ambient-api-server/pkg/rbac/permissions.go` — remove gateway permissions
- `components/ambient-api-server/pkg/rbac/scope.go` — remove gateway scope

### Wave 3: CLI Gateway Commands (delete)

**Gateway subcommand** (3 files — delete entire directory)
- `components/ambient-cli/cmd/acpctl/gateway/cmd.go`
- `components/ambient-cli/cmd/acpctl/gateway/setup.go`
- `components/ambient-cli/cmd/acpctl/gateway/remove.go`

**CLI entry point** (modify)
- `components/ambient-cli/cmd/acpctl/main.go` — remove gateway subcommand registration

**Demo scripts** (3 files — delete)
- `components/ambient-cli/demo-gateway-lifecycle.sh`
- `components/ambient-cli/demo-openshell.sh`
- `components/ambient-cli/demo-openshell-power-user.sh`

### Wave 4: SDK Gateway Types (delete)

**Go SDK** (5 files)
- `components/ambient-sdk/go-sdk/types/gateway.go`
- `components/ambient-sdk/go-sdk/types/gateway_database.go`
- `components/ambient-sdk/go-sdk/types/gateway_oidc.go`
- `components/ambient-sdk/go-sdk/types/gateway_route.go`
- `components/ambient-sdk/go-sdk/client/gateway_api.go`

**Python SDK** (2 files)
- `components/ambient-sdk/python-sdk/ambient_platform/gateway.py`
- `components/ambient-sdk/python-sdk/ambient_platform/_gateway_api.py`

**TypeScript SDK** (2 files)
- `components/ambient-sdk/ts-sdk/src/gateway.ts`
- `components/ambient-sdk/ts-sdk/src/gateway_api.ts`

**SDK index files** (modify — remove gateway exports)
- `components/ambient-sdk/python-sdk/ambient_platform/__init__.py`
- `components/ambient-sdk/python-sdk/ambient_platform/client.py`
- `components/ambient-sdk/ts-sdk/src/index.ts`
- `components/ambient-sdk/ts-sdk/src/client.ts`

### Wave 5: Specs, Tests, Scripts, Examples (delete)

**Platform specs** (8 files — delete)
- `specs/platform/openshell-gateway.spec.md`
- `specs/platform/openshell-gateway-routing.spec.md`
- `specs/platform/openshell-gateway-database.spec.md`
- `specs/platform/openshell-gateway-tls.spec.md`
- `specs/platform/openshell-gateway-oidc.spec.md`
- `specs/platform/openshell-sandbox-provisioning.spec.md`
- `specs/platform/openshell-sandbox-observability.spec.md`
- `specs/platform/openshell-cli-e2e-test.spec.md`

**CLI specs** (2 files — delete)
- `specs/cli/gateway-cli.spec.md`
- `specs/cli/project-gateway-lifecycle.spec.md`

**Security specs** (2 files — delete)
- `specs/security/gateway-rbac-policy.spec.md`
- `specs/security/openshell-sandbox.spec.md`

**Spec index files** (modify — remove gateway entries)
- `specs/platform/index.spec.md`
- `specs/security/index.spec.md`

**E2E tests** (4 files — delete)
- `tests/e2e/gateway-e2e-test.sh`
- `tests/e2e/openshell-cli-e2e.sh`
- `tests/e2e/openshell-dual-tenant.sh`
- `tests/e2e/route-e2e-test.sh`

**E2E fixtures** (7 files — delete)
- `tests/e2e/fixtures/gateway-apply/gateway.yaml`
- `tests/e2e/fixtures/gateway-apply/kustomization.yaml`
- `tests/e2e/fixtures/gateway-apply/project.yaml`
- `tests/e2e/fixtures/openshell-cli-test/gateway.yaml`
- `tests/e2e/fixtures/openshell-cli-test/kustomization.yaml`
- `tests/e2e/fixtures/openshell-cli-test/project.yaml`
- `tests/e2e/fixtures/openshell-cli-test/test-policy.yaml`

**PR test scripts** (1 file — delete)
- `components/pr-test/e2e-openshell.sh`

**Scripts** (5 files — delete)
- `scripts/setup-kind-openshell.sh`
- `scripts/setup-gateway-api.sh`
- `scripts/setup-gateway-cli.sh`
- `scripts/setup-gateway-trusted-ca.sh`
- `scripts/update-openshell.sh`

**Examples** (delete all gateway-specific examples; modify tenant overlays)
- `examples/base/gateways/` (entire directory)
- `examples/overlays/tenant-a/gateway.yaml`
- `examples/overlays/tenant-b/gateway.yaml`
- `examples/overlays/tenant-c/gateway.yaml`
- `examples/vteam-catalog/codebase-maintainers/gateway.yaml`
- `examples/vteam-catalog/product-swarm/gateway.yaml`

**Skills** (modify)
- `skills/tooling/upgrade-upstream/openshell/SKILL.md` — delete or repurpose
- `skills/RECONCILE.md` — remove gateway spec coverage entries

**Internal docs** (2 files — delete or archive)
- `docs/internal/agents/openshell-runner-adaptation.md`
- `docs/internal/agents/openshell-security-analysis.md`

### Wave 6: UI (modify)

Remove gateway management; keep sandbox interaction.

**Delete:**
- `components/ambient-ui/src/lib/use-gateway-mode.ts`
- `components/ambient-ui/src/lib/__tests__/use-gateway-mode.test.ts`

**Modify** (remove gateway mode conditionals, simplify):
- `components/ambient-ui/src/domain/types.ts` — remove gateway types
- `components/ambient-ui/src/domain/roles.ts` — remove gateway permissions
- `components/ambient-ui/src/domain/__tests__/roles.test.ts`
- `components/ambient-ui/src/queries/use-platform-info.ts` — remove gateway mode flag
- `components/ambient-ui/src/queries/__tests__/use-platform-info.test.ts`
- `components/ambient-ui/src/app/(dashboard)/[projectId]/sessions/[sessionId]/_components/session-header.tsx`
- `components/ambient-ui/src/app/(dashboard)/[projectId]/sessions/[sessionId]/_components/sandbox-logs-tab.tsx`
- `components/ambient-ui/src/app/(dashboard)/[projectId]/agents/_components/sandbox-config-fields.tsx`
- `components/ambient-ui/src/app/(dashboard)/[projectId]/schedules/page.tsx`
- `components/ambient-ui/src/app/(dashboard)/[projectId]/policies/[policyId]/page.tsx`
- `components/ambient-ui/src/app/(dashboard)/[projectId]/providers/[providerId]/page.tsx`

**Keep** (sandbox interaction, not gateway management):
- `components/ambient-ui/src/app/(dashboard)/[projectId]/sessions/[sessionId]/_components/openshell-tab.tsx`
- `components/ambient-ui/src/queries/use-sandbox-logs.ts`

### Wave 7: Manifests, CI/CD, Build System (modify)

**Deployment overlays** (modify — remove `GATEWAY_IMAGE` and `OPENSHELL_GATEWAY_IMAGE` env vars)
- `components/manifests/overlays/kind/ambient-api-server-dev-patch.yaml`
- `components/manifests/overlays/openshift-local/ambient-api-server-dev-patch.yaml`
- `components/manifests/overlays/hcmais-dev/ambient-api-server-env-patch.yaml`
- `components/manifests/overlays/hcmais-dev/control-plane-env-patch.yaml`
- `components/manifests/overlays/hcmais/ambient-api-server-env-patch.yaml`
- `components/manifests/overlays/kind-local/control-plane-local-images-patch.yaml`
- `components/manifests/templates/template-services.yaml`

**RBAC manifests** (modify — remove gateway-related ClusterRole rules)
- `components/manifests/base/rbac/control-plane-clusterrole.yaml`

**GitHub Actions** (modify — remove openshell image builds, E2E tests, scripts)
- `.github/workflows/components-build-deploy.yml` — remove `ambient-runner-openshell` from matrix
- `.github/workflows/pr-test-trigger.yml` — remove `ambient-runner-openshell` from matrix
- `.github/workflows/test-local-dev.yml` — remove gateway setup, openshell CLI E2E, gateway log collection
- `.github/workflows/vteam-catalog-lab-e2e.yml` — remove `setup-kind-openshell.sh` trigger

**Makefile** (modify — remove gateway targets and setup)
- `Makefile` — remove `test-gateway-e2e`, `test-openshell-dual-tenant` targets; remove
  `setup-kind-openshell.sh` call from `kind-up`; remove gateway port-forward logic from
  `kind-port-forward`; remove `openshell-gateway-sandbox` SCC grants; remove gateway
  image build targets

**Runner** (keep runner images, they're still used)
- `components/runners/ambient-runner/Dockerfile.openshell` — keep (runner runs in sandbox)
- `components/runners/ambient-runner/openshell-claude-wrapper.sh` — keep (entrypoint script)

**Proto/gRPC** (keep — still used by `gatewayClient` for sandbox operations)
- `components/ambient-control-plane/proto/openshell/` — keep all
- `components/ambient-control-plane/internal/openshell/grpc/` — keep all
- `components/ambient-control-plane/scripts/vendor-proto.sh` — keep

---

## Part 3: Integration Pattern

### How ACP Discovers Gateways (new)

Today each ACP project has a Gateway resource in the API server database, and ACP's control
plane deploys that gateway into a K8s namespace. After HyperShell takes over, ACP needs a
different discovery mechanism.

**Option A: Project stores `gateway_url`**

Add a `gateway_url` field to the Project model. When a project is created, the admin
provides the URL of a HyperShell-managed gateway. ACP's `GatewayClient` resolves the
endpoint from this field instead of constructing `svc.cluster.local` DNS names.

```
Project.gateway_url = "openshell-gateway.tenant-a.apps.hypershell.example.com:443"
```

**Option B: HyperShell API discovery**

ACP calls HyperShell's REST API to discover the gateway assigned to a project:

```
GET https://hypershell.example.com/api/v1/gateways?fleet=<fleet_id>&name=<gateway_name>
→ { "route_address": "openshell-gateway.tenant-a.apps.hypershell.example.com:443",
    "tls_client_cert": "...", "tls_client_key": "...", "tls_ca": "..." }
```

**Option C: Gateway CR on shared cluster**

If ACP and HyperShell share a cluster, ACP reads the Gateway CR's status to discover
the endpoint. This is the lightest integration but couples to shared-cluster topology.

**Recommendation:** Start with Option A (simplest, no cross-service dependency at runtime).
Evolve to Option B when HyperShell's API is production-ready.

### How ACP Authenticates to Gateways (changed)

Today ACP's `TLSResolver` reads `openshell-client-tls` secrets from each tenant namespace
because ACP's certgen Job created them. After HyperShell takes over:

1. HyperShell's `GatewayReconciler` runs certgen and creates TLS secrets
2. HyperShell exposes client credentials via its API (Option B) or via a shared Secret
3. ACP's `TLSResolver` is modified to read credentials from the new source:
   - **If same cluster:** read from a HyperShell-managed Secret in a shared namespace
   - **If cross-cluster:** fetch from HyperShell API and cache locally

### What Stays Unchanged

The `gatewayClient` interface and all sandbox lifecycle operations remain identical:

- `CreateSandbox` / `GetSandbox` / `DeleteSandbox`
- `CreateProvider` / `UpdateProvider` / `ConfigureProviderRefresh` / `RotateProviderCredential`
- `SetInferenceRoute`
- `ExecSandbox` / `ExecSandboxStreaming`
- `UpdateConfig`
- `UploadPayloads`
- `FetchSandboxLogs`

These are OpenShell gRPC RPCs that any gateway serves, regardless of who deployed it.
The proto files (`proto/openshell/`) and generated gRPC code stay in ACP.

---

## Part 4: Execution Checklist

### Phase 0: Preparation

- [ ] 0.1 Verify HyperShell's GatewayReconciler can deploy a working gateway independently
- [ ] 0.2 Document the gateway endpoint URL format HyperShell exposes
- [ ] 0.3 Document the TLS credential distribution mechanism HyperShell uses
- [ ] 0.4 Add `gateway_url` field to ACP Project model (or implement Option B discovery)

### Phase 1: Control Plane Decoupling (Wave 1)

- [ ] 1.1 Delete `components/ambient-control-plane/internal/gateway/` (7 files)
- [ ] 1.2 Delete `components/ambient-control-plane/manifests/gateway/` (8 files)
- [ ] 1.3 Delete `components/ambient-control-plane/internal/reconciler/gateway_reconciler.go`
- [ ] 1.4 Modify `cmd/ambient-control-plane/main.go` — remove gateway reconciler startup
- [ ] 1.5 Modify `internal/config/config.go` — remove `OPENSHELL_GATEWAY_IMAGE` and gateway config
- [ ] 1.6 Modify `internal/openshell/gateway_client.go` — new endpoint resolution from project config
- [ ] 1.7 Modify `internal/openshell/tls_resolver.go` — new credential source
- [ ] 1.8 Simplify or remove `internal/placement/strategy.go`
- [ ] 1.9 Verify `go build ./...` and `go vet ./...` pass
- [ ] 1.10 Verify sandbox lifecycle still works against a HyperShell-managed gateway

### Phase 2: API Server Gateway Plugin Removal (Wave 2)

- [ ] 2.1 Delete `components/ambient-api-server/plugins/gateways/` (11 files)
- [ ] 2.2 Delete `components/ambient-api-server/pkg/gateway/` (5 files)
- [ ] 2.3 Delete `components/ambient-api-server/openapi/openapi.gateways.yaml`
- [ ] 2.4 Write migration to drop `gateways` table
- [ ] 2.5 Remove gateway references from session, agent, cluster, provider, role plugins
- [ ] 2.6 Remove gateway permissions from `pkg/rbac/permissions.go` and `pkg/rbac/scope.go`
- [ ] 2.7 Run `make generate` to rebuild OpenAPI client without gateway types
- [ ] 2.8 Verify `go build ./...` and `go vet ./...` pass
- [ ] 2.9 Run existing integration tests — verify non-gateway tests still pass

### Phase 3: CLI and SDK Cleanup (Waves 3-4)

- [ ] 3.1 Delete `components/ambient-cli/cmd/acpctl/gateway/` (3 files)
- [ ] 3.2 Modify `cmd/acpctl/main.go` — remove gateway subcommand
- [ ] 3.3 Delete gateway demo scripts (3 files)
- [ ] 3.4 Delete Go SDK gateway files (5 files)
- [ ] 3.5 Delete Python SDK gateway files (2 files) + update `__init__.py`, `client.py`
- [ ] 3.6 Delete TypeScript SDK gateway files (2 files) + update `index.ts`, `client.ts`
- [ ] 3.7 Verify SDK builds (Go, TypeScript, Python)

### Phase 4: Specs, Tests, Scripts, Examples (Wave 5)

- [ ] 4.1 Delete 8 platform specs (`openshell-*`)
- [ ] 4.2 Delete 2 CLI specs (`gateway-cli`, `project-gateway-lifecycle`)
- [ ] 4.3 Delete 2 security specs (`gateway-rbac-policy`, `openshell-sandbox`)
- [ ] 4.4 Update spec index files
- [ ] 4.5 Delete 4 E2E test scripts + 7 fixture files
- [ ] 4.6 Delete `components/pr-test/e2e-openshell.sh`
- [ ] 4.7 Delete 5 scripts (`setup-kind-openshell.sh`, `setup-gateway-*.sh`, `update-openshell.sh`)
- [ ] 4.8 Delete gateway example files from `examples/`
- [ ] 4.9 Update `skills/RECONCILE.md` — remove gateway coverage entries
- [ ] 4.10 Delete or archive 2 internal docs

### Phase 5: UI Simplification (Wave 6)

- [ ] 5.1 Delete `use-gateway-mode.ts` and its test
- [ ] 5.2 Remove gateway types from `domain/types.ts`
- [ ] 5.3 Remove gateway permissions from `domain/roles.ts`
- [ ] 5.4 Simplify UI pages that conditionally render gateway mode
- [ ] 5.5 Verify `npm run build` passes
- [ ] 5.6 Verify `npm run lint` passes

### Phase 6: Manifests, CI/CD, Build System (Wave 7)

- [ ] 6.1 Remove `GATEWAY_IMAGE`/`OPENSHELL_GATEWAY_IMAGE` from deployment overlays
- [ ] 6.2 Simplify control plane ClusterRole (remove gateway resource rules)
- [ ] 6.3 Remove `ambient-runner-openshell` from CI build matrix
- [ ] 6.4 Remove gateway E2E from `test-local-dev.yml`
- [ ] 6.5 Remove gateway targets from Makefile (`test-gateway-e2e`, `test-openshell-dual-tenant`,
      `setup-kind-openshell.sh` call, gateway port-forward logic, SCC grants)
- [ ] 6.6 Verify `make lint` passes
- [ ] 6.7 Verify `make kind-up` works without gateway setup

### Phase 7: Integration Validation

- [ ] 7.1 Deploy ACP + HyperShell side by side in Kind
- [ ] 7.2 HyperShell provisions a gateway (`hsctl gateway create`)
- [ ] 7.3 ACP project references the HyperShell gateway URL
- [ ] 7.4 Create session → verify sandbox boots on HyperShell-managed gateway
- [ ] 7.5 Verify exec, upload, logs all work through the external endpoint
- [ ] 7.6 Tear down session → verify sandbox is cleaned up

---

## Part 5: Risk Analysis

### Low Risk (mechanical deletion)

Waves 3-5 (CLI, SDK, specs, tests, scripts, examples) are safe deletions with no
behavioral impact on running ACP instances. They remove code paths that are only
reachable through the gateway management features being removed.

### Medium Risk (API server changes)

Wave 2 modifies the data model (removing `gateways` table, `gateway_id` columns).
Requires a migration strategy for existing deployments. Sessions currently reference
`GatewayClusterId` — this field must either be dropped (breaking) or left nullable
and ignored.

### High Risk (control plane integration)

Wave 1 changes how ACP connects to gateways. The `gatewayEndpoint()` resolution and
`TLSResolver` credential loading are on the critical path for every session. This must
be thoroughly tested with a real HyperShell-managed gateway before merging.

### Ordering Constraint

Phase 0 (HyperShell readiness) must be complete before Phase 1 starts. ACP cannot
remove its gateway operator capability until HyperShell can independently provision
gateways. The remaining phases can proceed in order but some parallelism is possible:
Phases 3-5 can run in parallel with Phase 2.

---

## Appendix A: HyperShell Bootstrap Status

The HyperShell project bootstrap is tracked in the HyperShell repo itself. Key milestones
completed (as of the prior planning phase):

- [x] TRex fixes (empty paths, OCM removal, ObjectReference, handler templates)
- [x] All 6 Kinds generated and CRUD-verified (Fleet, ManagedCluster, ManagedDatabase,
      GatewayRelease, Gateway, GatewayNetwork)
- [x] Control plane scaffolded with all 6 reconciler stubs
- [x] `make kind-up` deploys API server + control plane + PostgreSQL
- [ ] GatewayReconciler full implementation (the critical path for ACP decoupling)
- [ ] SDKs and CLI (`hsctl`)
- [ ] UI
- [ ] Production deployment

## Appendix B: Files Preserved (OpenShell gRPC Client)

These files stay in ACP because they implement sandbox operations against any OpenShell
gateway, regardless of who deployed it:

**Proto definitions** (vendored from upstream OpenShell):
- `components/ambient-control-plane/proto/openshell/v1/openshell.proto`
- `components/ambient-control-plane/proto/openshell/inference/v1/inference.proto`
- `components/ambient-control-plane/proto/openshell/datamodel/v1/datamodel.proto`
- `components/ambient-control-plane/proto/openshell/sandbox/v1/sandbox.proto`
- `components/ambient-control-plane/proto/openshell/options/v1/options.proto`

**Generated gRPC code:**
- `components/ambient-control-plane/internal/openshell/grpc/openshell/v1/openshell.pb.go`
- `components/ambient-control-plane/internal/openshell/grpc/openshell/v1/openshell_grpc.pb.go`
- `components/ambient-control-plane/internal/openshell/grpc/openshell/inference/v1/inference.pb.go`
- `components/ambient-control-plane/internal/openshell/grpc/openshell/inference/v1/inference_grpc.pb.go`
- `components/ambient-control-plane/internal/openshell/grpc/openshell/datamodel/v1/datamodel.pb.go`
- `components/ambient-control-plane/internal/openshell/grpc/openshell/sandbox/v1/sandbox.pb.go`
- `components/ambient-control-plane/internal/openshell/grpc/openshell/options/v1/options.pb.go`

**Client code** (modified, not deleted):
- `components/ambient-control-plane/internal/openshell/gateway_client.go`
- `components/ambient-control-plane/internal/openshell/gateway_client_test.go`
- `components/ambient-control-plane/internal/openshell/provider_mapping.go`
- `components/ambient-control-plane/internal/openshell/provider_mapping_test.go`
- `components/ambient-control-plane/internal/openshell/sandbox_helpers.go`
- `components/ambient-control-plane/internal/openshell/sandbox_helpers_test.go`
- `components/ambient-control-plane/internal/openshell/ssh_upload.go`
- `components/ambient-control-plane/internal/openshell/ssh_upload_test.go`
- `components/ambient-control-plane/internal/openshell/tls_resolver.go`

**Interface** (kept, used by kube_reconciler):
- `components/ambient-control-plane/internal/reconciler/gateway_iface.go`

**Proto vendoring:**
- `components/ambient-control-plane/scripts/vendor-proto.sh`

**Runner images** (still needed for sandbox execution):
- `components/runners/ambient-runner/Dockerfile.openshell`
- `components/runners/ambient-runner/openshell-claude-wrapper.sh`
