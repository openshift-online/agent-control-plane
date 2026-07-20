# Project and Gateway Lifecycle Commands

**Related:** `gateway-cli.spec.md` — gateway get/setup-cli/remove-cli commands; `../platform/openshell-gateway.spec.md` — gateway provisioning, OIDC, route exposure, database; `../platform/data-model.spec.md` — Gateway and Project kind definitions

---

## Purpose

The `acpctl` CLI SHALL provide lifecycle commands for creating and deleting projects and gateways via `acpctl create <kind>` and `acpctl delete <kind>`. These commands are pure HTTP REST — `acpctl create gateway --name foo` is equivalent to `acpctl apply -f` with a YAML file containing `kind: Gateway` and `name: foo`. Both HTTP POST to the same API endpoint. The CLI commands contain no bespoke orchestration logic; they are HTTP REST with flag-to-field mapping.

When no flags are provided, the system derives all gateway configuration from server-side defaults. If the user has entered a project via `acpctl project <name>`, then `acpctl create gateway` requires zero flags — the project is taken from context and the name is auto-generated.

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

### Requirement: Gateway Create with Full Flag Coverage

The `acpctl create gateway` command SHALL create an OpenShell gateway by HTTP POSTing to `/projects/{p}/gateways`. Every Gateway data model attribute SHALL be exposed as a CLI flag. This command is equivalent to `acpctl apply -f <yaml>` with a Gateway kind — both POST to the same endpoint with no bespoke orchestration logic.

#### Flags

All Gateway data model attributes are available as flags. When a flag is omitted, the server-side default applies.

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--project` | No | Configured project (`acpctl project <name>`) | Project to deploy the gateway into |
| `--name` | No | Auto-generated | Gateway name |
| `--image` | No | Server default (`GATEWAY_IMAGE` env var) | Gateway container image reference |
| `--server-dns-names` | No | Server default (derived from project) | Comma-separated DNS names for TLS cert generation |
| `--config` | No | `""` | OpenShell gateway TOML configuration |
| `--labels` | No | Server defaults | Key=value pairs (comma-separated or repeated flag) |
| `--annotations` | No | `""` | Key=value pairs (comma-separated or repeated flag) |
| `--oidc-issuer` | No | Set by platform | OIDC issuer URL |
| `--oidc-audience` | No | `openshell-cli` | Expected `aud` claim in JWT |
| `--oidc-jwks-ttl` | No | `3600` | JWKS key cache retention in seconds |
| `--oidc-roles-claim` | No | `realm_access.roles` | Dot-delimited path to roles array in JWT |
| `--oidc-admin-role` | No | `openshell-admin` | Role name conferring admin access |
| `--oidc-user-role` | No | `openshell-user` | Role name conferring user access |
| `--oidc-scopes-claim` | No | `""` | Dot-delimited path to scopes array in JWT |
| `--route-host` | No | `""` (auto-derived) | Hostname for GRPCRoute exposure; route is enabled by default |

**No flags are required.** If the user has entered a project via `acpctl project <name>`, then `acpctl create gateway` with zero flags SHALL work — project from context, name auto-generated, all other fields from server-side defaults.

#### Server-Side Defaults

When the API server receives a gateway create request with absent fields, it SHALL populate defaults:

| Field | Default Value | Source |
|-------|---------------|--------|
| `name` | Auto-generated (e.g., `openshell-gateway`) | Convention / name generator |
| `image` | Value of `GATEWAY_IMAGE` env var | Environment variable |
| `server_dns_names` | `["<name>.<project>.svc.cluster.local"]` | Derived from name + project |
| `oidc.issuer` | Value of `OIDC_ISSUER_URL` env var | Environment variable |
| `oidc.audience` | `openshell-cli` | Fixed default |
| `oidc.roles_claim` | `realm_access.roles` | Fixed default |
| `oidc.admin_role` | `openshell-admin` | Fixed default |
| `oidc.user_role` | `openshell-user` | Fixed default |
| `route` | `{}` (enabled, hostname auto-derived) | Fixed default — route creation enabled; hostname derived by control plane |
| `labels` | `{"purpose": "openshell", "env": "dev", "auth": "oidc"}` | Fixed defaults |

The OIDC issuer is read from the API server's `OIDC_ISSUER_URL` environment variable, which is a required deployment configuration (similar to `SSO_REALM_URL` on the UI). The CLI user does not need to provide `--oidc-issuer` unless overriding the server default.

The resulting Gateway resource is equivalent to applying the following via `acpctl apply`:

```yaml
kind: Gateway
name: openshell-gateway
project: <project>
image: <GATEWAY_IMAGE>
server_dns_names:
  - openshell-gateway.<project>.svc.cluster.local
oidc:
  issuer: <OIDC_ISSUER_URL>
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

#### Scenario: Create gateway with zero flags (project from context)

- GIVEN the user has run `acpctl project team-alpha` (project context is set)
- AND project `team-alpha` exists in ACP
- WHEN the user runs `acpctl create gateway`
- THEN a Gateway resource SHALL be created in project `team-alpha` with all server-side defaults applied
- AND the gateway name SHALL be auto-generated
- AND the output SHALL confirm: `gateway/<generated-name> created in project team-alpha`

#### Scenario: Create gateway with explicit flags

- GIVEN a project `team-alpha` exists in ACP
- WHEN the user runs `acpctl create gateway --project team-alpha --name my-gw --image ghcr.io/nvidia/openshell/gateway:0.0.85 --oidc-issuer https://sso.example.com/realms/prod`
- THEN a Gateway resource SHALL be created with the explicit values overriding defaults
- AND the gateway SHALL have `name: my-gw`, the specified image, and the specified OIDC issuer
- AND all other fields SHALL use server-side defaults

#### Scenario: Create gateway is equivalent to apply

- GIVEN a project `team-alpha` exists in ACP
- WHEN the user runs `acpctl create gateway --project team-alpha --name foo`
- THEN the result SHALL be identical to `acpctl apply -f` with a YAML file containing:
  ```yaml
  kind: Gateway
  name: foo
  project: team-alpha
  ```
- AND both SHALL HTTP POST to `/projects/team-alpha/gateways` with the same payload

#### Scenario: Project does not exist

- GIVEN no project named `team-alpha` exists in ACP
- WHEN the user runs `acpctl create gateway --project team-alpha`
- THEN the command SHALL exit with an error: `project "team-alpha" not found — create the project first or run 'acpctl project <name>'`
- AND no gateway SHALL be created

#### Scenario: No project set

- GIVEN no project is set in context and `--project` is not provided
- WHEN the user runs `acpctl create gateway`
- THEN the command SHALL exit with an error: `no project set; use --project or run 'acpctl project <name>' first`

---

### Requirement: Gateway Delete

The `acpctl delete gateway <name>` command SHALL remove the named gateway from the current or specified project. This follows the existing `acpctl delete <kind> <name>` pattern used for sessions, projects, and other resources.

#### Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `<name>` (positional) | Yes | — | Name of the gateway to delete |
| `--project` | No | Configured project (`acpctl project <name>`) | Project containing the gateway |

#### Scenario: Delete existing gateway

- GIVEN the user has run `acpctl project team-alpha`
- AND a gateway named `openshell-gateway` exists in project `team-alpha`
- WHEN the user runs `acpctl delete gateway openshell-gateway`
- THEN the gateway SHALL be deleted from project `team-alpha`
- AND the GatewayReconciler SHALL clean up associated K8s resources (StatefulSet, Service, RBAC, certs, GRPCRoute, etc.)
- AND the output SHALL confirm: `gateway/openshell-gateway deleted`

#### Scenario: Delete with explicit project

- GIVEN a gateway named `my-gw` exists in project `team-alpha`
- WHEN the user runs `acpctl delete gateway my-gw --project team-alpha`
- THEN the gateway SHALL be deleted from project `team-alpha`

#### Scenario: Gateway not found

- GIVEN no gateway named `nonexistent` exists in the current project
- WHEN the user runs `acpctl delete gateway nonexistent`
- THEN the command SHALL exit with an error: `gateway "nonexistent" not found`

#### Scenario: Project does not exist

- GIVEN no project named `team-alpha` exists in ACP
- WHEN the user runs `acpctl delete gateway openshell-gateway --project team-alpha`
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
- WHEN the user runs `acpctl create gateway --project team-alpha`
- THEN the command SHALL exit with a `403 Forbidden` error
- AND no gateway SHALL be created

#### Scenario: Non-admin attempts to delete a project

- GIVEN the user does NOT hold the `platform:admin` role
- WHEN the user runs `acpctl project delete --name team-alpha`
- THEN the command SHALL exit with a `403 Forbidden` error
- AND the project SHALL NOT be deleted

#### Scenario: Non-admin attempts to delete a gateway

- GIVEN the user does NOT hold the `platform:admin` role
- WHEN the user runs `acpctl delete gateway openshell-gateway --project team-alpha`
- THEN the command SHALL exit with a `403 Forbidden` error
- AND the gateway SHALL NOT be deleted

---

### Requirement: Server-Side Default Configuration

The system SHALL read gateway defaults from environment variables. These variables MUST be set in the deployment manifests for the API server.

| Variable | Purpose | Required | Description |
|----------|---------|----------|-------------|
| `GATEWAY_IMAGE` | Default gateway container image | Yes | The OpenShell gateway image tag. Changes when the project updates OpenShell versions. |
| `OIDC_ISSUER_URL` | OIDC issuer URL | Yes | The OIDC issuer URL for token validation. Required on the API server deployment, similar to `SSO_REALM_URL` on the UI deployment. Varies per environment. |

#### Scenario: Kind manifest values

- GIVEN a Kind (local development) deployment
- THEN the manifests SHALL set:
  - `GATEWAY_IMAGE=ghcr.io/nvidia/openshell/gateway:0.0.80`
  - `OIDC_ISSUER_URL=http://keycloak-service.ambient-code.svc.cluster.local:11880/realms/ambient-code`

#### Scenario: CRC manifest values

- GIVEN a CRC (OpenShift Local) deployment
- THEN the manifests SHALL set:
  - `GATEWAY_IMAGE=ghcr.io/nvidia/openshell/gateway:0.0.80`
  - `OIDC_ISSUER_URL=https://keycloak-ambient-code.apps-crc.testing/realms/ambient-code`

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
| `acpctl create gateway [--name <n>] [--project <p>] [--image <i>] [--server-dns-names <d>] [--oidc-issuer <u>] ...` | `POST /projects/{p}/gateways` | 🔲 planned |
| `acpctl delete gateway <name> [--project <p>]` | `DELETE /projects/{p}/gateways/{name}` | 🔲 planned |

**Note:** `acpctl project create` and `acpctl project delete` already exist in the data model spec as implemented commands. This spec adds the namespace pre-existence validation to the create path for the `acpctl project create` command. The existing `acpctl create project` alias continues to work but does NOT perform namespace validation (backward compatible).

`acpctl create gateway` follows the same pattern as `acpctl create session` — it is pure HTTP REST with flag-to-field mapping. Every Gateway data model attribute is exposed as a flag. The command has no required flags when a project is set via `acpctl project <name>`.

### Environment Variables

| Variable | Component | Required | Kind Value | CRC Value |
|----------|-----------|----------|------------|-----------|
| `GATEWAY_IMAGE` | API server | Yes | `ghcr.io/nvidia/openshell/gateway:0.0.80` | `ghcr.io/nvidia/openshell/gateway:0.0.80` |
| `OIDC_ISSUER_URL` | API server | Yes | `http://keycloak-service.ambient-code.svc.cluster.local:11880/realms/ambient-code` | `https://keycloak-ambient-code.apps-crc.testing/realms/ambient-code` |

---

## Migration

### Existing Consumers

| Consumer | Impact |
|---|---|
| `acpctl` CLI | Add `gateway` to the `create` and `delete` resource type switch; add gateway-specific flags |
| API server | Add namespace validation on project create endpoint; add server-side defaulting for gateway create; require `OIDC_ISSUER_URL` env var |
| Gateway API schema | No changes — reuses existing Gateway fields |
| ProjectReconciler | No changes — existing `ensureNamespace()` behavior unchanged |
| GatewayReconciler | No changes — reconciles the created Gateway resource as normal |
| Deployment manifests (Kind, CRC) | Add `GATEWAY_IMAGE` and `OIDC_ISSUER_URL` env vars |

### Backward Compatibility

- `acpctl apply -k` with explicit Gateway YAML continues to work without change
- The existing `acpctl create project` command is unchanged — namespace validation applies only to the new `acpctl project create` path
- `acpctl create gateway` follows the same pure HTTP REST pattern as `acpctl create session` — both POST to the API with flag-to-field mapping, no orchestration logic
- Gateway resources created via `acpctl create gateway` are identical in structure to those created via `acpctl apply` — the GatewayReconciler treats them the same way
