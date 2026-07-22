# OpenShell Gateway Database Specification

**Date:** 2026-07-22
**Status:** Implementation-Verified
**Parent:** `openshell-gateway.spec.md` — core gateway provisioning
**Verified by:** Working ROSA deployment (PR #415)

---

## Purpose

This specification defines optional PostgreSQL database provisioning alongside OpenShell gateways. When `database.type: postgres` is set, the reconciler deploys a PostgreSQL instance in the tenant namespace and switches the gateway workload from StatefulSet (sqlite) to Deployment (postgres). This eliminates StatefulSet PVC coupling and enables horizontal scaling.

---

## Requirements

### Requirement: Gateway Database Configuration Field

The Gateway API resource SHALL accept an optional `database` object.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `database.type` | string | Yes (when `database` set) | `sqlite` | `sqlite`, `postgres`, or future `rds` |
| `database.storageSize` | string | No | `5Gi` | PVC size for PostgreSQL data |
| `database.image` | string | No | `registry.redhat.io/rhel9/postgresql-16:latest` | PostgreSQL container image |
| `database.externalSecretRef` | string | No | — | Name of Secret with `url` key. Skips DB provisioning. Reserved (Phase 2) |

> **Implementation note (corrected):** The default database image is `registry.redhat.io/rhel9/postgresql-16:latest`, not `postgres:16`. Docker Hub images are rate-limited on ROSA/OpenShift. The RHEL image is pre-authenticated via the cluster's pull secret and matches the API server's database deployment pattern.

---

### Requirement: PostgreSQL Resource Provisioning

When `database.type: postgres`, the GatewayReconciler SHALL provision:

1. **Secret** (`openshell-gateway-db-credentials`)
   - `POSTGRESQL_USER` = `openshell`
   - `POSTGRESQL_PASSWORD` = 32-byte cryptographically random hex string (`crypto/rand`)
   - `POSTGRESQL_DATABASE` = `openshell`
   - `url` = `postgresql://openshell:<password>@openshell-gateway-db:5432/openshell?sslmode=disable`
   - Created ONCE (create-or-skip for Secret to avoid password churn)

2. **PVC** (`openshell-gateway-db-data`)
   - Size: `database.storageSize` (default `5Gi`)
   - AccessMode: `ReadWriteOnce`

3. **Deployment** (`openshell-gateway-db`)
   - Image: `database.image` (default RHEL postgresql-16)
   - Env from Secret: `POSTGRESQL_USER`, `POSTGRESQL_PASSWORD`, `POSTGRESQL_DATABASE`
   - Volume mount: PVC at `/var/lib/pgsql/data`
   - SecurityContext: `runAsNonRoot`, drop ALL capabilities, `readOnlyRootFilesystem: false` (postgres needs writable data dir)
   - Readiness probe: TCP on port 5432

4. **Service** (`openshell-gateway-db`)
   - ClusterIP, port 5432 → 5432

5. **NetworkPolicy** (`openshell-gateway-db`)
   - Allow ingress only from gateway pods (same labels)

All database resources SHALL carry ownerReferences to the gateway workload for cascading deletion.

#### RHEL Image Detection

When the database image contains `rhel`, the reconciler SHALL use `POSTGRESQL_*` env var names. When using the standard Docker Hub `postgres:*` image, it SHALL use `POSTGRES_*` env var names (without the `QL` suffix).

---

### Requirement: Database Credential Security

- Passwords SHALL be generated using `crypto/rand` (32 bytes, hex-encoded)
- Passwords SHALL NEVER appear in log messages or error strings (use `len(password)` for debugging)
- The database Secret SHALL be created with create-or-skip semantics (do NOT update password on re-reconciliation)
- The `url` key in the Secret provides the full connection string for the gateway's `--db-url` argument

---

### Requirement: Gateway Workload Switching

| `database.type` | Workload | Storage | `--db-url` argument |
|---|---|---|---|
| `sqlite` (default) | StatefulSet | VolumeClaimTemplate (`openshell-data`) | `sqlite:/var/openshell/openshell.db` |
| `postgres` | Deployment | No VCT (DB has its own PVC) | From `openshell-gateway-db-credentials` Secret |

#### Scenario: Postgres gateway uses Deployment

- GIVEN a Gateway with `database.type: postgres`
- WHEN the GatewayReconciler reconciles
- THEN it SHALL create a Deployment (not StatefulSet) for the gateway
- AND the gateway container's `--db-url` argument SHALL reference the credentials Secret via env var
- AND an init container SHALL run `pg_isready` to wait for the database before starting the gateway

#### Scenario: SQLite gateway uses StatefulSet

- GIVEN a Gateway with no `database` field (or `database.type: sqlite`)
- WHEN the GatewayReconciler reconciles
- THEN it SHALL create a StatefulSet with a VolumeClaimTemplate for persistent SQLite storage

---

### Requirement: Database Resource Provisioning Order

Database resources (Secret, PVC, Deployment, Service, NetworkPolicy) SHALL be applied BEFORE the gateway workload. The gateway's init container (`pg_isready`) depends on the database Service being available.

---

### Requirement: Database Type Transition

#### Scenario: SQLite to Postgres

- GIVEN an existing gateway running as StatefulSet with SQLite
- WHEN the Gateway is patched to add `database.type: postgres`
- THEN the reconciler SHALL provision database resources (Secret, PVC, Deployment, Service)
- AND it SHALL delete the existing StatefulSet
- AND it SHALL create a Deployment for the gateway
- AND existing SQLite data SHALL NOT be migrated (fresh database)

#### Scenario: Postgres to SQLite

- GIVEN an existing gateway running as Deployment with Postgres
- WHEN the Gateway is patched to remove the `database` field
- THEN the reconciler SHALL delete the Deployment
- AND it SHALL create a StatefulSet for the gateway
- AND database resources (DB Deployment, PVC, Service, Secret) SHALL be cleaned up

---

### Requirement: Gateway Deletion with Database

When a Gateway with `database.type: postgres` is deleted, all database resources SHALL be cleaned up via ownerReferences (cascading deletion). The database PVC SHALL be deleted with the rest of the resources.

---

## Configuration Examples

### Gateway with PostgreSQL (RHEL image)

```yaml
kind: Gateway
name: openshell-gateway
project: tenant-a
image: ghcr.io/nvidia/openshell/gateway:0.0.88
serverDnsNames:
  - openshell-gateway.tenant-a.svc.cluster.local
database:
  type: postgres
  storageSize: 10Gi
  image: registry.redhat.io/rhel9/postgresql-16:latest
```

### Gateway with SQLite (default)

```yaml
kind: Gateway
name: openshell-gateway
project: tenant-a
image: ghcr.io/nvidia/openshell/gateway:0.0.88
serverDnsNames:
  - openshell-gateway.tenant-a.svc.cluster.local
```

---

## Debugging Reference

| Symptom | Root Cause | Fix |
|---|---|---|
| `acpctl apply` silently reverts to sqlite | `kustomize.Resource` missing `Database` field | Ensure SDK `Resource` struct includes `Database map[string]any` |
| Docker Hub `toomanyrequests` for postgres | Default image was `postgres:16` | Use `registry.redhat.io/rhel9/postgresql-16:latest` |
| Gateway pod CrashLoopBackOff after DB transition | init container `pg_isready` fails | Check DB Deployment is Running, Service exists |
| Database password changes on re-reconciliation | Secret uses update instead of create-or-skip | Fix to create-or-skip semantics |

---

## References

- [OpenShell Helm Chart — `server.externalDbSecret`](https://github.com/NVIDIA/OpenShell/tree/main/deploy/helm/openshell)
- [OpenShell Kubernetes Setup — External DB](https://docs.nvidia.com/openshell/latest/kubernetes/setup)
- [ACP API Server DB Pattern](../../components/manifests/base/platform/ambient-api-server-db.yml)
