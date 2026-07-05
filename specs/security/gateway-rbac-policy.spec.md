# OpenShell RBAC Policy

**Date:** 2026-07-05
**Status:** Active
**Related:** `specs/security/rbac-enforcement.spec.md` (base RBAC model), `specs/platform/agent-sandbox-config.spec.md` (ConfigMap agent schema), `specs/platform/gateway-provisioning.spec.md` (gateway deployment), `specs/platform/openshell-sandbox-provisioning.spec.md` (sandbox provisioning flow)

---

## Purpose

OpenShell is the default and only sandbox runtime. The platform enforces a tiered RBAC policy that constrains human users to three effective tiers: Admin, Editor, and Viewer. Agent definitions MAY be managed through both the API (full CRUD) and GitOps ConfigMaps applied to tenant namespaces (schema defined in `agent-sandbox-config.spec.md`). Policy and provider declarations (ConfigMaps with labels `ambient.ai/kind: policy` and `ambient.ai/kind: provider`) are GitOps-only by design — no API endpoints exist for them. A user's effective ACP tier SHALL be derived from their Kubernetes RoleBindings on the tenant namespace — if a user has `view` access on the namespace, they are a viewer in ACP for that project. Standard RBAC from `rbac-enforcement.spec.md` governs all agent CRUD operations.

---

## Terminology

- **OpenShell mode** — the default and only platform runtime. OpenShell delegates sandbox lifecycle to a per-tenant gateway via gRPC. All requirements in this spec apply at all times.
- **Admin tier** — users with `admin` or `cluster-admin` access on the tenant namespace, or holding `platform:admin` or `project:owner` ACP internal roles. Full management access including agent CRUD, session creation, schedule management, and role binding grants.
- **Editor tier** — users with `edit` access on the tenant namespace, or holding `project:editor` or `agent:operator` ACP internal roles. Can create/update agents, start agent sessions, and manage schedules, but cannot manage project membership or roles.
- **Viewer tier** — users with `view` access on the tenant namespace, or holding `project:viewer`, `agent:observer`, `platform:viewer`, or any project-scoped binding not in the Admin or Editor tier. Read-only access to agents, sessions, and schedules.
- **GitOps-managed agent** — an Agent record reconciled from a ConfigMap with label `ambient.ai/kind: agent` in a tenant namespace. Distinguished from API-created agents by the annotation `ambient.ai/managed-by: configmap`.
- **API-managed agent** — an Agent record created or modified via the REST API. Full CRUD is permitted for users with appropriate RBAC bindings.
- **Policy declaration** — a ConfigMap entry with label `ambient.ai/kind: policy` containing an OpenShell `SandboxPolicy` YAML definition. Namespace-scoped, referenced by agents by name. No API endpoints exist for policies; they are GitOps-only by design (see `agent-sandbox-config.spec.md`).
- **Provider declaration** — a ConfigMap entry with label `ambient.ai/kind: provider` defining a named credential provider with its type and Secret reference. Namespace-scoped, referenced by agents by name. No API endpoints exist for providers; they are GitOps-only by design (see `agent-sandbox-config.spec.md`).

---

## Requirements

### Requirement: OpenShell as Default Runtime

OpenShell is the default and only sandbox runtime. The platform always operates with OpenShell active. There are no feature flags or environment variables to disable it. `IsGatewayModeActive()` always returns `true`.

Tier-based access controls are always enforced. Agent CRUD is always permitted via the API for users with appropriate RBAC bindings.

#### Scenario: Platform starts with OpenShell active

- GIVEN the API server starts
- THEN OpenShell mode is active
- AND tier-based access controls are enforced
- AND agent CRUD is permitted via the API (governed by standard RBAC)

### Requirement: Agent CRUD via API

The API server SHALL permit full agent CRUD (create, read, update, delete) for users with appropriate RBAC bindings. Agent lifecycle is managed through both the API and GitOps ConfigMap workflows.

Agents created via the API are API-managed. Agents reconciled from ConfigMaps carry `ambient.ai/managed-by: configmap`. Both types coexist in the same project.

Standard RBAC from `rbac-enforcement.spec.md` governs all agent operations. No additional gating is applied.

#### Scenario: Admin creates an agent via API

- GIVEN user A has `project:owner` on proj-1
- WHEN user A calls `POST /projects/proj-1/agents` with a valid agent payload
- THEN the agent is created
- AND standard RBAC permissions apply

#### Scenario: Editor updates an agent via API

- GIVEN user A has `project:editor` on proj-1
- AND agent-1 exists in proj-1
- WHEN user A calls `PATCH /projects/proj-1/agents/agent-1`
- THEN the agent is updated

#### Scenario: Viewer cannot create an agent

- GIVEN user A has `project:viewer` on proj-1
- WHEN user A calls `POST /projects/proj-1/agents`
- THEN the response is 403 Forbidden

#### Scenario: Agent read permitted for viewers

- GIVEN user A has `project:viewer` on proj-1
- AND agent-1 exists in proj-1
- WHEN user A calls `GET /projects/proj-1/agents/agent-1`
- THEN the response is 200 with the agent details

#### Scenario: Agent list permitted for viewers

- GIVEN user A has `project:viewer` on proj-1
- WHEN user A calls `GET /projects/proj-1/agents`
- THEN the response is 200 with a list of agents in proj-1

### Requirement: Role-to-Tier Mapping

When OpenShell mode is active, Kubernetes namespace access and ACP internal roles SHALL map to the simplified three-tier model as follows:

| Tier | Namespace Access | ACP Internal Roles (fallback) | Capabilities |
|------|-----------------|-------------------------------|-------------|
| Admin | `admin`, `cluster-admin` | `platform:admin`, `project:owner` | Start agent sessions, create/modify/delete schedules, manage role bindings, view all resources |
| Editor | `edit` | `project:editor`, `agent:operator` | Start agent sessions, create/modify/delete schedules, view all resources |
| Viewer | `view` | `project:viewer`, `agent:observer`, `platform:viewer`, `credential:viewer` | View agents, sessions, scheduled sessions, and their runs. No mutation. |

The namespace-backed resolution is the primary mechanism. ACP internal role bindings serve as a fallback (e.g., `platform:admin` with global scope still grants access regardless of namespace permissions). The tier mapping SHALL NOT modify existing role definitions, permission sets, or the role hierarchy defined in `rbac-enforcement.spec.md`.

#### Scenario: Admin tier user starts a session

- GIVEN OpenShell mode is active (always)
- AND user A has `project:owner` on proj-1
- AND agent-1 is a GitOps-managed agent in proj-1
- WHEN user A calls `POST /projects/proj-1/agents/agent-1/start`
- THEN a new session is created from agent-1
- AND the session is provisioned via the gateway sandbox flow

#### Scenario: Editor tier user starts a session

- GIVEN OpenShell mode is active (always)
- AND user A has `project:editor` on proj-1
- AND agent-1 is a GitOps-managed agent in proj-1
- WHEN user A calls `POST /projects/proj-1/agents/agent-1/start`
- THEN a new session is created from agent-1

#### Scenario: Viewer tier user cannot start a session

- GIVEN OpenShell mode is active (always)
- AND user A has `project:viewer` on proj-1
- AND agent-1 is a GitOps-managed agent in proj-1
- WHEN user A calls `POST /projects/proj-1/agents/agent-1/start`
- THEN the response is 403 Forbidden

### Requirement: Schedule Management Access

Only Admin and Editor tier users SHALL create, modify, delete, trigger, suspend, or resume scheduled sessions. Viewer tier users SHALL be able to read and list scheduled sessions and their historical runs.

#### Scenario: Editor creates a schedule

- GIVEN OpenShell mode is active (always)
- AND user A has `project:editor` on proj-1
- WHEN user A calls `POST /projects/proj-1/scheduled-sessions` with a valid schedule payload
- THEN the scheduled session is created

#### Scenario: Viewer cannot create a schedule

- GIVEN OpenShell mode is active (always)
- AND user A has `project:viewer` on proj-1
- WHEN user A calls `POST /projects/proj-1/scheduled-sessions`
- THEN the response is 403 Forbidden

#### Scenario: Viewer lists schedules

- GIVEN OpenShell mode is active (always)
- AND user A has `project:viewer` on proj-1
- AND scheduled-sessions exist in proj-1
- WHEN user A calls `GET /projects/proj-1/scheduled-sessions`
- THEN the response is 200 with a list of scheduled sessions

#### Scenario: Viewer views schedule runs

- GIVEN OpenShell mode is active (always)
- AND user A has `project:viewer` on proj-1
- AND scheduled-session-1 has historical runs
- WHEN user A calls `GET /projects/proj-1/scheduled-sessions/ss-1/runs`
- THEN the response is 200 with a list of run sessions

#### Scenario: Viewer cannot trigger a schedule

- GIVEN OpenShell mode is active (always)
- AND user A has `project:viewer` on proj-1
- WHEN user A calls `POST /projects/proj-1/scheduled-sessions/ss-1/trigger`
- THEN the response is 403 Forbidden

#### Scenario: Viewer cannot suspend or resume a schedule

- GIVEN OpenShell mode is active (always)
- AND user A has `project:viewer` on proj-1
- WHEN user A calls `POST /projects/proj-1/scheduled-sessions/ss-1/suspend`
- THEN the response is 403 Forbidden

### Requirement: Namespace-Backed Role Resolution

The user's effective ACP tier SHALL be derived from their Kubernetes RBAC permissions on the tenant namespace, not solely from ACP's internal `role_bindings` table. Each tenant namespace maps to an ACP project. The API server SHALL check the authenticated user's permissions on the corresponding Kubernetes namespace to determine their tier.

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

- GIVEN OpenShell mode is active (always)
- AND user A has `view` access on the OpenShift namespace `proj-1`
- WHEN user A calls `GET /projects/proj-1/agents`
- THEN the response is 200 with a list of agents
- AND user A is treated as Viewer tier in ACP

#### Scenario: Namespace editor maps to ACP editor

- GIVEN OpenShell mode is active (always)
- AND user A has `edit` access on the OpenShift namespace `proj-1`
- WHEN user A calls `POST /projects/proj-1/agents/agent-1/start`
- THEN the session is created
- AND user A is treated as Editor tier in ACP

#### Scenario: Namespace admin maps to ACP admin

- GIVEN OpenShell mode is active (always)
- AND user A has `admin` access on the OpenShift namespace `proj-1`
- WHEN user A calls `POST /role_bindings` to grant access within proj-1
- THEN the binding is created
- AND user A is treated as Admin tier in ACP

#### Scenario: No namespace access means no ACP access

- GIVEN OpenShell mode is active (always)
- AND user A has NO access to the OpenShift namespace `proj-1`
- WHEN user A calls `GET /projects/proj-1/agents`
- THEN the response is 404 (per existing RBAC opacity rules)

#### Scenario: ACP internal bindings still apply as fallback

- GIVEN OpenShell mode is active (always)
- AND user A has `platform:admin` in ACP's internal role_bindings (global scope)
- AND user A has no explicit Kubernetes namespace access on proj-1
- WHEN user A calls `GET /projects/proj-1/agents`
- THEN the request is authorized via the ACP internal binding
- AND platform:admin overrides namespace-level checks

### Requirement: Default Viewer Access for Project Members

Users with `view` access on the tenant namespace (or any ACP role binding that does not map to the Admin or Editor tier) SHALL have Viewer-level access. This means they can read and list agents, sessions, and scheduled sessions within the project, but cannot perform any mutations.

In practice, most users in production environments will be viewers — admin and editor access is rare and typically reserved for platform operators.

#### Scenario: Namespace viewer views agents

- GIVEN OpenShell mode is active (always)
- AND user A has `view` access on namespace `proj-1`
- AND agents exist in proj-1
- WHEN user A calls `GET /projects/proj-1/agents`
- THEN the response is 200 with a list of agents

#### Scenario: User with no namespace access cannot view any project

- GIVEN OpenShell mode is active (always)
- AND user A has no Kubernetes namespace access on `proj-1`
- AND user A has no ACP internal bindings covering proj-1
- WHEN user A calls `GET /projects/proj-1/agents`
- THEN the response is 404 (per existing RBAC opacity rules)

#### Scenario: Namespace viewer cannot start a session

- GIVEN OpenShell mode is active (always)
- AND user A has `view` access on namespace `proj-1`
- WHEN user A calls `POST /projects/proj-1/agents/agent-1/start`
- THEN the response is 403 Forbidden

### Requirement: GitOps Agent Lifecycle

Agents MAY be managed through ConfigMaps with label `ambient.ai/kind: agent` applied to tenant namespaces. The control plane SHALL reconcile these ConfigMaps into Agent records in the API server database. Agents MAY also be created and managed via the REST API.

Agents reconciled from ConfigMaps SHALL carry the annotation `ambient.ai/managed-by: configmap`. This annotation SHALL be set by the reconciler and SHALL NOT be modifiable via the API.

The reconciler SHALL use update-or-create semantics: if an Agent with the same name already exists in the project, it is updated; if not, it is created. On ConfigMap deletion, the corresponding Agent record SHALL be deleted from the database.

The ConfigMap agent YAML schema is defined in `agent-sandbox-config.spec.md`. This spec does not redefine that schema.

#### Scenario: ConfigMap creates an agent

- GIVEN OpenShell mode is active (always)
- AND a ConfigMap with label `ambient.ai/kind: agent` is applied to namespace `proj-1`
- AND the ConfigMap contains a valid agent declaration named `security-reviewer`
- WHEN the control plane reconciles the ConfigMap
- THEN an Agent record named `security-reviewer` is created in project `proj-1`
- AND the Agent carries annotation `ambient.ai/managed-by: configmap`

#### Scenario: ConfigMap updates an existing agent

- GIVEN OpenShell mode is active (always)
- AND an Agent `security-reviewer` exists in proj-1 with `managed-by: configmap`
- AND the ConfigMap is updated with a new prompt
- WHEN the control plane reconciles the ConfigMap
- THEN the Agent `security-reviewer` is updated with the new prompt

#### Scenario: ConfigMap deletion removes the agent

- GIVEN OpenShell mode is active (always)
- AND an Agent `security-reviewer` exists in proj-1 with `managed-by: configmap`
- WHEN the ConfigMap is deleted from namespace `proj-1`
- THEN the Agent `security-reviewer` is deleted from the database

#### Scenario: Pre-existing API-created agents survive flag toggle

- GIVEN agents were created via the API before OpenShell mode was enabled
- WHEN OpenShell mode is enabled (both flags set to true)
- THEN existing API-created agents remain in the database
- AND they are readable and can have sessions started against them
- AND they cannot be updated or deleted via the API

### Requirement: Platform Info Endpoint

The API server SHALL expose a `GET /api/ambient/v1/platform-info` endpoint that returns the current platform configuration relevant to UI behavior. This endpoint SHALL be auth-exempt (requires only a valid JWT, no RBAC evaluation).

The response SHALL include at minimum:

| Field | Type | Description |
|-------|------|-------------|
| `gateway_mode` | boolean | Whether OpenShell mode simplified RBAC is active |

#### Scenario: Platform info returns OpenShell mode status

- GIVEN OpenShell mode is active (always)
- WHEN any authenticated user calls `GET /api/ambient/v1/platform-info`
- THEN the response is 200 with `{ "gateway_mode": true }`

#### Scenario: Platform info returns inactive status

- GIVEN the platform is running (OpenShell always active)
- WHEN any authenticated user calls `GET /api/ambient/v1/platform-info`
- THEN the response is 200 with `{ "gateway_mode": false }`

#### Scenario: Platform info requires authentication

- GIVEN an unauthenticated caller
- WHEN the caller calls `GET /api/ambient/v1/platform-info` without a JWT
- THEN the response is 401 Unauthorized

### Requirement: UI Adaptation

The UI SHALL display agent CRUD controls for users with appropriate RBAC bindings (Admin and Editor tiers). The UI SHALL restrict interactive actions (session start, schedule mutation) to users with Admin or Editor tier roles. Viewer tier users SHALL see read-only views.

#### Scenario: Agent creation available for editors

- GIVEN user A has `project:editor` on proj-1
- WHEN user A navigates to the agents page
- THEN the "New Agent" button is displayed

#### Scenario: Agent CRUD hidden for viewers

- GIVEN user A has `project:viewer` on proj-1
- WHEN user A views an agent's detail page
- THEN create, edit, and delete actions are not displayed

#### Scenario: Session start hidden for viewers

- GIVEN user A has `project:viewer` on proj-1
- WHEN user A views an agent's detail page
- THEN the "Start Session" button is not displayed

#### Scenario: Schedule creation hidden for viewers

- GIVEN user A has `project:viewer` on proj-1
- WHEN user A navigates to the scheduled sessions page
- THEN the "Create Schedule" button is not displayed
- AND schedule trigger/suspend/resume actions are not displayed

### Requirement: Session Viewing for Viewers

Viewer tier users SHALL be able to view session details, session message history, and session status. They SHALL NOT be able to send messages to active sessions, stop sessions, or interact with the session in any way that alters its state.

#### Scenario: Viewer reads session details

- GIVEN OpenShell mode is active (always)
- AND user A has `project:viewer` on proj-1
- AND session-1 exists in proj-1
- WHEN user A calls `GET /projects/proj-1/sessions/session-1`
- THEN the response is 200 with session details

#### Scenario: Viewer watches session messages

- GIVEN OpenShell mode is active (always)
- AND user A has `project:viewer` on proj-1
- AND session-1 is active in proj-1
- WHEN user A opens a gRPC watch stream for session-1 messages
- THEN messages are streamed to the viewer

#### Scenario: Viewer cannot send messages to a session

- GIVEN OpenShell mode is active (always)
- AND user A has `project:viewer` on proj-1
- AND session-1 is active in proj-1
- WHEN user A attempts to send a message to session-1
- THEN the response is 403 Forbidden

#### Scenario: Viewer cannot stop a session

- GIVEN OpenShell mode is active (always)
- AND user A has `project:viewer` on proj-1
- AND session-1 is active in proj-1
- WHEN user A attempts to stop session-1
- THEN the response is 403 Forbidden

### Requirement: Backward Compatibility

Agent CRUD is always available via the API for users with appropriate RBAC bindings. ConfigMap reconciliation always runs. Both API-managed and GitOps-managed agents coexist.

#### Scenario: API and GitOps agents coexist

- GIVEN agent-1 was created via the API in proj-1
- AND agent-2 was reconciled from a ConfigMap in proj-1
- THEN both agents are visible and functional
- AND agent-1 can be updated/deleted via the API
- AND agent-2 is updated/deleted only by modifying the ConfigMap

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| OpenShell always active | OpenShell is the only sandbox runtime. No feature flags or environment variables control activation. This eliminates mode-switching complexity and ensures consistent behavior across all environments. |
| No new roles created | The existing role hierarchy (`platform:admin`, `project:owner/editor/viewer`, `agent:operator/observer`) maps directly to the Admin/Editor/Viewer tiers. Creating new roles would add migration complexity and fork the RBAC model. |
| Standard RBAC for agent CRUD | Agent create/update/delete is governed by the base RBAC model (`rbac-enforcement.spec.md`). No additional gating layer is needed. Editors and above can manage agents via the API; viewers cannot. |
| ConfigMap agents stored in database | The session creation flow reads agents from the database. Storing ConfigMap-reconciled agents in the database means the existing session start handler, scheduled session trigger, and agent-to-session relationship work unchanged. |
| Existing agents survive flag toggle | Toggling OpenShell mode on does not destroy data. API-created agents become read-only via the API but remain functional (sessions can be started against them). Toggling off restores full API access. |
| Namespace-backed role resolution in OpenShell mode | In OpenShell mode, the user's ACP tier is derived from their Kubernetes namespace RoleBindings (e.g., `view` in the namespace = viewer in ACP for that project). This aligns ACP access with the external identity management system (app-interface, OpenShift) that already controls namespace access. ACP internal bindings remain as a fallback (e.g., `platform:admin` still works). |
| Manual session triggering permitted for Admin/Editor | Although agents are GitOps-only, allowing admin/editor users to manually kick off sessions from pre-defined agents is a valid use case. In practice, most prod users will be viewers and won't have this ability. |
| Users must have namespace access to view projects | No auto-provisioning of viewer bindings for arbitrary authenticated users. Namespace access is managed externally (app-interface, ArgoCD, OpenShift admin). Users without namespace access get no ACP access. |
| Platform-info endpoint over environment variable | The UI is a server-rendered application that proxies to the API server. Environment variables are baked at build time; the endpoint reflects runtime server configuration. A configuration change requires only an API server restart, not a UI rebuild. |
| 403 for unauthorized agent CRUD | Standard RBAC returns 403 when a user lacks the required role binding. Viewers get 403 on mutations; editors and above succeed. |
| Platform-info requires authentication | The endpoint requires a valid JWT but no RBAC evaluation. Unauthenticated callers receive 401. |
