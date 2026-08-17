---
title: "RBAC & Authorization"
---

ACP uses scope-based RBAC where every API operation requires explicit permission. Users start with zero access and gain permissions by creating resources or receiving grants from existing owners. There are no deny rules -- effective permissions are the union of all matching role bindings.

## Scopes

Each role binding is scoped to a specific resource boundary. Broader scopes include everything beneath them.

| Scope | Controls | Example |
|-------|----------|---------|
| `global` | All resources on the platform | Platform admin sees every project |
| `project` | All resources within one project | Owner manages agents, sessions, and inbox |
| `agent` | One agent and its sessions | Operator can start sessions for a specific agent |
| `session` | One session run | Observer watches a single session |
| `credential` | One credential record | Owner binds a credential to projects |

A project-scoped binding covers every agent and session inside that project. A global binding covers every project.

## Roles

Roles are organized into a hierarchy. Higher levels can grant roles strictly below their own level, preventing privilege escalation.

| Level | Role | What it can do |
|-------|------|----------------|
| 0 | `platform:admin` | Full access to all resources. Can grant admin to others (sole exception to the strictly-below rule). |
| 1 | `project:owner` | Full control of one project: agents, sessions, settings, role bindings. |
| 1 | `credential:owner` | Full control of one credential: update, delete, bind to projects. |
| 2 | `project:editor` | Create and modify agents and sessions within a project. |
| 2 | `agent:operator` | Start sessions and manage one agent. |
| 2 | `credential:viewer` | Read credential metadata (not tokens). |
| 3 | `project:viewer` | Read-only access to a project's resources. |
| 3 | `agent:observer` | Read-only access to one agent and its sessions. |

Platform-internal roles (`agent:runner`, `credential:token-reader`) are managed by the platform and cannot be granted through the API.

## Role bindings

A role binding connects a user, a role, and a scope. Bindings are stored in PostgreSQL and evaluated on every request.

```text
POST /api/ambient/v1/role_bindings
GET  /api/ambient/v1/role_bindings
```

Granting rules:

- You can only grant roles strictly below your own level.
- `platform:admin` is the sole exception and can grant admin to others.
- Project-scoped grants require a binding on that project.
- Credential-scoped grants require `credential:owner` on the target credential and `project:owner` on the target project.

Deletion rules:

- Project owners can revoke bindings within their project.
- The system prevents deleting the last owner binding on a project or credential (409 Conflict) to avoid orphaned resources.

## Bootstrap

New users start with zero permissions. Access is bootstrapped through self-service:

1. **First login** -- a User record is auto-provisioned from JWT claims. No permissions are granted.
2. **Create a project** -- `POST /projects` requires only authentication. The creator automatically receives a `project:owner` binding.
3. **Create a credential** -- `POST /credentials` also requires only authentication. The creator receives a `credential:owner` binding.
4. **First platform admin** -- seeded via CLI command or database migration, since RBAC endpoints are themselves gated.

After bootstrap, existing owners can grant access to other users through the API.

## How permissions are evaluated

On every request:

1. The middleware extracts the caller's identity from the JWT.
2. It resolves the resource scope from the request URL (project ID from path, or owning project from the database).
3. It collects all role bindings matching the caller and the request context.
4. The effective permission is the union of all matching bindings. If any binding authorizes the operation, the request proceeds.

List endpoints return only resources the caller has access to -- never 403. A user with no matching bindings receives an empty list with HTTP 200.

Singleton resource endpoints (`GET /projects/{id}`) return 404 when the caller has no matching binding, regardless of whether the resource exists. This prevents ID enumeration.

Mutation endpoints return 403 with a generic error body. No details about required permissions or evaluated bindings are disclosed.

## Service callers

Internal platform services (control plane, operator) authenticate with the platform service token and bypass RBAC entirely. The service token is only valid from within the cluster -- external callers cannot use it.

## CLI examples

```bash
# Seed the first platform admin
acpctl admin seed --username admin@example.com

# Grant project editor access
acpctl role-binding create --role project:editor --project my-project --user dev@example.com

# List your role bindings
acpctl role-binding list

# Bind a credential to a project
acpctl credential bind my-github-cred --project my-project
```
