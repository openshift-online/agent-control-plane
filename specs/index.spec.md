# Specs

Desired state of the system. Code is the actual state. Development work reconciles the two.

## Sub-Specs

### [Platform](platform/)

Data model, API, CLI, session lifecycle, control plane, runner, and MCP server.

### [Security](security/)

Identity boundaries, SSO authentication, RBAC enforcement, credential binding, credential encryption, and sandbox isolation.

### [UI](ui/)

Operations dashboard, agent authoring workbench, annotation system, and live preview.

### [Standards](standards/)

Cross-cutting engineering constraints by component. (TODO: upstream via APM)

## Spec Registry

Machine-readable index for autonomous reconciliation (`/reconcile` skill).

| Path | Domain | Primary Entities | Components | Depends On |
|------|--------|-----------------|------------|------------|
| `platform/data-model.spec.md` | platform | User, Project, Agent, Inbox, Session, SessionMessage, SessionEvent, Role, RoleBinding, Credential, ScheduledSession, Application, ProjectSettings | API, SDK, BE, CLI, CP, FE | - |
| `platform/control-plane.spec.md` | platform | WatchManager, Informer, KubeReconciler | CP, Runner | data-model |
| `platform/runner.spec.md` | platform | PlatformBridge, GRPCSessionListener, GRPCMessageWriter | Runner, CP | data-model, control-plane |
| `platform/mcp-server.spec.md` | platform | MCP tools (16) | MCP, CLI, SDK | data-model |
| `platform/agent-sandbox-config.spec.md` | platform | Agent (sandbox fields), Provider, Policy | CP, BE, API | data-model |
| `platform/gateway-provisioning.spec.md` | platform | Gateway, PlatformConfig | CP | control-plane |
| `platform/openshell-sandbox-provisioning.spec.md` | platform | Sandbox | CP | gateway-provisioning, agent-sandbox-config |
| `platform/scheduled-session-execution.spec.md` | platform | ScheduledSession | BE, API, CP | data-model |
| `platform/session-activity-tracking.spec.md` | platform | Session (last_activity_at) | BE, API | data-model |
| `platform/agent-inheritance.spec.md` | platform | Agent (kustomize overlays) | CP | agent-sandbox-config |
| `platform/runner-constitution.md` | platform | Runner (governance) | Runner | runner |
| `security/identity-boundaries.spec.md` | security | Identity types (6) | CP, BE, Runner | - |
| `security/sso-authentication.spec.md` | security | OIDC, JWT, BFF session | BE, FE, CLI | identity-boundaries |
| `security/rbac-enforcement.spec.md` | security | Role, RoleBinding, Permission | BE, CP, CLI | data-model, identity-boundaries |
| `security/credential-binding.spec.md` | security | Credential, CredentialBinding | BE, API | data-model, rbac-enforcement |
| `security/credential-encryption.spec.md` | security | Credential (encryption) | BE | credential-binding |
| `security/gateway-rbac-policy.spec.md` | security | Agent (gateway CRUD gating) | BE, FE | rbac-enforcement |
| `security/openshell-sandbox.spec.md` | security | Sandbox (isolation layers) | Runner, CP | identity-boundaries |
| `cli/credentials-tui.spec.md` | cli | Credential, CredentialBinding (TUI) | CLI | data-model, credential-binding |
| `ui/architecture.spec.md` | ui | BFF, Navigation, Design System | FE | sso-authentication |
| `ui/views.spec.md` | ui | Session, Agent, Credential, Schedule views | FE | data-model, architecture |
| `ui/annotations.spec.md` | ui | Annotation keys (20+) | FE | data-model |
| `ui/live-preview.spec.md` | ui | Live preview, SSE updates | FE | architecture |
| `ui/project-sharing.spec.md` | ui | Project sharing, ownership transfer | FE, BE | rbac-enforcement |
| `ui/scheduled-sessions.spec.md` | ui | Schedule CRUD UI | FE | scheduled-session-execution |
| `ui/work-tracking-dashboard.spec.md` | ui | Dashboard, work annotations | FE | annotations, views |
| `standards/control-plane/conventions.spec.md` | standards | - | CP | - |
| `standards/platform/cross-cutting.spec.md` | standards | - | ALL | - |
| `standards/security/security.spec.md` | standards | - | ALL | - |
