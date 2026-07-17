# Project and Gateway Lifecycle Commands

**Related:** `gateway-cli.spec.md` — gateway get/setup-cli/remove-cli commands; `../platform/gateway-provisioning.spec.md` — gateway reconciler and K8s resources; `../platform/gateway-oidc.spec.md` — OIDC configuration; `../platform/gateway-route-exposure.spec.md` — GRPCRoute provisioning; `../platform/data-model.spec.md` — Gateway and Project kind definitions

---

## Purpose

The `acpctl` CLI SHALL provide simplified lifecycle commands for creating and deleting projects and gateways. These commands enable operators to provision a fully configured OpenShell gateway with a single command (`acpctl gateway create --project <p>`) without requiring kustomize overlays or knowledge of gateway configuration details. The system derives all gateway configuration from server-side defaults and conventions — the user only specifies which project the gateway belongs to.

This complements the existing `acpctl apply -k` flow (which provides full declarative control via kustomize) with an imperative, opinionated path for common use cases.

---

## Requirements

### Requirement: Project Create with Namespace Validation

The `acpctl project create` command SHALL create a project in ACP only if a matching Kubernetes namespace already exists on the cluster. ACP does not create the namespace — it is expected to be pre-provisioned by platform infrastructure.

#### Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--name` | Yes | — | Project name. Must match an existing Kubernetes namespace. |
| `--description` | No | `""` | Human-readable project description. |

#### Scenario: Namespace exists

- GIVEN a Kubernetes namespace `team-alpha` exists on the cluster
- AND no project named `team-alpha` exists in ACP
- WHEN the user runs `acpctl project create --name team-alpha`
- THEN a project named `team-alpha` SHALL be created in ACP
- AND the output SHALL confirm: `project/team-alpha created`

#### Scenario: Namespace does not exist

- GIVEN no Kubernetes namespace `team-alpha` exists on the cluster
- WHEN the user runs `acpctl project create --name team-alpha`
- THEN the command SHALL exit with an error: `namespace "team-alpha" does not exist — a backing namespace must be provisioned before creating a project`
- AND no project SHALL be created in ACP

#### Scenario: Project already exists

- GIVEN a project named `team-alpha` already exists in ACP
- WHEN the user runs `acpctl project create --name team-alpha`
- THEN the command SHALL exit with an error: `project "team-alpha" already exists`

**Note:** This namespace validation applies only to the `acpctl project create` command. The existing `acpctl apply -k` flow and the ProjectReconciler's `ensureNamespace()` behavior are unchanged — they continue to create namespaces as needed.

---

### Requirement: Project Delete

The `acpctl project delete` command SHALL delete a project from ACP.

#### Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--name` | Yes | — | Project name to delete. |

#### Scenario: Delete existing project

- GIVEN a project named `team-alpha` exists in ACP
- WHEN the user runs `acpctl project delete --name team-alpha`
- THEN the project SHALL be deleted from ACP
- AND the output SHALL confirm: `project/team-alpha deleted`
- AND the Kubernetes namespace SHALL NOT be deleted (namespace lifecycle is managed by platform infrastructure)

#### Scenario: Delete nonexistent project

- GIVEN no project named `team-alpha` exists in ACP
- WHEN the user runs `acpctl project delete --name team-alpha`
- THEN the command SHALL exit with an error: `project "team-alpha" not found`

---

### Requirement: Gateway Create with Server-Side Defaults

The `acpctl gateway create` command SHALL create an OpenShell gateway in the specified project with all configuration derived from server-side defaults. The user provides only the project name. The system fills in gateway image, OIDC configuration, DNS names, route exposure, and labels.

#### Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--project` | Yes | — | Name of an existing ACP project to deploy the gateway into. |

#### Server-Side Defaults

When the system receives a gateway create request via this command, it SHALL populate the following fields:

| Field | Value | Source |
|-------|-------|--------|
| `name` | `openshell-gateway` | Convention |
| `image` | Value of `GATEWAY_IMAGE` env var | Environment variable |
| `server_dns_names` | `["openshell-gateway.<project>.svc.cluster.local"]` | Derived from project name |
| `oidc.issuer` | Value of `KEYCLOAK_REALM_URL` env var | Environment variable |
| `oidc.audience` | `openshell-cli` | Fixed default |
| `oidc.roles_claim` | `realm_access.roles` | Fixed default |
| `oidc.admin_role` | `openshell-admin` | Fixed default |
| `oidc.user_role` | `openshell-user` | Fixed default |
| `route` | `{}` (empty object — auto-derive hostname) | Fixed default |
| `labels` | `{"purpose": "openshell", "env": "dev", "auth": "oidc"}` | Fixed defaults |

The resulting Gateway resource is equivalent to applying the following via `acpctl apply`:

```yaml
kind: Gateway
name: openshell-gateway
project: <project>
image: <GATEWAY_IMAGE>
server_dns_names:
  - openshell-gateway.<project>.svc.cluster.local
oidc:
  issuer: <KEYCLOAK_REALM_URL>
  audience: openshell-cli
  roles_claim: realm_access.roles
  admin_role: openshell-admin
  user_role: openshell-user
route: {}
labels:
  purpose: openshell
  env: dev
  auth: oidc
```

#### Scenario: Create gateway in existing project

- GIVEN a project `team-alpha` exists in ACP
- AND no gateway exists in project `team-alpha`
- AND `GATEWAY_IMAGE` is set to `ghcr.io/nvidia/openshell/gateway:0.0.80`
- AND `KEYCLOAK_REALM_URL` is set to `http://keycloak-service.ambient-code.svc.cluster.local:11880/realms/ambient-code`
- WHEN the user runs `acpctl gateway create --project team-alpha`
- THEN a Gateway resource SHALL be created in project `team-alpha` with all server-side defaults applied
- AND the gateway SHALL have `server_dns_names: ["openshell-gateway.team-alpha.svc.cluster.local"]`
- AND the gateway SHALL have OIDC enabled with the Keycloak issuer
- AND the gateway SHALL have `route: {}` for GRPCRoute provisioning
- AND the output SHALL confirm: `gateway/openshell-gateway created in project team-alpha`

#### Scenario: Project does not exist

- GIVEN no project named `team-alpha` exists in ACP
- WHEN the user runs `acpctl gateway create --project team-alpha`
- THEN the command SHALL exit with an error: `project "team-alpha" not found — create the project first with "acpctl project create --name team-alpha"`
- AND no gateway SHALL be created

#### Scenario: Gateway already exists in project

- GIVEN a project `team-alpha` exists in ACP
- AND a gateway already exists in project `team-alpha`
- WHEN the user runs `acpctl gateway create --project team-alpha`
- THEN the command SHALL exit with an error: `a gateway already exists in project "team-alpha"`

#### Scenario: GATEWAY_IMAGE not configured

- GIVEN `GATEWAY_IMAGE` is not set on the system
- WHEN the user runs `acpctl gateway create --project team-alpha`
- THEN the command SHALL exit with an error indicating that the gateway image is not configured

#### Scenario: KEYCLOAK_REALM_URL not configured

- GIVEN `KEYCLOAK_REALM_URL` is not set on the system
- WHEN the user runs `acpctl gateway create --project team-alpha`
- THEN the command SHALL exit with an error indicating that the OIDC issuer is not configured

---

### Requirement: Gateway Delete

The `acpctl gateway delete` command SHALL remove the gateway from the specified project.

#### Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--project` | Yes | — | Name of the project to remove the gateway from. |

#### Scenario: Delete existing gateway

- GIVEN a gateway exists in project `team-alpha`
- WHEN the user runs `acpctl gateway delete --project team-alpha`
- THEN the gateway SHALL be deleted from project `team-alpha`
- AND the GatewayReconciler SHALL clean up associated K8s resources (StatefulSet, Service, RBAC, certs, GRPCRoute, etc.)
- AND the output SHALL confirm: `gateway/openshell-gateway deleted from project team-alpha`

#### Scenario: No gateway in project

- GIVEN no gateway exists in project `team-alpha`
- WHEN the user runs `acpctl gateway delete --project team-alpha`
- THEN the command SHALL exit with an error: `no gateway found in project "team-alpha"`

#### Scenario: Project does not exist

- GIVEN no project named `team-alpha` exists in ACP
- WHEN the user runs `acpctl gateway delete --project team-alpha`
- THEN the command SHALL exit with an error: `project "team-alpha" not found`

---

### Requirement: Admin-Only Authorization

All project and gateway lifecycle commands defined in this spec SHALL require admin-level authorization. Only users with the `platform:admin` role SHALL be permitted to create or delete projects and gateways via these commands. Non-admin users SHALL receive a `403 Forbidden` error.

Future RBAC enhancements MAY introduce finer-grained roles (e.g., a project-scoped role allowing gateway creation within specific projects). Until then, the admin gate provides a safe default for operations that affect cluster-level infrastructure.

#### Scenario: Admin creates a project

- GIVEN the user holds the `platform:admin` role
- WHEN the user runs `acpctl project create --name team-alpha`
- THEN the command SHALL proceed with namespace validation and project creation

#### Scenario: Non-admin attempts to create a project

- GIVEN the user does NOT hold the `platform:admin` role
- WHEN the user runs `acpctl project create --name team-alpha`
- THEN the command SHALL exit with a `403 Forbidden` error
- AND no project SHALL be created

#### Scenario: Non-admin attempts to create a gateway

- GIVEN the user does NOT hold the `platform:admin` role
- WHEN the user runs `acpctl gateway create --project team-alpha`
- THEN the command SHALL exit with a `403 Forbidden` error
- AND no gateway SHALL be created

#### Scenario: Non-admin attempts to delete a project

- GIVEN the user does NOT hold the `platform:admin` role
- WHEN the user runs `acpctl project delete --name team-alpha`
- THEN the command SHALL exit with a `403 Forbidden` error
- AND the project SHALL NOT be deleted

#### Scenario: Non-admin attempts to delete a gateway

- GIVEN the user does NOT hold the `platform:admin` role
- WHEN the user runs `acpctl gateway delete --project team-alpha`
- THEN the command SHALL exit with a `403 Forbidden` error
- AND the gateway SHALL NOT be deleted

---

### Requirement: Server-Side Default Configuration

The system SHALL read gateway defaults from environment variables. These variables MUST be set in the deployment manifests for the component that applies the defaults.

| Variable | Purpose | Description |
|----------|---------|-------------|
| `GATEWAY_IMAGE` | Default gateway container image | The OpenShell gateway image tag. Changes when the project updates OpenShell versions. |
| `KEYCLOAK_REALM_URL` | OIDC issuer URL | The Keycloak realm URL for OIDC token validation. Varies per deployment environment. |

#### Scenario: Kind manifest values

- GIVEN a Kind (local development) deployment
- THEN the manifests SHALL set:
  - `GATEWAY_IMAGE=ghcr.io/nvidia/openshell/gateway:0.0.80`
  - `KEYCLOAK_REALM_URL=http://keycloak-service.ambient-code.svc.cluster.local:11880/realms/ambient-code`

#### Scenario: CRC manifest values

- GIVEN a CRC (OpenShift Local) deployment
- THEN the manifests SHALL set:
  - `GATEWAY_IMAGE=ghcr.io/nvidia/openshell/gateway:0.0.80`
  - `KEYCLOAK_REALM_URL=https://keycloak-ambient-code.apps-crc.testing/realms/ambient-code`

#### Scenario: Gateway image version update

- GIVEN the project upgrades the OpenShell version (e.g., from 0.0.80 to 0.0.85)
- WHEN the `GATEWAY_IMAGE` env var is updated in the manifests
- THEN all subsequently created gateways SHALL use the new image version
- AND existing gateways SHALL NOT be affected (their image field is already persisted)

---

## Configuration

### CLI Reference Update

| `acpctl` Command | REST API | Status |
|---|---|---|
| `acpctl project create --name <n> [--description <d>]` | `POST /projects` (with namespace validation) | 🔲 planned |
| `acpctl project delete --name <n>` | `DELETE /projects/{id}` | 🔲 planned |
| `acpctl gateway create --project <p>` | `POST /projects/{p}/gateways` (with server-side defaults) | 🔲 planned |
| `acpctl gateway delete --project <p>` | `DELETE /projects/{p}/gateways/{name}` | 🔲 planned |

**Note:** `acpctl project create` and `acpctl project delete` already exist in the data model spec as implemented commands. This spec adds the namespace pre-existence validation to the create path for the `acpctl project create` command. The existing `acpctl create project` alias continues to work but does NOT perform namespace validation (backward compatible).

### Environment Variables

| Variable | Component | Kind Default | CRC Default |
|----------|-----------|-------------|-------------|
| `GATEWAY_IMAGE` | API server | `ghcr.io/nvidia/openshell/gateway:0.0.80` | `ghcr.io/nvidia/openshell/gateway:0.0.80` |
| `KEYCLOAK_REALM_URL` | API server | `http://keycloak-service.ambient-code.svc.cluster.local:11880/realms/ambient-code` | `https://keycloak-ambient-code.apps-crc.testing/realms/ambient-code` |

---

## Migration

### Existing Consumers

| Consumer | Impact |
|---|---|
| `acpctl` CLI | Add `project create`, `project delete`, `gateway create`, `gateway delete` commands |
| API server | Add namespace validation on project create endpoint; add server-side defaulting for gateway create |
| Gateway API schema | No changes — reuses existing Gateway fields |
| ProjectReconciler | No changes — existing `ensureNamespace()` behavior unchanged |
| GatewayReconciler | No changes — reconciles the created Gateway resource as normal |
| Deployment manifests (Kind, CRC) | Add `GATEWAY_IMAGE` and `KEYCLOAK_REALM_URL` env vars |

### Backward Compatibility

- `acpctl apply -k` with explicit Gateway YAML continues to work without change
- The existing `acpctl create project` command is unchanged — namespace validation applies only to the new `acpctl project create` path
- Gateway resources created via `acpctl gateway create` are identical in structure to those created via `acpctl apply` — the GatewayReconciler treats them the same way
