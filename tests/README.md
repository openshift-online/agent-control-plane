# Test Suite

Consolidated test directory for the Agent Control Plane platform.

## Directory Structure

```
tests/
├── unit/           Pure-function tests (no cluster required)
├── integration/    Component validation and cross-cutting checks
├── e2e/            End-to-end tests requiring a running Kind cluster
├── infra/          Cluster lifecycle scripts (setup, teardown, image loading)
└── cypress/        UI tests (Cypress + Vitest coverage)
```

## Test Inventory

### unit/

| File | What it tests | CI Workflow |
|------|--------------|-------------|
| `test_model_discovery.py` | `parse_model_family`, `model_id_to_label`, `keep_latest_versions`, `discover_models` | `unit-tests.yml` (scripts job) |

### integration/

| File | What it tests | CI Workflow |
|------|--------------|-------------|
| `bench-test.sh` | Benchmark harness syntax and component function coverage | `component-benchmarks.yml` |
| `authz-cross-project-test.sh` | Cross-project session listing, filter, unauthorized access, TSL injection, response shape | -- (wire manually) |
| `amber-workflow-yaml-test.py` | GHA workflow YAML parsing validation (PR #419 regression) | -- |

### e2e/

| File | What it tests | CI Workflow |
|------|--------------|-------------|
| `rbac_e2e_test.sh` | 26-phase RBAC enforcement: isolation, escalation, binding hierarchy, sub-resources | `test-local-dev.yml` |
| `scheduled_sessions_e2e_test.sh` | Scheduled session CRUD, suspend/resume, trigger, runs history | `test-local-dev.yml` |
| `local-dev-test.sh` | Infrastructure validation: pods, services, RBAC, security contexts, build commands | `test-local-dev.yml` |
| `openshell-dual-tenant.sh` | Dual-tenant gateway provisioning, sandbox CRD, concurrent sessions | `make test-openshell-dual-tenant` |
| `gateway-e2e-test.sh` | Full agent flow: `acpctl apply -k` -> `acpctl start` -> sandbox -> LLM inference -> response | `make test-gateway-e2e` |

### infra/

Cluster lifecycle scripts consumed by `make kind-up`, `make kind-down`, and CI workflows.

| File | Purpose |
|------|---------|
| `setup-kind.sh` | Create Kind cluster with Docker/Podman detection |
| `wait-for-ready.sh` | Wait for all deployments (api-server, control-plane, ui, minio, keycloak) |
| `cleanup.sh` | Delete Kind cluster, clean test artifacts |
| `extract-token.sh` | Extract test-user-token (K8s SA or Keycloak SSO) |
| `init-minio.sh` | Initialize MinIO S3 bucket |
| `load-images.sh` | Load container images into Kind |
| `refresh-env.sh` | Update K8s secrets and images from .env |
| `deploy.sh` | Deploy manifests with kustomize |
| `deploy-langfuse.sh` | Deploy Langfuse to OpenShift |
| `configure-clickhouse-ttl.sh` | Configure ClickHouse TTL for Langfuse |

### cypress/

| File | Purpose |
|------|---------|
| `run-tests.sh` | Cypress test runner (loads TEST_TOKEN, CYPRESS_BASE_URL) |
| `coverage.sh` | Vitest coverage for ambient-ui |

## Running Tests

```bash
make local-test-quick          # 5-second smoke test (cluster + pods + health)
make local-test-dev            # Infrastructure validation (local-dev-test.sh)
make test-all                  # Quick + comprehensive + CLI tests
make test-openshell-dual-tenant  # Dual-tenant gateway provisioning
make test-gateway-e2e          # Full agent flow (requires running cluster + acpctl)
make test-e2e                  # Cypress UI tests
```

## Removed Tests

| File | Reason |
|------|--------|
| `pod-mode-session.sh` | Pod mode (`OPENSHELL_USE_GATEWAY=false`) removed. Gateway is the only mode. |
| `run-e2e-both-modes.sh` | Orchestrated pod-mode + gateway-mode phases. Pod mode is dead. |

## Migration from e2e/

The `e2e/` directory was consolidated into `tests/` (July 2025). Infrastructure scripts moved to `tests/infra/`, Cypress files to `tests/cypress/`. All Makefile targets and CI workflows updated.
