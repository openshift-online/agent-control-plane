# Gateway Mode Simplified RBAC Policy

**Date:** 2026-07-02
**Status:** Proposed
**Related:** `specs/security/rbac-enforcement.spec.md` (base RBAC model), `specs/platform/agent-sandbox-config.spec.md` (ConfigMap agent schema), `specs/platform/gateway-provisioning.spec.md` (gateway deployment), `specs/platform/openshell-sandbox-provisioning.spec.md` (sandbox provisioning flow)

---

## Purpose

This spec defines two independent RBAC controls:

1. **GitOps resource gating** (`RBAC_ENABLED`, default `true`): When enabled, project, agent, provider, and policy definitions SHALL only be mutable by service accounts (the configmap-syncer). User-initiated API create, update, and delete operations on these resources are rejected with HTTP 403. Resource definitions are managed exclusively through ConfigMaps applied to tenant namespaces (schema defined in `agent-sandbox-config.spec.md`). When `RBAC_ENABLED=false`, any authorized user may create, update, and delete these resources via the API.

2. **Gateway mode tier-based access** (`OPENSHELL_USE_GATEWAY=true` AND `OPENSHELL_ENABLED=true`): When both flags are set, human users are constrained to three effective tiers (Admin, Editor, Viewer) for session and schedule operations. A user's effective ACP tier SHALL be derived from their Kubernetes RoleBindings on the tenant namespace. When either flag is false, the base RBAC model defined in `rbac-enforcement.spec.md` applies without modification.

These controls are independent: `RBAC_ENABLED` gates resource definition CRUD regardless of gateway mode, and gateway mode gates session/schedule operations regardless of `RBAC_ENABLED`.

---

## Terminology

- **RBAC-enabled mode** — the platform state when `RBAC_ENABLED` is not explicitly set to `false` (defaults to `true`). Controls whether GitOps-managed resource definitions (projects, agents, providers, policies) are mutable only by service accounts.
- **Gateway mode** — the platform state when both `OPENSHELL_USE_GATEWAY=true` AND `OPENSHELL_ENABLED=true`. Controls tier-based access for session and schedule operations. Independent from RBAC-enabled mode.
- **Service caller** — a request whose JWT username matches the platform's configured service account (`GRPC_SERVICE_ACCOUNT` env var). The configmap-syncer in the control plane authenticates as a service caller. Service callers are exempt from GitOps resource gating.
- **Admin tier** — users with `admin` or `cluster-admin` access on the tenant namespace, or holding `platform:admin` or `project:owner` ACP internal roles. Full management access including session creation, schedule management, and role binding grants.
- **Editor tier** — users with `edit` access on the tenant namespace, or holding `project:editor` or `agent:operator` ACP internal roles. Can start agent sessions and manage schedules, but cannot manage project membership or roles.
- **Viewer tier** — users with `view` access on the tenant namespace, or holding `project:viewer`, `agent:observer`, `platform:viewer`, or any project-scoped binding not in the Admin or Editor tier. Read-only access to agents, sessions, and schedules.
- **GitOps-managed resource** — a Project, Agent, Provider, or Policy record reconciled from a ConfigMap (labels `ambient.ai/kind: agent`, `ambient.ai/kind: provider`, `ambient.ai/kind: policy`) in a tenant namespace. The configmap-syncer creates and updates these records via the API server using its service account credentials.
- **Policy declaration** — a ConfigMap entry with label `ambient.ai/kind: policy` containing an OpenShell `SandboxPolicy` YAML definition. Namespace-scoped, referenced by agents by name. API endpoints exist for policies but are gated by `RBAC_ENABLED` (see `agent-sandbox-config.spec.md`).
- **Provider declaration** — a ConfigMap entry with label `ambient.ai/kind: provider` defining a named credential provider with its type and Secret reference. Namespace-scoped, referenced by agents by name. API endpoints exist for providers but are gated by `RBAC_ENABLED` (see `agent-sandbox-config.spec.md`).

---

## Requirements

### Requirement: Activation Conditions

This spec defines two independent activation conditions:

**GitOps resource gating** is controlled by `RBAC_ENABLED`. The API server SHALL read this environment variable at startup. When unset or set to any value other than `false`, RBAC-enabled mode is active (defaults to `true`). The activation state SHALL NOT change at runtime without a restart.

**Gateway mode tier-based access** is controlled by both `OPENSHELL_USE_GATEWAY=true` AND `OPENSHELL_ENABLED=true`. When either flag is `false` (or unset), the base RBAC model defined in `rbac-enforcement.spec.md` SHALL apply for session and schedule operations.

#### Scenario: RBAC enabled by default (env var unset)

- GIVEN `RBAC_ENABLED` is NOT set in the environment
- WHEN the API server starts
- THEN RBAC-enabled mode is active (default `true`)
- AND user-initiated project, agent, provider, and policy CRUD is rejected
- AND service account CRUD is permitted

#### Scenario: RBAC explicitly disabled

- GIVEN `RBAC_ENABLED=false`
- WHEN the API server starts
- THEN RBAC-enabled mode is NOT active
- AND any authorized user can create, update, and delete projects, agents, providers, and policies via the API

#### Scenario: RBAC enabled independently of gateway mode

- GIVEN `RBAC_ENABLED` is unset (defaults to `true`)
- AND `OPENSHELL_USE_GATEWAY=false`
- WHEN the API server starts
- THEN project, agent, provider, and policy CRUD is gated (RBAC-enabled mode active)
- AND tier-based access controls for sessions/schedules are NOT enforced (gateway mode inactive)

#### Scenario: Gateway mode active with RBAC enabled

- GIVEN `RBAC_ENABLED` is unset (defaults to `true`)
- AND `OPENSHELL_USE_GATEWAY=true` AND `OPENSHELL_ENABLED=true`
- WHEN the API server starts
- THEN both resource CRUD gating and tier-based access controls are enforced

#### Scenario: Gateway mode flags unset default to inactive

- GIVEN neither `OPENSHELL_USE_GATEWAY` nor `OPENSHELL_ENABLED` is set in the environment
- WHEN the API server starts
- THEN gateway mode tier-based access is NOT active
- AND no tier-based restrictions apply to session or schedule operations

### Requirement: GitOps Resource CRUD Gating

When RBAC-enabled mode is active (`RBAC_ENABLED` unset or not `false`), the API server SHALL reject user-initiated create, update, and delete operations on projects, agents, providers, and policies with HTTP 403. Read and list operations SHALL remain permitted for all authorized users.

Service callers (requests whose JWT username matches the configured `GRPC_SERVICE_ACCOUNT`) are exempt from this restriction. The configmap-syncer in the control plane authenticates as a service caller and SHALL be permitted to create, update, and delete these resources. The exemption is determined by `middleware.IsServiceCaller(ctx)` in the request context, which is set by the RBAC middleware when it detects a verified service account JWT.

The 403 response body SHALL include a reason indicating that the resource is managed via GitOps.

When `RBAC_ENABLED=false`, any authorized user may create, update, and delete projects, agents, providers, and policies via the API.

#### Scenario: Project creation rejected for users when RBAC enabled

- GIVEN RBAC-enabled mode is active
- AND user A has `platform:admin` with `scope=global`
- WHEN user A calls `POST /projects` with a valid project payload
- THEN the response is 403 Forbidden
- AND the response body indicates project management is restricted to GitOps

#### Scenario: Project creation permitted for service account when RBAC enabled

- GIVEN RBAC-enabled mode is active
- AND the configmap-syncer authenticates with the configured service account
- WHEN the configmap-syncer calls `POST /projects` with a valid project payload
- THEN the project is created (201 Created)

#### Scenario: Project update rejected for users when RBAC enabled

- GIVEN RBAC-enabled mode is active
- AND user A has `project:owner` on proj-1
- WHEN user A calls `PATCH /projects/proj-1`
- THEN the response is 403 Forbidden

#### Scenario: Project deletion rejected for users when RBAC enabled

- GIVEN RBAC-enabled mode is active
- AND user A has `platform:admin` with `scope=global`
- AND proj-1 exists
- WHEN user A calls `DELETE /projects/proj-1`
- THEN the response is 403 Forbidden

#### Scenario: Project read permitted for all callers

- GIVEN RBAC-enabled mode is active
- AND user A has `project:viewer` on proj-1
- WHEN user A calls `GET /projects/proj-1`
- THEN the response is 200 with the project details

#### Scenario: Project list permitted for all callers

- GIVEN RBAC-enabled mode is active
- AND user A has `project:viewer` on proj-1
- WHEN user A calls `GET /projects`
- THEN the response is 200 with a list of projects

#### Scenario: Project CRUD permitted for users when RBAC disabled

- GIVEN `RBAC_ENABLED=false`
- AND user A has `platform:admin` with `scope=global`
- WHEN user A calls `POST /projects` with a valid project payload
- THEN the project is created normally
- AND no GitOps restrictions apply

#### Scenario: Agent creation rejected for users when RBAC enabled

- GIVEN RBAC-enabled mode is active
- AND user A has `platform:admin` with `scope=global`
- WHEN user A calls `POST /projects/proj-1/agents` with a valid agent payload
- THEN the response is 403 Forbidden
- AND the response body indicates agent management is restricted to GitOps

#### Scenario: Agent creation permitted for service account when RBAC enabled

- GIVEN RBAC-enabled mode is active
- AND the configmap-syncer authenticates with the configured service account
- WHEN the configmap-syncer calls `POST /projects/proj-1/agents` with a valid agent payload
- THEN the agent is created (201 Created)

#### Scenario: Agent update rejected for users when RBAC enabled

- GIVEN RBAC-enabled mode is active
- AND user A has `project:editor` on proj-1
- AND agent-1 exists in proj-1
- WHEN user A calls `PATCH /projects/proj-1/agents/agent-1`
- THEN the response is 403 Forbidden

#### Scenario: Agent update permitted for service account when RBAC enabled

- GIVEN RBAC-enabled mode is active
- AND agent-1 exists in proj-1
- WHEN the configmap-syncer calls `PATCH /projects/proj-1/agents/agent-1`
- THEN the agent is updated (200 OK)

#### Scenario: Agent deletion rejected for users when RBAC enabled

- GIVEN RBAC-enabled mode is active
- AND user A has `project:owner` on proj-1
- AND agent-1 exists in proj-1
- WHEN user A calls `DELETE /projects/proj-1/agents/agent-1`
- THEN the response is 403 Forbidden

#### Scenario: Agent read permitted for all callers

- GIVEN RBAC-enabled mode is active
- AND user A has `project:viewer` on proj-1
- AND agent-1 exists in proj-1
- WHEN user A calls `GET /projects/proj-1/agents/agent-1`
- THEN the response is 200 with the agent details

#### Scenario: Agent list permitted for all callers

- GIVEN RBAC-enabled mode is active
- AND user A has `project:viewer` on proj-1
- WHEN user A calls `GET /projects/proj-1/agents`
- THEN the response is 200 with a list of agents in proj-1

#### Scenario: Agent CRUD permitted for users when RBAC disabled

- GIVEN `RBAC_ENABLED=false`
- AND user A has `project:editor` on proj-1
- WHEN user A calls `POST /projects/proj-1/agents` with a valid agent payload
- THEN the agent is created normally
- AND no GitOps restrictions apply

#### Scenario: Provider creation rejected for users when RBAC enabled

- GIVEN RBAC-enabled mode is active
- AND user A has `project:editor` on proj-1
- WHEN user A calls `POST /projects/proj-1/providers` with a valid provider payload
- THEN the response is 403 Forbidden

#### Scenario: Provider creation permitted for service account when RBAC enabled

- GIVEN RBAC-enabled mode is active
- WHEN the configmap-syncer calls `POST /projects/proj-1/providers` with a valid provider payload
- THEN the provider is created (201 Created)

#### Scenario: Provider update rejected for users when RBAC enabled

- GIVEN RBAC-enabled mode is active
- AND provider-1 exists in proj-1
- WHEN user A calls `PATCH /projects/proj-1/providers/provider-1`
- THEN the response is 403 Forbidden

#### Scenario: Provider deletion rejected for users when RBAC enabled

- GIVEN RBAC-enabled mode is active
- AND provider-1 exists in proj-1
- WHEN user A calls `DELETE /projects/proj-1/providers/provider-1`
- THEN the response is 403 Forbidden

#### Scenario: Policy creation rejected for users when RBAC enabled

- GIVEN RBAC-enabled mode is active
- AND user A has `project:editor` on proj-1
- WHEN user A calls `POST /projects/proj-1/policies` with a valid policy payload
- THEN the response is 403 Forbidden

#### Scenario: Policy creation permitted for service account when RBAC enabled

- GIVEN RBAC-enabled mode is active
- WHEN the configmap-syncer calls `POST /projects/proj-1/policies` with a valid policy payload
- THEN the policy is created (201 Created)

#### Scenario: Policy update rejected for users when RBAC enabled

- GIVEN RBAC-enabled mode is active
- AND policy-1 exists in proj-1
- WHEN user A calls `PATCH /projects/proj-1/policies/policy-1`
- THEN the response is 403 Forbidden

#### Scenario: Policy deletion rejected for users when RBAC enabled

- GIVEN RBAC-enabled mode is active
- AND policy-1 exists in proj-1
- WHEN user A calls `DELETE /projects/proj-1/policies/policy-1`
- THEN the response is 403 Forbidden

#### Scenario: Provider and policy CRUD permitted when RBAC disabled

- GIVEN `RBAC_ENABLED=false`
- AND user A has `project:editor` on proj-1
- WHEN user A calls `POST /projects/proj-1/providers` or `POST /projects/proj-1/policies`
- THEN the resource is created normally

### Requirement: Role-to-Tier Mapping

When gateway mode is active, Kubernetes namespace access and ACP internal roles SHALL map to the simplified three-tier model as follows:

| Tier | Namespace Access | ACP Internal Roles (fallback) | Capabilities |
|------|-----------------|-------------------------------|-------------|
| Admin | `admin`, `cluster-admin` | `platform:admin`, `project:owner` | Start agent sessions, create/modify/delete schedules, manage role bindings, view all resources |
| Editor | `edit` | `project:editor`, `agent:operator` | Start agent sessions, create/modify/delete schedules, view all resources |
| Viewer | `view` | `project:viewer`, `agent:observer`, `platform:viewer`, `credential:viewer` | View agents, sessions, scheduled sessions, and their runs. No mutation. |

The namespace-backed resolution is the primary mechanism. ACP internal role bindings serve as a fallback (e.g., `platform:admin` with global scope still grants access regardless of namespace permissions). The tier mapping SHALL NOT modify existing role definitions, permission sets, or the role hierarchy defined in `rbac-enforcement.spec.md`.

#### Scenario: Admin tier user starts a session

- GIVEN gateway mode is active
- AND user A has `project:owner` on proj-1
- AND agent-1 is a GitOps-managed agent in proj-1
- WHEN user A calls `POST /projects/proj-1/agents/agent-1/start`
- THEN a new session is created from agent-1
- AND the session is provisioned via the gateway sandbox flow

#### Scenario: Editor tier user starts a session

- GIVEN gateway mode is active
- AND user A has `project:editor` on proj-1
- AND agent-1 is a GitOps-managed agent in proj-1
- WHEN user A calls `POST /projects/proj-1/agents/agent-1/start`
- THEN a new session is created from agent-1

#### Scenario: Viewer tier user cannot start a session

- GIVEN gateway mode is active
- AND user A has `project:viewer` on proj-1
- AND agent-1 is a GitOps-managed agent in proj-1
- WHEN user A calls `POST /projects/proj-1/agents/agent-1/start`
- THEN the response is 403 Forbidden

### Requirement: Schedule Management Access

When gateway mode is active, only Admin and Editor tier users SHALL create, modify, delete, trigger, suspend, or resume scheduled sessions. Viewer tier users SHALL be able to read and list scheduled sessions and their historical runs.

#### Scenario: Editor creates a schedule

- GIVEN gateway mode is active
- AND user A has `project:editor` on proj-1
- WHEN user A calls `POST /projects/proj-1/scheduled-sessions` with a valid schedule payload
- THEN the scheduled session is created

#### Scenario: Viewer cannot create a schedule

- GIVEN gateway mode is active
- AND user A has `project:viewer` on proj-1
- WHEN user A calls `POST /projects/proj-1/scheduled-sessions`
- THEN the response is 403 Forbidden

#### Scenario: Viewer lists schedules

- GIVEN gateway mode is active
- AND user A has `project:viewer` on proj-1
- AND scheduled-sessions exist in proj-1
- WHEN user A calls `GET /projects/proj-1/scheduled-sessions`
- THEN the response is 200 with a list of scheduled sessions

#### Scenario: Viewer views schedule runs

- GIVEN gateway mode is active
- AND user A has `project:viewer` on proj-1
- AND scheduled-session-1 has historical runs
- WHEN user A calls `GET /projects/proj-1/scheduled-sessions/ss-1/runs`
- THEN the response is 200 with a list of run sessions

#### Scenario: Viewer cannot trigger a schedule

- GIVEN gateway mode is active
- AND user A has `project:viewer` on proj-1
- WHEN user A calls `POST /projects/proj-1/scheduled-sessions/ss-1/trigger`
- THEN the response is 403 Forbidden

#### Scenario: Viewer cannot suspend or resume a schedule

- GIVEN gateway mode is active
- AND user A has `project:viewer` on proj-1
- WHEN user A calls `POST /projects/proj-1/scheduled-sessions/ss-1/suspend`
- THEN the response is 403 Forbidden

### Requirement: Namespace-Backed Role Resolution

When gateway mode is active, the user's effective ACP tier SHALL be derived from their Kubernetes RBAC permissions on the tenant namespace, not solely from ACP's internal `role_bindings` table. Each tenant namespace maps to an ACP project. The API server SHALL check the authenticated user's permissions on the corresponding Kubernetes namespace to determine their tier.

The mapping from Kubernetes namespace access to ACP tier SHALL be:

| Kubernetes Namespace Access | ACP Tier |
|----------------------------|----------|
| `admin` or `cluster-admin` verb access | Admin |
| `edit` verb access | Editor |
| `view` verb access | Viewer |
| No namespace access | No ACP access (403/404 per existing opacity rules) |

The API server SHALL use a Kubernetes `SubjectAccessReview` or equivalent mechanism to determine the user's effective access level on the tenant namespace. The user identity for the review SHALL come from the JWT claims (the same identity used for ACP authentication).

Users who have no access to the Kubernetes namespace SHALL NOT have access to the corresponding ACP project. There is no auto-provisioning — namespace access is managed externally (e.g., via app-interface, ArgoCD, or direct OpenShift role grants).

#### Scenario: Namespace viewer maps to ACP viewer

- GIVEN gateway mode is active
- AND user A has `view` access on the OpenShift namespace `proj-1`
- WHEN user A calls `GET /projects/proj-1/agents`
- THEN the response is 200 with a list of agents
- AND user A is treated as Viewer tier in ACP

#### Scenario: Namespace editor maps to ACP editor

- GIVEN gateway mode is active
- AND user A has `edit` access on the OpenShift namespace `proj-1`
- WHEN user A calls `POST /projects/proj-1/agents/agent-1/start`
- THEN the session is created
- AND user A is treated as Editor tier in ACP

#### Scenario: Namespace admin maps to ACP admin

- GIVEN gateway mode is active
- AND user A has `admin` access on the OpenShift namespace `proj-1`
- WHEN user A calls `POST /role_bindings` to grant access within proj-1
- THEN the binding is created
- AND user A is treated as Admin tier in ACP

#### Scenario: No namespace access means no ACP access

- GIVEN gateway mode is active
- AND user A has NO access to the OpenShift namespace `proj-1`
- WHEN user A calls `GET /projects/proj-1/agents`
- THEN the response is 404 (per existing RBAC opacity rules)

#### Scenario: ACP internal bindings still apply as fallback

- GIVEN gateway mode is active
- AND user A has `platform:admin` in ACP's internal role_bindings (global scope)
- AND user A has no explicit Kubernetes namespace access on proj-1
- WHEN user A calls `GET /projects/proj-1/agents`
- THEN the request is authorized via the ACP internal binding
- AND platform:admin overrides namespace-level checks

### Requirement: Default Viewer Access for Project Members

When gateway mode is active, users with `view` access on the tenant namespace (or any ACP role binding that does not map to the Admin or Editor tier) SHALL have Viewer-level access. This means they can read and list agents, sessions, and scheduled sessions within the project, but cannot perform any mutations.

In practice, most users in production environments will be viewers — admin and editor access is rare and typically reserved for platform operators.

#### Scenario: Namespace viewer views agents

- GIVEN gateway mode is active
- AND user A has `view` access on namespace `proj-1`
- AND agents exist in proj-1
- WHEN user A calls `GET /projects/proj-1/agents`
- THEN the response is 200 with a list of agents

#### Scenario: User with no namespace access cannot view any project

- GIVEN gateway mode is active
- AND user A has no Kubernetes namespace access on `proj-1`
- AND user A has no ACP internal bindings covering proj-1
- WHEN user A calls `GET /projects/proj-1/agents`
- THEN the response is 404 (per existing RBAC opacity rules)

#### Scenario: Namespace viewer cannot start a session

- GIVEN gateway mode is active
- AND user A has `view` access on namespace `proj-1`
- WHEN user A calls `POST /projects/proj-1/agents/agent-1/start`
- THEN the response is 403 Forbidden

### Requirement: GitOps Resource Lifecycle

When RBAC-enabled mode is active, projects, agents, providers, and policies SHALL be managed through ConfigMaps applied to tenant namespaces. The control plane's configmap-syncer SHALL reconcile these ConfigMaps into records in the API server database via the API, authenticating as a service account.

The configmap-syncer creates and updates resources by calling the API server's standard REST endpoints (`POST /projects/{id}/agents`, `PATCH /projects/{id}/agents/{agent_id}`, etc.) using the service account's JWT. Because service callers are exempt from the GitOps resource gate, these requests succeed even when RBAC-enabled mode is active.

The reconciler SHALL use update-or-create semantics: if a resource with the same name already exists in the project, it is updated; if not, it is created. On ConfigMap deletion, the corresponding record SHALL be deleted from the database.

The ConfigMap YAML schemas are defined in `agent-sandbox-config.spec.md`. This spec does not redefine those schemas.

#### Scenario: ConfigMap creates an agent via service account

- GIVEN RBAC-enabled mode is active
- AND a ConfigMap with label `ambient.ai/kind: agent` is applied to namespace `proj-1`
- AND the ConfigMap contains a valid agent declaration named `security-reviewer`
- WHEN the configmap-syncer reconciles the ConfigMap
- THEN the configmap-syncer calls `POST /projects/proj-1/agents` with the service account JWT
- AND the request is permitted (service caller exemption)
- AND an Agent record named `security-reviewer` is created in project `proj-1`

#### Scenario: ConfigMap creates a provider via service account

- GIVEN RBAC-enabled mode is active
- AND a ConfigMap with label `ambient.ai/kind: provider` is applied to namespace `proj-1`
- WHEN the configmap-syncer reconciles the ConfigMap
- THEN the configmap-syncer calls `POST /projects/proj-1/providers` with the service account JWT
- AND the request is permitted (service caller exemption)
- AND a Provider record is created in project `proj-1`

#### Scenario: ConfigMap creates a policy via service account

- GIVEN RBAC-enabled mode is active
- AND a ConfigMap with label `ambient.ai/kind: policy` is applied to namespace `proj-1`
- WHEN the configmap-syncer reconciles the ConfigMap
- THEN the configmap-syncer calls `POST /projects/proj-1/policies` with the service account JWT
- AND the request is permitted (service caller exemption)
- AND a Policy record is created in project `proj-1`

#### Scenario: ConfigMap updates an existing agent

- GIVEN RBAC-enabled mode is active
- AND an Agent `security-reviewer` exists in proj-1
- AND the ConfigMap is updated with a new prompt
- WHEN the configmap-syncer reconciles the ConfigMap
- THEN the Agent `security-reviewer` is updated with the new prompt

#### Scenario: ConfigMap deletion removes the agent

- GIVEN RBAC-enabled mode is active
- AND an Agent `security-reviewer` exists in proj-1
- WHEN the ConfigMap is deleted from namespace `proj-1`
- THEN the Agent `security-reviewer` is deleted from the database

#### Scenario: Pre-existing API-created resources survive RBAC toggle

- GIVEN projects, agents, providers, and policies were created via the API before RBAC-enabled mode was activated
- WHEN RBAC-enabled mode becomes active
- THEN existing API-created resources remain in the database
- AND they are readable and can be used (sessions started against agents, etc.)
- AND they cannot be updated or deleted via user API calls

### Requirement: Platform Info Endpoint

The API server SHALL expose a `GET /api/ambient/v1/platform-info` endpoint that returns the current platform configuration relevant to UI behavior. This endpoint SHALL be auth-exempt (requires only a valid JWT, no RBAC evaluation).

The response SHALL include at minimum:

| Field | Type | Description |
|-------|------|-------------|
| `gateway_mode` | boolean | Whether gateway mode tier-based access is active |
| `rbac_enabled` | boolean | Whether GitOps resource CRUD gating is active |

#### Scenario: Platform info returns both flags

- GIVEN RBAC-enabled mode is active AND gateway mode is active
- WHEN any authenticated user calls `GET /api/ambient/v1/platform-info`
- THEN the response is 200 with `{ "gateway_mode": true, "rbac_enabled": true }`

#### Scenario: Platform info with RBAC enabled but no gateway

- GIVEN RBAC-enabled mode is active AND gateway mode is NOT active
- WHEN any authenticated user calls `GET /api/ambient/v1/platform-info`
- THEN the response is 200 with `{ "gateway_mode": false, "rbac_enabled": true }`

#### Scenario: Platform info with RBAC disabled

- GIVEN `RBAC_ENABLED=false`
- WHEN any authenticated user calls `GET /api/ambient/v1/platform-info`
- THEN the response is 200 with `{ ..., "rbac_enabled": false }`

#### Scenario: Platform info requires authentication

- GIVEN an unauthenticated caller
- WHEN the caller calls `GET /api/ambient/v1/platform-info` without a JWT
- THEN the response is 401 Unauthorized

### Requirement: UI Adaptation

The UI SHALL use both `rbac_enabled` and `gateway_mode` from the platform-info endpoint to adapt its controls:

- When `rbac_enabled` is true, the UI SHALL hide project, agent, provider, and policy creation, update, and deletion controls.
- When `gateway_mode` is true, the UI SHALL restrict interactive actions (session start, schedule mutation) to users with Admin or Editor tier roles.

#### Scenario: Resource creation hidden when RBAC enabled

- GIVEN `rbac_enabled` is true
- WHEN any user navigates to the agents page
- THEN the "New Agent" button is not displayed
- AND the agent creation form is not accessible

#### Scenario: Resource edit controls hidden when RBAC enabled

- GIVEN `rbac_enabled` is true
- WHEN any user views an agent's, provider's, or policy's detail page
- THEN edit and delete actions are not displayed

#### Scenario: Session start hidden for viewers in gateway mode

- GIVEN `gateway_mode` is true
- AND user A has `project:viewer` on proj-1
- WHEN user A views an agent's detail page
- THEN the "Start Session" button is not displayed

#### Scenario: Schedule creation hidden for viewers in gateway mode

- GIVEN `gateway_mode` is true
- AND user A has `project:viewer` on proj-1
- WHEN user A navigates to the scheduled sessions page
- THEN the "Create Schedule" button is not displayed
- AND schedule trigger/suspend/resume actions are not displayed

### Requirement: Session Viewing for Viewers

Viewer tier users SHALL be able to view session details, session message history, and session status. They SHALL NOT be able to send messages to active sessions, stop sessions, or interact with the session in any way that alters its state.

#### Scenario: Viewer reads session details

- GIVEN gateway mode is active
- AND user A has `project:viewer` on proj-1
- AND session-1 exists in proj-1
- WHEN user A calls `GET /projects/proj-1/sessions/session-1`
- THEN the response is 200 with session details

#### Scenario: Viewer watches session messages

- GIVEN gateway mode is active
- AND user A has `project:viewer` on proj-1
- AND session-1 is active in proj-1
- WHEN user A opens a gRPC watch stream for session-1 messages
- THEN messages are streamed to the viewer

#### Scenario: Viewer cannot send messages to a session

- GIVEN gateway mode is active
- AND user A has `project:viewer` on proj-1
- AND session-1 is active in proj-1
- WHEN user A attempts to send a message to session-1
- THEN the response is 403 Forbidden

#### Scenario: Viewer cannot stop a session

- GIVEN gateway mode is active
- AND user A has `project:viewer` on proj-1
- AND session-1 is active in proj-1
- WHEN user A attempts to stop session-1
- THEN the response is 403 Forbidden

### Requirement: Backward Compatibility

Setting `RBAC_ENABLED=false` SHALL restore full user API access for agent, provider, and policy CRUD operations. Resources created via ConfigMap reconciliation SHALL remain in the database but are now editable and deletable via the API.

When gateway mode is NOT active (either `OPENSHELL_USE_GATEWAY` or `OPENSHELL_ENABLED` is false/unset), the system SHALL apply the base RBAC model for session and schedule operations — no tier-based restrictions beyond standard RBAC.

#### Scenario: RBAC disabled restores user API access

- GIVEN resources were created via ConfigMap while RBAC-enabled mode was active
- WHEN `RBAC_ENABLED=false` is set and the API server restarts
- THEN users with appropriate RBAC bindings can create, update, and delete projects, agents, providers, and policies via the API
- AND previously GitOps-managed resources are now API-manageable

#### Scenario: Gateway mode off restores base RBAC for sessions

- GIVEN gateway mode was previously active
- WHEN gateway mode is disabled (either flag set to false)
- THEN tier-based access controls for sessions and schedules are removed
- AND the base RBAC model applies unchanged

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| `RBAC_ENABLED` separate from gateway mode flags | Resource definition CRUD gating (agents, providers, policies) is a distinct concern from gateway mode tier-based access (sessions, schedules). Decoupling them allows RBAC enforcement without requiring the full OpenShell gateway stack, and avoids the configmap-syncer being blocked by a gate whose message says "managed via GitOps ConfigMaps." |
| `RBAC_ENABLED` defaults to `true` | Secure by default. Operators must explicitly opt out (`RBAC_ENABLED=false`) to allow user-initiated resource definition CRUD. This prevents accidental exposure in production deployments. |
| Service account exemption via `middleware.IsServiceCaller(ctx)` | The RBAC middleware already detects service callers by matching the JWT username against `GRPC_SERVICE_ACCOUNT`. Reusing this existing mechanism avoids introducing new headers or bypass tokens. The configmap-syncer authenticates with a service account JWT and is auto-provisioned with `platform:admin`, so the exemption is identity-verified, not header-spoofable. |
| Uniform gating across projects, agents, providers, and policies | All four resource types follow the same GitOps lifecycle (ConfigMap → configmap-syncer → API). Gating only some resources while leaving others open was inconsistent and could lead to user confusion or misconfigured resources. |
| Both gateway flags required (AND logic) for tier access | `OPENSHELL_ENABLED` controls sandbox isolation and `OPENSHELL_USE_GATEWAY` controls gateway delegation. Tier-based access is meaningful only when the full gateway sandbox stack is active. |
| No new roles created | The existing role hierarchy (`platform:admin`, `project:owner/editor/viewer`, `agent:operator/observer`) maps directly to the Admin/Editor/Viewer tiers. Creating new roles would add migration complexity and fork the RBAC model. |
| Handler-level gating, not middleware-level | The RBAC middleware is a general-purpose permission evaluator. Resource CRUD gating is a business rule ("when RBAC is enabled, only service accounts mutate definitions"), not a permission check. Keeping it in handlers preserves separation of concerns. |
| ConfigMap resources stored in database | The session creation flow reads agents from the database. Storing ConfigMap-reconciled resources in the database means existing handlers work unchanged. |
| Existing resources survive flag toggle | Toggling RBAC on does not destroy data. API-created resources become read-only via user API calls but remain functional. Toggling off restores full API access. |
| Namespace-backed role resolution in gateway mode | In gateway mode, the user's ACP tier is derived from their Kubernetes namespace RoleBindings. This aligns ACP access with the external identity management system that already controls namespace access. ACP internal bindings remain as a fallback. |
| Manual session triggering permitted for Admin/Editor | Although resource definitions are GitOps-only, allowing admin/editor users to manually start sessions from pre-defined agents is a valid use case. |
| Platform-info endpoint over environment variable | The UI proxies to the API server. The endpoint reflects runtime server configuration. A configuration change requires only an API server restart, not a UI rebuild. |
| 403 (not 405) for gated CRUD | 405 implies the method is never valid on that URL, which is incorrect — the method is valid when RBAC is disabled. 403 with a descriptive reason correctly communicates the restriction. |
| Auth-exempt platform-info | The UI needs configuration status before establishing project context. Requiring RBAC evaluation would create a chicken-and-egg problem. |
