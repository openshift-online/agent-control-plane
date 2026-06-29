# Gateway Mode Simplified RBAC Policy

**Date:** 2026-06-29
**Status:** Proposed
**Related:** `specs/security/rbac-enforcement.spec.md` (base RBAC model), `specs/platform/agent-sandbox-config.spec.md` (ConfigMap agent schema), `specs/platform/gateway-provisioning.spec.md` (gateway deployment), `specs/platform/openshell-sandbox-provisioning.spec.md` (sandbox provisioning flow)

---

## Purpose

When both `OPENSHELL_USE_GATEWAY=true` AND `OPENSHELL_ENABLED=true`, the platform SHALL enforce a simplified RBAC policy that restricts agent, policy, and provider lifecycle management to a GitOps workflow and constrains human users to three effective tiers: Admin, Editor, and Viewer. Agent definitions SHALL be managed exclusively through ConfigMaps applied to tenant namespaces (schema defined in `agent-sandbox-config.spec.md`), and the API SHALL reject agent create, update, and delete operations. Policy and provider declarations (ConfigMaps with labels `ambient.ai/kind: policy` and `ambient.ai/kind: provider`) are already GitOps-only by design — no API endpoints exist for them, and this spec does not introduce any. A user's effective ACP tier SHALL be derived from their Kubernetes RoleBindings on the tenant namespace — if a user has `view` access on the namespace, they are a viewer in ACP for that project. When either flag is false, the system SHALL behave identically to the base RBAC model defined in `rbac-enforcement.spec.md`.

---

## Terminology

- **Gateway mode** — the platform state when both `OPENSHELL_USE_GATEWAY=true` AND `OPENSHELL_ENABLED=true`. All requirements in this spec apply only when gateway mode is active unless stated otherwise.
- **Admin tier** — users with `admin` or `cluster-admin` access on the tenant namespace, or holding `platform:admin` or `project:owner` ACP internal roles. Full management access including session creation, schedule management, and role binding grants.
- **Editor tier** — users with `edit` access on the tenant namespace, or holding `project:editor` or `agent:operator` ACP internal roles. Can start agent sessions and manage schedules, but cannot manage project membership or roles.
- **Viewer tier** — users with `view` access on the tenant namespace, or holding `project:viewer`, `agent:observer`, `platform:viewer`, or any project-scoped binding not in the Admin or Editor tier. Read-only access to agents, sessions, and schedules.
- **GitOps-managed agent** — an Agent record reconciled from a ConfigMap with label `ambient.ai/kind: agent` in a tenant namespace. Distinguished from API-created agents by the annotation `ambient.ai/managed-by: configmap`.
- **Policy declaration** — a ConfigMap entry with label `ambient.ai/kind: policy` containing an OpenShell `SandboxPolicy` YAML definition. Namespace-scoped, referenced by agents by name. No API endpoints exist for policies; they are GitOps-only by design (see `agent-sandbox-config.spec.md`).
- **Provider declaration** — a ConfigMap entry with label `ambient.ai/kind: provider` defining a named credential provider with its type and Secret reference. Namespace-scoped, referenced by agents by name. No API endpoints exist for providers; they are GitOps-only by design (see `agent-sandbox-config.spec.md`).

---

## Requirements

### Requirement: Activation Condition

Gateway mode simplified RBAC SHALL activate only when **both** `OPENSHELL_USE_GATEWAY=true` AND `OPENSHELL_ENABLED=true`. When either flag is `false` (or unset), the base RBAC model defined in `rbac-enforcement.spec.md` SHALL apply without modification.

The API server SHALL read both environment variables at startup. The activation state SHALL NOT change at runtime without a restart.

#### Scenario: Both flags enabled

- GIVEN `OPENSHELL_USE_GATEWAY=true` AND `OPENSHELL_ENABLED=true`
- WHEN the API server starts
- THEN gateway mode simplified RBAC is active
- AND agent CRUD gating and tier-based access controls are enforced

#### Scenario: Only gateway flag enabled

- GIVEN `OPENSHELL_USE_GATEWAY=true` AND `OPENSHELL_ENABLED=false`
- WHEN the API server starts
- THEN gateway mode simplified RBAC is NOT active
- AND the base RBAC model applies unchanged

#### Scenario: Neither flag enabled

- GIVEN `OPENSHELL_USE_GATEWAY=false` AND `OPENSHELL_ENABLED=false`
- WHEN the API server starts
- THEN gateway mode simplified RBAC is NOT active
- AND the base RBAC model applies unchanged

#### Scenario: Flags unset default to inactive

- GIVEN neither `OPENSHELL_USE_GATEWAY` nor `OPENSHELL_ENABLED` is set in the environment
- WHEN the API server starts
- THEN gateway mode simplified RBAC is NOT active
- AND no behavior change from a deployment without these flags

### Requirement: Agent CRUD Gating

When gateway mode is active, the API server SHALL reject agent create, update, and delete operations with HTTP 403. Agent read and list operations SHALL remain permitted for all authorized users.

This restriction applies regardless of the caller's role. Even `platform:admin` users SHALL NOT create, update, or delete agents via the API. Agent lifecycle is managed exclusively through the GitOps ConfigMap workflow.

The 403 response body SHALL include a reason indicating that agent management is handled via GitOps.

#### Scenario: Agent creation rejected in gateway mode

- GIVEN gateway mode is active
- AND user A has `platform:admin` with `scope=global`
- WHEN user A calls `POST /projects/proj-1/agents` with a valid agent payload
- THEN the response is 403 Forbidden
- AND the response body indicates agent creation is managed via GitOps

#### Scenario: Agent update rejected in gateway mode

- GIVEN gateway mode is active
- AND user A has `project:editor` on proj-1
- AND agent-1 exists in proj-1
- WHEN user A calls `PATCH /projects/proj-1/agents/agent-1`
- THEN the response is 403 Forbidden

#### Scenario: Agent deletion rejected in gateway mode

- GIVEN gateway mode is active
- AND user A has `project:owner` on proj-1
- AND agent-1 exists in proj-1
- WHEN user A calls `DELETE /projects/proj-1/agents/agent-1`
- THEN the response is 403 Forbidden

#### Scenario: Agent read permitted in gateway mode

- GIVEN gateway mode is active
- AND user A has `project:viewer` on proj-1
- AND agent-1 exists in proj-1
- WHEN user A calls `GET /projects/proj-1/agents/agent-1`
- THEN the response is 200 with the agent details

#### Scenario: Agent list permitted in gateway mode

- GIVEN gateway mode is active
- AND user A has `project:viewer` on proj-1
- WHEN user A calls `GET /projects/proj-1/agents`
- THEN the response is 200 with a list of agents in proj-1

#### Scenario: Agent CRUD permitted when gateway mode inactive

- GIVEN gateway mode is NOT active
- AND user A has `project:editor` on proj-1
- WHEN user A calls `POST /projects/proj-1/agents` with a valid agent payload
- THEN the agent is created normally
- AND no gateway-mode restrictions apply

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

### Requirement: GitOps Agent Lifecycle

When gateway mode is active, agents SHALL be managed exclusively through ConfigMaps with label `ambient.ai/kind: agent` applied to tenant namespaces. The control plane SHALL reconcile these ConfigMaps into Agent records in the API server database.

Agents reconciled from ConfigMaps SHALL carry the annotation `ambient.ai/managed-by: configmap`. This annotation SHALL be set by the reconciler and SHALL NOT be modifiable via the API.

The reconciler SHALL use update-or-create semantics: if an Agent with the same name already exists in the project, it is updated; if not, it is created. On ConfigMap deletion, the corresponding Agent record SHALL be deleted from the database.

The ConfigMap agent YAML schema is defined in `agent-sandbox-config.spec.md`. This spec does not redefine that schema.

#### Scenario: ConfigMap creates an agent

- GIVEN gateway mode is active
- AND a ConfigMap with label `ambient.ai/kind: agent` is applied to namespace `proj-1`
- AND the ConfigMap contains a valid agent declaration named `security-reviewer`
- WHEN the control plane reconciles the ConfigMap
- THEN an Agent record named `security-reviewer` is created in project `proj-1`
- AND the Agent carries annotation `ambient.ai/managed-by: configmap`

#### Scenario: ConfigMap updates an existing agent

- GIVEN gateway mode is active
- AND an Agent `security-reviewer` exists in proj-1 with `managed-by: configmap`
- AND the ConfigMap is updated with a new prompt
- WHEN the control plane reconciles the ConfigMap
- THEN the Agent `security-reviewer` is updated with the new prompt

#### Scenario: ConfigMap deletion removes the agent

- GIVEN gateway mode is active
- AND an Agent `security-reviewer` exists in proj-1 with `managed-by: configmap`
- WHEN the ConfigMap is deleted from namespace `proj-1`
- THEN the Agent `security-reviewer` is deleted from the database

#### Scenario: Pre-existing API-created agents survive flag toggle

- GIVEN agents were created via the API before gateway mode was enabled
- WHEN gateway mode is enabled (both flags set to true)
- THEN existing API-created agents remain in the database
- AND they are readable and can have sessions started against them
- AND they cannot be updated or deleted via the API

### Requirement: Platform Info Endpoint

The API server SHALL expose a `GET /api/ambient/v1/platform-info` endpoint that returns the current platform configuration relevant to UI behavior. This endpoint SHALL be auth-exempt (requires only a valid JWT, no RBAC evaluation).

The response SHALL include at minimum:

| Field | Type | Description |
|-------|------|-------------|
| `gateway_mode` | boolean | Whether gateway mode simplified RBAC is active |

#### Scenario: Platform info returns gateway mode status

- GIVEN gateway mode is active
- WHEN any authenticated user calls `GET /api/ambient/v1/platform-info`
- THEN the response is 200 with `{ "gateway_mode": true }`

#### Scenario: Platform info returns inactive status

- GIVEN gateway mode is NOT active
- WHEN any authenticated user calls `GET /api/ambient/v1/platform-info`
- THEN the response is 200 with `{ "gateway_mode": false }`

#### Scenario: Platform info requires authentication

- GIVEN an unauthenticated caller
- WHEN the caller calls `GET /api/ambient/v1/platform-info` without a JWT
- THEN the response is 401 Unauthorized

### Requirement: UI Adaptation

When the UI detects that `gateway_mode` is true (via the platform-info endpoint), it SHALL hide agent creation, update, and deletion controls. The UI SHALL also restrict interactive actions (session start, schedule mutation) to users with Admin or Editor tier roles.

#### Scenario: Agent creation hidden in gateway mode

- GIVEN gateway mode is active
- WHEN any user navigates to the agents page
- THEN the "New Agent" button is not displayed
- AND the agent creation form is not accessible

#### Scenario: Agent edit controls hidden in gateway mode

- GIVEN gateway mode is active
- WHEN any user views an agent's detail page
- THEN edit and delete actions are not displayed

#### Scenario: Session start hidden for viewers in gateway mode

- GIVEN gateway mode is active
- AND user A has `project:viewer` on proj-1
- WHEN user A views an agent's detail page
- THEN the "Start Session" button is not displayed

#### Scenario: Schedule creation hidden for viewers in gateway mode

- GIVEN gateway mode is active
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

When gateway mode is NOT active, the system SHALL behave identically to the base RBAC model. No agent CRUD gating, no tier-based restrictions beyond standard RBAC, no ConfigMap reconciliation.

Toggling gateway mode off (by setting either flag to false) SHALL restore full API access for agent CRUD operations. Agents created via ConfigMap reconciliation SHALL remain in the database but are now editable and deletable via the API.

#### Scenario: Flags toggled off restores API agent creation

- GIVEN agents were created via ConfigMap while gateway mode was active
- WHEN gateway mode is disabled (either flag set to false)
- THEN users with appropriate RBAC bindings can create, update, and delete agents via the API
- AND previously GitOps-managed agents are now API-manageable

#### Scenario: No ConfigMap reconciliation when flags off

- GIVEN gateway mode is NOT active
- AND ConfigMaps with label `ambient.ai/kind: agent` exist in tenant namespaces
- THEN the control plane SHALL NOT reconcile these ConfigMaps into Agent records
- AND the ConfigMaps are ignored

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Both flags required (AND logic) | `OPENSHELL_ENABLED` controls sandbox isolation and `OPENSHELL_USE_GATEWAY` controls gateway delegation. The simplified RBAC policy is meaningful only when the full gateway sandbox stack is active. Activating simplified RBAC with only one flag would create inconsistent behavior (e.g., no ConfigMap reconciler running to populate agents). |
| No new roles created | The existing role hierarchy (`platform:admin`, `project:owner/editor/viewer`, `agent:operator/observer`) maps directly to the Admin/Editor/Viewer tiers. Creating new roles would add migration complexity and fork the RBAC model. |
| Handler-level gating, not middleware-level | The RBAC middleware (`rbac-enforcement.spec.md`) is a general-purpose permission evaluator. Injecting gateway-mode business logic into it violates separation of concerns. Agent CRUD gating is a business rule ("in gateway mode, nobody creates agents via API"), not a permission check. |
| ConfigMap agents stored in database | The session creation flow reads agents from the database. Storing ConfigMap-reconciled agents in the database means the existing session start handler, scheduled session trigger, and agent-to-session relationship work unchanged. |
| Existing agents survive flag toggle | Toggling gateway mode on does not destroy data. API-created agents become read-only via the API but remain functional (sessions can be started against them). Toggling off restores full API access. |
| Namespace-backed role resolution in gateway mode | In gateway mode, the user's ACP tier is derived from their Kubernetes namespace RoleBindings (e.g., `view` in the namespace = viewer in ACP for that project). This aligns ACP access with the external identity management system (app-interface, OpenShift) that already controls namespace access. ACP internal bindings remain as a fallback (e.g., `platform:admin` still works). |
| Manual session triggering permitted for Admin/Editor | Although agents are GitOps-only, allowing admin/editor users to manually kick off sessions from pre-defined agents is a valid use case. In practice, most prod users will be viewers and won't have this ability. |
| Users must have namespace access to view projects | No auto-provisioning of viewer bindings for arbitrary authenticated users. Namespace access is managed externally (app-interface, ArgoCD, OpenShift admin). Users without namespace access get no ACP access. |
| Platform-info endpoint over environment variable | The UI is a server-rendered application that proxies to the API server. Environment variables are baked at build time; the endpoint reflects runtime server configuration. A configuration change requires only an API server restart, not a UI rebuild. |
| 403 (not 405) for gated agent CRUD | 405 Method Not Allowed implies the method is never valid on that URL, which is incorrect — the method is valid when gateway mode is off. 403 Forbidden with a descriptive reason correctly communicates "you are not permitted to do this in the current configuration." |
| Auth-exempt platform-info | The UI needs gateway mode status before establishing project context. Requiring RBAC evaluation would create a chicken-and-egg: the UI cannot know whether to show agent creation controls without calling platform-info, but RBAC evaluation requires a project scope. |
