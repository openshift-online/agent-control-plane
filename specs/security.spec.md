# Security Specification

Consolidated security spec covering identity boundaries, SSO authentication, RBAC enforcement, credential binding, credential encryption, and sandbox isolation.

---

## Identity Boundaries

The Ambient Code Platform runs agentic AI sessions inside Kubernetes. Each session is a
pod that executes an LLM-powered runner, accesses external services (Vertex AI, GitHub,
Jira), and stores results via the API server.

This specification defines who can do what. Six identity boundaries govern the platform:
an SRE-managed Control Plane that reconciles state across Projects, per-session
ServiceAccounts that isolate runner pods from each other, user SSO tokens that scope
runner authorization to the creating user, global credentials bound to Projects via
RoleBindings (Vertex AI, GitHub/GitLab/Jira/etc.), and a Project-scoped build agent
SA for OpenShift CI/CD workflows.

**Critical gap:** all runner sessions in a Project share a ServiceAccount with unscoped
Secret access. Any session can read another session's runner tokens. This spec closes
that gap with per-session Roles restricted by `resourceNames`.

**Terminology:** Each Project is realized as a single Kubernetes namespace. This spec
uses "Project" for the Ambient isolation boundary and "namespace" only when referring
to the Kubernetes primitive directly.

### Accounts and Tokens

#### Control Plane Identities

| Identity | Type | Owner | Scope | Lifetime | Purpose |
|----------|------|-------|-------|----------|---------|
| `ambient-control-plane` | K8s ServiceAccount | SRE | Cluster (ClusterRole) | Long-lived (token Secret) | Watches API server, reconciles sessions/projects to K8s, writes status back |
| `ambient-control-plane` OIDC token | OAuth2 client_credentials | SRE | API server | Auto-refreshed (30s buffer) | CP authenticates to API server for session/credential CRUD |

#### Platform Service Identities

| Identity | Type | Owner | Scope | Lifetime | Purpose |
|----------|------|-------|-------|----------|---------|
| `backend-api` | K8s ServiceAccount | SRE | Cluster (ClusterRole) | Pod lifetime | Backend API: manages CRs, mints session tokens, validates user tokens |
| `frontend` | K8s ServiceAccount | SRE | Cluster (ClusterRole) | Pod lifetime | Frontend: TokenReview and SubjectAccessReview only |

#### Session Runtime Identities

| Identity | Type | Owner | Scope | Lifetime | Purpose |
|----------|------|-------|-------|----------|---------|
| `ambient-session-<name>` | K8s ServiceAccount | SRE (created by operator) | Project (Role) | Session lifetime | Per-session runner identity; scoped to own secrets and session CR |
| Runner bot token | K8s TokenRequest | SRE (minted by operator) | Session-specific | Mounted + refreshed by kubelet | Runner authenticates to K8s API and API server for status/credential ops |
| Runner AGUI token | UUID | SRE (generated per session) | Session-specific | Session lifetime | Authenticates inbound AG-UI requests to runner pod (bearer validation) |
| CP RSA-encrypted session token | RSA + OIDC exchange | SRE | Session-specific | On-demand (per request) | Runner fetches API token from CP `/token` endpoint using encrypted session ID |

#### User Authentication

| Identity | Type | Owner | Scope | Lifetime | Purpose |
|----------|------|-------|-------|----------|---------|
| User SSO token | OIDC (Red Hat SSO) | User | User's RBAC scope | SSO session TTL | User authenticates to frontend/backend; propagated as `caller_token` to runner |

#### Credentials (Global, Bound via RoleBindings)

| Identity | Type | Owner | Scope | Lifetime | Purpose |
|----------|------|-------|-------|----------|---------|
| `Credential(provider=vertex)` | GCP service account key | User | Global (bound to Projects via RoleBindings) | Until rotated | Vertex AI LLM inference; stored in API server, materialized as K8s Secret per Project |
| `Credential(provider=github)` | PAT or GitHub App token | User | Global (bound to Projects via RoleBindings) | Until rotated | Git operations; fetched at runtime, written to ephemeral storage, cleared per turn |
| `Credential(provider=gitlab)` | PAT | User | Global (bound to Projects via RoleBindings) | Until rotated | GitLab repository access |
| `Credential(provider=jira)` | API token | User | Global (bound to Projects via RoleBindings) | Until rotated | Jira issue tracking integration |
| `Credential(provider=google)` | OAuth2 token | User | Global (bound to Projects via RoleBindings) | Until rotated | Google Workspace integrations |
| `Credential(provider=kubeconfig)` | Kubeconfig | User | Global (bound to Projects via RoleBindings) | Until rotated | Cross-cluster Kubernetes operations |

#### Build Agent Identity (Proposed)

| Identity | Type | Owner | Scope | Lifetime | Purpose |
|----------|------|-------|-------|----------|---------|
| `ambient-agent` | K8s ServiceAccount | SRE | Single Project (Role) | Long-lived | OpenShift build agent: BuildConfig, ImageStream, deploy within one Project |

### Requirements

#### Requirement: Control Plane Identity Isolation

The Control Plane SA SHALL be the only identity that spans Projects. Runner containers
MUST NOT mount or inherit the CP token. The CP SHALL create per-session SAs with scoped
tokens rather than sharing its own.

##### Scenario: Runner cannot access CP token

- GIVEN a runner pod in a Project
- WHEN the pod enumerates available ServiceAccount tokens
- THEN no CP token is present in the pod's filesystem or environment

##### Scenario: CP reconciles across Projects

- GIVEN the Control Plane is running
- WHEN a new session is created in any Project
- THEN the CP reconciles the session to Kubernetes resources in that Project's namespace
- AND uses its own cluster-scoped SA for cross-Project operations

#### Requirement: Vertex AI Credential Scoping

Vertex AI credentials SHALL be global resources bound to Projects via RoleBindings.
The credential token MUST be write-only in the API (never returned in GET responses).
The runner SHALL fetch credentials at runtime via authenticated API calls.

##### Scenario: Credential write-only enforcement

- GIVEN a user creates a `Credential(provider=vertex)` and binds it to a Project
- WHEN another user calls `GET /credentials/{id}`
- THEN the response contains metadata but the `token` field is absent

##### Scenario: Credential materialization

- GIVEN a Project has a Vertex credential
- WHEN a runner pod is provisioned in that Project
- THEN the CP resolves the credential and writes the service account key into a K8s Secret
- AND the runner pod mounts this secret for `GOOGLE_APPLICATION_CREDENTIALS`

##### Scenario: Credential rotation

- GIVEN a Vertex credential is updated via the API
- WHEN the next session is provisioned in that Project
- THEN the CP re-resolves the credential and writes the updated key

#### Requirement: User Token Propagation

The runner SHALL operate with the creating user's authorization context. The runner
MUST NOT access resources the creating user cannot access.

##### Scenario: User SSO token passed to runner

- GIVEN a user authenticates via SSO and creates a session
- WHEN a human interacts via AG-UI
- THEN their bearer token is passed through as `caller_token`
- AND the runner uses this token for API calls, falling back to the bot token only if expired

##### Scenario: Cross-user credential access blocked

- GIVEN user A creates a session
- WHEN user B's token is used to access user A's session credentials
- THEN the backend returns 403 Forbidden

##### Scenario: Bot token scoped to session

- GIVEN a runner pod with a bot token
- WHEN the bot token is used for API calls
- THEN access is restricted to the specific session's resources within the Project

#### Requirement: Integration Credential Isolation

Integration credentials SHALL be global resources. Access SHALL be controlled via
RoleBindings — a credential is only accessible to runners in Projects it has been
bound to. Credential tokens SHALL be write-only in the API.

##### Scenario: Unbound credential access blocked

- GIVEN a GitHub credential exists but is not bound to Project B
- WHEN a runner in Project B attempts to fetch that credential
- THEN the request is denied

##### Scenario: Runner fetches credential at runtime

- GIVEN a GitHub credential is bound to a Project
- WHEN a runner pod in that Project requests the credential token
- THEN the token is returned via the restricted endpoint
- AND the runner writes it to ephemeral storage
- AND the credential is cleared after each turn

##### Scenario: Token fetch restricted to cluster-internal callers

- GIVEN a valid credential token request
- WHEN the caller is not cluster-internal
- THEN the request is denied to prevent token exfiltration

#### Requirement: Agent Credential Isolation

Integration credentials (GitHub, GitLab, Jira, Google, kubeconfig) SHALL
NOT be visible to the agent process. The runner container's environment SHALL NOT
contain integration credential tokens. The agent SHALL access external services
exclusively through MCP tools exposed by sidecar containers with isolated environments.

LLM provider credentials (Anthropic API key, Vertex AI service account) are exempt
from this requirement — they are necessary for the agent's own inference and MAY
remain in the runner container.

##### Scenario: Agent cannot read integration tokens

- GIVEN a runner pod with bound GitHub and Jira credentials
- WHEN the agent enumerates environment variables or reads `/tmp/`
- THEN no integration tokens are present — `GITHUB_TOKEN`, `JIRA_API_TOKEN`, etc. are absent
- AND the agent can only interact with GitHub/Jira via MCP tools

##### Scenario: Credential sidecar holds tokens in isolation

- GIVEN a GitHub credential bound to a Project
- WHEN the CP provisions the session pod
- THEN a `github-mcp` sidecar container is added to the pod spec
- AND the sidecar's environment contains `GITHUB_PERSONAL_ACCESS_TOKEN`
- AND the sidecar exposes MCP tools on a localhost port
- AND the runner container does NOT have `GITHUB_TOKEN` in its environment

##### Scenario: Git write operations use MCP tools, not tokens

- GIVEN the agent needs to push commits to a GitHub repository
- WHEN the agent performs the push
- THEN the agent calls the `github-mcp` sidecar's `PushFiles` or `CreatePullRequest` MCP tools
- AND the sidecar executes the GitHub API call using its isolated token
- AND the runner container never has a git credential helper or token
- AND direct `git push` / `gh pr create` from the runner container SHALL fail (no credentials available)

#### Requirement: MCP Credential Lifecycle

MCP server credentials SHALL follow the same RoleBinding-scoped access model as other
integration credentials. Each integration credential bound to a Project SHALL be
materialized as a sidecar container with its own isolated environment. The sidecar
SHALL manage its own credential refresh cycle.

##### Scenario: Sidecar credential refresh

- GIVEN a credential MCP sidecar running alongside a runner
- WHEN the credential token approaches expiry
- THEN the sidecar re-fetches the token from the backend API using its own auth
- AND the agent is not interrupted or restarted

##### Scenario: Credential-free fallback

- GIVEN a Project with no bound credentials
- WHEN a session is provisioned
- THEN no credential sidecars are injected
- AND the runner operates without integration credentials

#### Requirement: Per-Session Service Account Isolation

Each session MUST have a ServiceAccount that can only access its own resources.
Sessions MUST NOT be able to read other sessions' runner tokens from K8s Secrets.

##### Scenario: Session cannot read another session's secrets

- GIVEN Session A and Session B running in the same Project
- WHEN Session A attempts to read Session B's runner token Secret
- THEN the request is denied by RBAC (`resourceNames` restriction)

##### Scenario: Per-session Role restricts Secret access

- GIVEN a new session is created
- WHEN the operator provisions the session SA
- THEN the Role restricts Secret access to `ambient-runner-token-<sessionName>` and shared read-only secrets
- AND AgenticSession access is restricted to `<sessionName>`

##### Scenario: NetworkPolicy isolates session pods

- GIVEN a session pod is running
- WHEN another session's pod attempts to connect
- THEN the NetworkPolicy blocks the traffic
- AND only the session's own pods and the Control Plane can communicate

##### Scenario: Shared secrets mounted read-only

- GIVEN Project-wide secrets exist (e.g., Vertex credentials)
- WHEN a session pod needs access
- THEN the secrets are mounted as read-only volumes
- AND they are not accessible via the K8s API from the session SA

#### Requirement: Per-Session SA Target State

Each session SA SHALL be restricted to the following resources:

| Resource | Allowed Names | Verbs |
|----------|--------------|-------|
| Secrets | `ambient-runner-token-<sessionName>`, shared secrets (read-only mount) | get |
| Pods | Labeled `ambient-code/session=<sessionName>` | get, list, watch |
| AgenticSessions | `<sessionName>` | get, update (status only) |
| SelfSubjectAccessReviews | (any) | create |

#### Requirement: Build Agent SA Scoping (OpenShift)

The build agent SA SHALL be bound to a single Project. It MUST NOT access other
Projects, nodes, or cluster-scoped resources. It MUST NOT create or modify CRDs,
ClusterRoles, or ClusterRoleBindings.

##### Scenario: Build agent deploys within Project

- GIVEN a build agent SA bound to a Project
- WHEN the agent triggers a BuildConfig
- THEN the build runs within that Project's namespace
- AND images are pushed to the internal registry via `system:image-builder`

##### Scenario: Build agent cannot escalate

- GIVEN a build agent SA bound to a Project
- WHEN the agent attempts to create a ClusterRole
- THEN the request is denied

#### Requirement: Build Agent Permissions

The build agent SA SHALL have the following permissions within its Project:

| API Group | Resources | Verbs |
|-----------|-----------|-------|
| `build.openshift.io` | `buildconfigs`, `buildconfigs/instantiate`, `builds`, `builds/log` | get, list, watch, create, update, patch, delete |
| `image.openshift.io` | `imagestreams`, `imagestreamtags`, `imagestreamimages` | get, list, watch, create, update, patch, delete |
| `apps` | `deployments`, `statefulsets`, `replicasets` | get, list, watch, create, update, patch, delete |
| `""` (core) | `pods`, `pods/log`, `services`, `configmaps`, `secrets`, `persistentvolumeclaims`, `serviceaccounts`, `events` | get, list, watch, create, update, patch, delete |
| `route.openshift.io` | `routes` | get, list, watch, create, update, patch, delete |
| `batch` | `jobs`, `cronjobs` | get, list, watch, create, update, patch, delete |
| `networking.k8s.io` | `networkpolicies` | get, list, watch, create, update, patch, delete |
| `rbac.authorization.k8s.io` | `roles`, `rolebindings` | get, list, watch, create, update, patch, delete |

Additionally requires the built-in `system:image-builder` role for internal registry push access.

### Credential Authorization Model

This section defines how credentials are authorized at runtime. For credential Kind schemas,
API endpoints, and provider enum definitions, see the
[Ambient Data Model Spec](platform.spec.md).

#### Requirement: Credential Access via RoleBindings

Credentials SHALL be global resources. Access SHALL be granted via a RoleBinding with
`scope=credential`, `credential_id=<cred>`, and `project_id=<project>` — `user_id` is
null because the grant is project-level, not user-specific. At session start, the resolver
SHALL list all `scope=credential` RoleBindings where `project_id` matches the session's
project and return the matching credential for each requested provider.

This follows the Kubernetes resource model:

| Ambient | Kubernetes Analogy | Relationship |
|---------|-------------------|--------------|
| Project | Namespace | Isolation boundary |
| Agent | Deployment | Mutable definition, runs workloads |
| Session | Pod | Ephemeral execution, created from Agent |
| Credential | Secret (cross-namespace) | Global resource, bound to Projects via RoleBindings |

Named patterns:
- **Project Robot Account** — credential created globally and bound to a Project; all agents in the Project use it automatically.
- **Multi-Project credential** — bind the same credential to multiple Projects via separate RoleBindings. No duplication of the Credential record.
- **No credential** — Projects without credential bindings run sessions without provider integrations.

##### Scenario: All agents access bound credentials

- GIVEN a GitHub credential is bound to a Project via RoleBinding
- WHEN any agent in that Project starts a session
- THEN the runner can fetch the GitHub credential token

##### Scenario: Unbound credential not accessible

- GIVEN Project A and Project B exist, and a credential is bound only to Project A
- WHEN an agent in Project B requests credentials
- THEN only credentials bound to Project B are returned

#### Requirement: Token Reader Role Grant

The `credential:token-reader` role SHALL be granted to the runner service account by the
platform at session start. It MUST NOT be granted via user-facing `POST /role_bindings`.
It is a platform-internal binding managed by the operator.

Credential CRUD SHALL be governed by the `credential:owner` role. Users with
`credential:owner` can create, update, and delete credentials they own and bind them
to Projects where they hold `project:owner`. Users with `credential:viewer` can read
metadata (not tokens) on credentials bound to Projects they have access to.

##### Scenario: Runner can fetch token

- GIVEN a runner SA with `credential:token-reader` bound at session start
- WHEN the runner calls `GET /credentials/{cred_id}/token`
- THEN the raw token is returned

##### Scenario: Human user cannot fetch token

- GIVEN a human user without `credential:token-reader`
- WHEN they call `GET /credentials/{cred_id}/token`
- THEN the request is denied with 403

#### Requirement: Proxy Authentication

All backend paths not mapped to a native `/api/ambient/v1/...` endpoint SHALL be forwarded
verbatim to the backend service. The API server SHALL authenticate the caller, inject
service credentials, then proxy the request — preserving method, path, query string, body,
and response status.

Runner-internal endpoints (called by runner pods at runtime):
- `POST /api/projects/{p}/agentic-sessions/{s}/github/token` — get a GitHub token for a session
- `GET /api/projects/{p}/agentic-sessions/{s}/credentials/{provider}` — fetch credential by provider
- `POST /api/projects/{p}/agentic-sessions/{s}/runner/feedback` — runner feedback

These endpoints MUST validate the caller is cluster-internal to prevent token exfiltration.

##### Scenario: External caller blocked from runner endpoints

- GIVEN an external client with a valid token
- WHEN they call a runner-internal endpoint
- THEN the request is denied because the caller is not cluster-internal

### Security Boundary Summary

```
+------------------------------------------------------------------+
|                        Cluster                                   |
|                                                                  |
|  +---------------------------+  +-----------------------------+  |
|  | ambient-code (platform)   |  | Project A                   |  |
|  |                           |  |                             |  |
|  | [Control Plane]           |  |  [Session A Pod]            |  |
|  |  SA: ambient-control-plane|  |   SA: ambient-session-aaa   |  |
|  |  - watches API server     |  |   - own secrets only        |  |
|  |  - reconciles to K8s     |  |   - own session CR only     |  |
|  |  - writes status back    |  |   - user's SSO token        |  |
|  |                           |  |   - bound vertex cred       |  |
|  | [API Server]              |  |   +------------------+      |  |
|  |  SA: (pod identity)       |  |   | MCP sidecar/pod  |      |  |
|  |  - PostgreSQL backend     |  |   | - integration     |      |  |
|  |  - Credential store      |  |   | - creds from API  |      |  |
|  |  - RBAC enforcement      |  |   +------------------+      |  |
|  |                           |  |                             |  |
|  | [Backend]                 |  |  [Session B Pod]            |  |
|  |  SA: backend-api          |  |   SA: ambient-session-bbb   |  |
|  |  - user token passthrough|  |   - ISOLATED from A         |  |
|  |  - credential RBAC       |  |   - own secrets only        |  |
|  +---------------------------+  +-----------------------------+  |
|                                                                  |
+------------------------------------------------------------------+
```

**Key Invariants:**
1. No runner session can access another session's secrets or tokens
2. No runner session can operate beyond the user's own authorization scope
3. Integration credentials are global, bound to Projects via RoleBindings, and fetched at runtime, never baked in
4. The Control Plane SA is the only identity that spans Projects
5. Integration credentials are isolated in sidecar containers; the agent process has no access to integration tokens via environment, filesystem, or process inheritance
6. LLM provider credentials (Anthropic API key, Vertex SA) are exempt from sidecar isolation — they remain in the runner container

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| Agent ownership via RBAC, not a hardcoded FK | Ownership is expressed as a RoleBinding (`scope=agent`, `agent_id=<id>`, `user_id=<owner>`). Enables multi-owner and delegated ownership consistently across all Kinds. |
| Credential is global, bound via RoleBindings | Credentials are global resources. Access is granted by a RoleBinding with `scope=credential`, `credential_id=<cred>`, `project_id=<project>`, `user_id=NULL`. A single credential can be shared across multiple Projects without duplication. |
| RoleBinding uses typed nullable FKs, not a polymorphic scope_id string | Each FK (`user_id`, `project_id`, `agent_id`, `session_id`, `credential_id`) is nullable. `scope` discriminates which FK identifies the bound resource. Enables real referential integrity constraints; `user_id` is null for non-user grants (e.g. project-level credential access). |
| Credential token is write-only | Prevents token exfiltration via the standard REST API. Raw token only surfaced to runners via the runtime credentials path, not to end users. |
| Five-scope RBAC (`global`, `project`, `agent`, `session`, `credential`) | Credential access is explicit via RoleBindings with `credential` scope. Enables cross-project sharing without credential duplication. |
| Credential CRUD governed by credential roles | `credential:owner` manages CRUD and bindings. `credential:viewer` reads metadata. Self-service: users create their own credentials without admin intervention. |
| `agent:runner` role | Pods get minimum viable credential: read agent definition, push session messages, send inbox. |
| Union-only permissions | No deny rules — simpler mental model for fleet operators. |
| Token stored in database, encrypted at rest | Single authoritative store. A future Vault integration can be adopted by pointing the DB row at a Vault path without changing the API surface. |
| `google` token serialized as a string | Service Account JSON is serialized into the single `token` field. Keeps the schema uniform across all providers. |
| Integration credentials isolated in sidecars, not runner env | Prevents token exfiltration by the agent via `Bash`/`Read` tools. The agent interacts with external services only through MCP tools. Sidecar containers have isolated environments containing only their own credentials. |
| No validation on creation | First-use error is acceptable. Avoids a network call to the provider at creation time and the failure modes that come with it. |
| Credential rotation is user-managed | Users update the token via `PATCH` or `acpctl credential update`. No platform-side rotation or expiry tracking. |
| No migration utility for existing K8s Secrets | Users re-enter credentials via the new API. The old Secret-based path is removed when the new API is live. |
| Dedicated tokens, not personal credentials | Users are expected to create dedicated Robot Accounts or PATs, not share their personal credentials. A single credential can be bound to multiple Projects. |

---

## SSO Authentication

The platform SHALL authenticate all human users via OpenID Connect (OIDC) with Red Hat
SSO and represent user identity as signed JWTs throughout the stack. This
replaces the current model where an OpenShift OAuth proxy sidecar produces opaque tokens
that are forwarded to backends.

The migration unifies the authentication model: every component that needs to know "who
is this user?" validates a JWT against the SSO issuer's JWKS endpoint — no component
relies on opaque tokens, OAuth proxy headers, or Kubernetes TokenReview for human user
identity.

### Identity Flow

```
Browser ──OIDC session cookie──▸ Next.js (BFF) ──JWT──▸ Backend / API Server
                                      │                        │
                                      │                        ├─ Validate JWT (JWKS)
                                      │                        ├─ Extract identity (claims)
                                      │                        └─ K8s client: SA token
                                      │                             + Impersonate-User
                                      │                             + Impersonate-Group
                                      ▼                              │
                                 Red Hat SSO                    K8s API Server
                             (confidential client)          (RBAC as impersonated user)
```

### Requirements

#### Requirement: BFF OIDC Session Model

The frontend SHALL act as an OIDC confidential client using the Authorization Code Flow.
The browser SHALL receive an opaque, httpOnly, secure, SameSite OIDC session cookie —
never a raw JWT. The frontend server SHALL exchange the OIDC session for a JWT when
proxying requests to backend services.

The OIDC callback route SHALL coexist with existing integration auth routes under
`/api/auth/` (GitHub, GitLab, Jira, Google, Gerrit, CodeRabbit). The OIDC callback
MUST NOT conflict with or disrupt those routes.

##### Scenario: User login

- GIVEN a user navigates to the platform
- WHEN they are not authenticated
- THEN the frontend redirects to the SSO authorization endpoint
- AND the SSO login page is displayed

##### Scenario: OIDC callback

- GIVEN the user completes SSO authentication
- WHEN SSO redirects to the frontend OIDC callback route
- THEN the frontend exchanges the authorization code for tokens
- AND stores the OIDC session server-side
- AND sets an httpOnly, secure, SameSite cookie on the browser

##### Scenario: OIDC routes coexist with integration auth routes

- GIVEN existing integration auth routes at `/api/auth/{provider}/connect`, `/api/auth/{provider}/status`, etc.
- WHEN the OIDC callback route is added
- THEN integration auth routes continue to function unchanged
- AND the OIDC route does not shadow or intercept integration auth requests

##### Scenario: Authenticated API request

- GIVEN a user with a valid OIDC session cookie
- WHEN the browser makes an API request to the frontend
- THEN the frontend extracts the JWT from the server-side OIDC session
- AND forwards it as `Authorization: Bearer <jwt>` to the upstream backend

##### Scenario: Token refresh

- GIVEN a user's access token has expired but the refresh token is valid
- WHEN the user makes a request
- THEN the frontend refreshes the access token using the refresh token
- AND the OIDC session is updated transparently

##### Scenario: Logout

- GIVEN a user clicks logout
- WHEN the logout request is processed
- THEN the frontend destroys the server-side OIDC session
- AND clears the OIDC session cookie
- AND redirects to the SSO logout endpoint for single sign-out

#### Requirement: JWT Validation

Every backend service that receives a user request SHALL validate the JWT before
processing. Validation SHALL verify: signature against the SSO issuer's JWKS endpoint,
`exp` (expiration), `iss` (issuer), and `aud` (audience). Services MUST reject tokens
that fail any check with HTTP 401.

##### Scenario: Valid JWT accepted

- GIVEN a request with a valid, unexpired JWT signed by the SSO issuer
- WHEN the backend receives the request
- THEN the request is processed normally
- AND user identity is extracted from standard OIDC claims (`sub`, `email`, `preferred_username`, `groups`)

##### Scenario: Expired JWT rejected

- GIVEN a request with an expired JWT
- WHEN the backend receives the request
- THEN the backend returns 401 Unauthorized

##### Scenario: Wrong audience rejected

- GIVEN a JWT with an `aud` claim that does not match the service's expected audience
- WHEN the backend receives the request
- THEN the backend returns 401 Unauthorized

##### Scenario: Tampered JWT rejected

- GIVEN a JWT with a modified payload but original signature
- WHEN the backend receives the request
- THEN signature verification fails
- AND the backend returns 401 Unauthorized

##### Scenario: JWKS key rotation

- GIVEN the SSO issuer rotates its signing keys
- WHEN a JWT signed with the new key is received
- THEN the backend fetches the updated JWKS
- AND validates the JWT against the new key

#### Requirement: K8s Authorization via Impersonation

The legacy backend SHALL use its own ServiceAccount token for all Kubernetes API calls
and SHALL set impersonation headers to represent the authenticated user's identity.
K8s RBAC SHALL evaluate permissions as the impersonated user, preserving all existing
per-user RoleBindings and SelfSubjectAccessReview checks.

The backend ServiceAccount SHALL have a ClusterRole granting the `impersonate` verb on
`users`, `groups`, and `serviceaccounts` resources. The `serviceaccounts` resource is
required because API key tokens represent K8s ServiceAccount identities.

##### Scenario: List resources respects user RBAC

- GIVEN a user with access to Project A but not Project B
- WHEN the user lists AgenticSessions
- THEN the backend sets `Impersonate-User` to the user's identity from JWT claims
- AND K8s returns only AgenticSessions in Project A
- AND AgenticSessions in Project B are not visible

##### Scenario: Create resource with RBAC check

- GIVEN a user with `create` permission for AgenticSessions in a Project
- WHEN the user creates an AgenticSession
- THEN the backend validates the JWT
- AND sets impersonation headers on the K8s client
- AND the SSAR succeeds because the user has the required RoleBinding
- AND the backend creates the resource using its SA (existing pattern)

##### Scenario: Unauthorized create rejected

- GIVEN a user without `create` permission for AgenticSessions in a Project
- WHEN the user attempts to create an AgenticSession
- THEN the backend sets impersonation headers on the K8s client
- AND the SSAR fails
- AND the backend returns 403 Forbidden

##### Scenario: Audit trail preserved

- GIVEN a user performs an operation via impersonation
- WHEN K8s audit logging records the API call
- THEN the audit log entry includes the impersonated user identity
- AND the acting ServiceAccount identity

##### Scenario: Impersonation RBAC enforced

- GIVEN the backend ServiceAccount
- WHEN the SA attempts to impersonate a user
- THEN K8s verifies the SA has the `impersonate` verb on the appropriate resource
- AND the impersonation succeeds only if the RBAC binding exists

#### Requirement: SSAR Compatibility

SelfSubjectAccessReview (SSAR) calls SHALL work identically under impersonation. The
backend SHALL issue SSARs via K8s clients configured with impersonation headers so that
K8s evaluates the impersonated user's permissions, not the ServiceAccount's permissions.

The SSAR result cache SHALL include the impersonated user identity in the cache key.
Under impersonation, the bearer token is the backend ServiceAccount's token (shared
across all requests), so caching by token alone would cause cross-user authorization
leaks.

##### Scenario: SSAR with impersonation

- GIVEN a user authenticated via JWT with email `user@example.com`
- WHEN the backend performs an SSAR to check if the user can list AgenticSessions in namespace `project-a`
- THEN the K8s client is configured with `Impersonate-User: user@example.com`
- AND K8s evaluates the SSAR against `user@example.com`'s RoleBindings
- AND the result reflects the user's actual permissions

##### Scenario: SSAR cache isolation

- GIVEN user A and user B both make requests
- WHEN the backend caches SSAR results
- THEN user A's cached result is NOT returned for user B
- AND cache keys include the impersonated identity

#### Requirement: API Key Authentication

API keys (K8s ServiceAccount tokens) SHALL continue to be accepted as an alternative
to SSO JWTs. When the backend receives a bearer token that is not a valid JWT (fails
JWT parsing), it SHALL fall back to Kubernetes TokenReview to validate the token as a
ServiceAccount token. API key identity SHALL be resolved from the ServiceAccount's
annotations (existing pattern).

This dual-path authentication is required because API keys are minted as K8s
ServiceAccount tokens and cannot be replaced with SSO JWTs.

##### Scenario: API key accepted

- GIVEN a request with a valid K8s ServiceAccount token (API key)
- WHEN the backend receives the request
- THEN JWT validation fails (token is not a JWT)
- AND the backend falls back to TokenReview
- AND the token is validated as a K8s ServiceAccount
- AND user identity is resolved from the ServiceAccount's annotations

##### Scenario: API key impersonation

- GIVEN a validated API key with a resolved user identity
- WHEN the backend makes K8s API calls
- THEN impersonation headers reflect the API key's associated user
- AND RBAC is enforced for that user

##### Scenario: Invalid token rejected

- GIVEN a token that is neither a valid JWT nor a valid K8s ServiceAccount token
- WHEN the backend receives the request
- THEN both JWT validation and TokenReview fail
- AND the backend returns 401 Unauthorized

#### Requirement: Identity Claim Mapping

User identity SHALL be derived from JWT claims. The following standard OIDC claims
SHALL be used:

| Claim | Maps to | Used for |
|-------|---------|----------|
| `sub` | User ID | Unique identifier, RoleBinding subjects |
| `email` | User email | Display, notifications, RoleBinding subjects |
| `preferred_username` | Username | Display, audit logs |
| `groups` | Group membership | Group-based RBAC, impersonation groups |

The platform SHALL support configuring which claim is used for the K8s `Impersonate-User`
value. The default SHALL be `email` to match existing RoleBinding subjects that use
email addresses.

##### Scenario: Identity extracted from JWT

- GIVEN a JWT with claims `{"sub": "f:abc:jsell", "email": "jsell@redhat.com", "preferred_username": "jsell", "groups": ["team-ambient"]}`
- WHEN the backend processes the request
- THEN `Impersonate-User` is set to `jsell@redhat.com`
- AND `Impersonate-Group` is set to `["team-ambient"]`

#### Requirement: Runner Token Propagation

The runner SHALL continue to receive the human user's token as `caller_token` via the
`x-caller-token` header on AG-UI interactions. With SSO authentication, `caller_token`
is a JWT. The runner uses `caller_token` only for API server HTTP calls (credential
fetches, feedback), never for direct K8s API calls. The runner's own K8s access SHALL
continue to use its per-session ServiceAccount bot token.

##### Scenario: caller_token is a JWT

- GIVEN a user interacts with a running session via AG-UI
- WHEN the frontend proxies the interaction to the runner
- THEN the `x-caller-token` header contains the user's SSO JWT
- AND the runner uses it for credential fetch calls
- AND the runner falls back to `BOT_TOKEN` if the caller token is expired

#### Requirement: CLI Authentication

The CLI SHALL authenticate via OIDC Authorization Code Flow with PKCE against the SSO
issuer. The CLI SHALL store the refresh token for automatic token renewal. The CLI
is a public client (it cannot hold a client secret).

##### Scenario: CLI login

- GIVEN a user runs the CLI login command
- WHEN the CLI initiates the OIDC flow
- THEN it opens the user's browser to the SSO authorization endpoint with PKCE challenge
- AND listens for the callback on a local port
- AND exchanges the authorization code for tokens
- AND persists the access token and refresh token

##### Scenario: CLI token refresh

- GIVEN a user's CLI access token has expired
- WHEN the user runs any CLI command
- THEN the CLI refreshes the token using the stored refresh token
- AND updates the stored tokens

#### Requirement: Local Development Authentication

The Kind and local-dev environments SHALL include a Keycloak instance as part of the
dev stack, providing a real OIDC flow without requiring VPN access to Red Hat SSO.
This replaces the static JWKS ConfigMap, `DISABLE_AUTH=true` mock mode, and
`OC_TOKEN` / `ENABLE_OC_WHOAMI` env vars as the primary local auth mechanism.

Keycloak SHALL start with a pre-configured realm requiring no manual setup.
The realm configuration SHALL be version-controlled in the repository as a
Keycloak realm export (JSON).

The pre-configured realm SHALL include:

- A confidential client for the frontend BFF (redirect URI to localhost)
- A public client for the CLI (PKCE, redirect to localhost callback)
- A default dev user with admin-level project access and standard OIDC claims
  (`email`, `preferred_username`, `groups`)

The backend and API server SHALL validate JWTs against the local Keycloak's JWKS
endpoint using the same code path as production. No special dev-only validation
logic SHALL exist — the only difference is which JWKS endpoint is configured.

Mock identity mode (`DISABLE_AUTH=true`) MAY be retained as a lightweight fallback
for rapid iteration when the full OIDC flow is not needed. Mock identity mode
MUST NOT be available in production deployments.

##### Scenario: Kind cluster bootstrap includes Keycloak

- GIVEN a developer runs the Kind cluster bootstrap
- WHEN the cluster is ready
- THEN a Keycloak instance is running with the pre-configured realm
- AND the frontend, backend, and API server are configured to use it
- AND no manual Keycloak setup is required

##### Scenario: Developer login via local Keycloak

- GIVEN a running Kind cluster with Keycloak
- WHEN a developer navigates to the frontend
- THEN they are redirected to the local Keycloak login page
- AND they can log in with the pre-configured dev credentials
- AND the frontend receives a real JWT and establishes an OIDC session cookie

##### Scenario: Backend validates local Keycloak JWTs

- GIVEN a Kind cluster with Keycloak
- WHEN the backend receives a JWT signed by the local Keycloak
- THEN it validates the JWT against Keycloak's JWKS endpoint
- AND extracts identity from standard OIDC claims
- AND impersonation works with the dev user's identity
- AND the validation code path is identical to production

##### Scenario: CLI authenticates against local Keycloak

- GIVEN a running Kind cluster with Keycloak
- WHEN a developer runs the CLI login command targeting the local environment
- THEN the CLI performs OIDC auth code + PKCE against the local Keycloak
- AND receives a valid JWT

##### Scenario: Realm config is version-controlled

- GIVEN the Keycloak realm export JSON is stored in the repository
- WHEN a developer modifies the realm config (adds a client, changes roles)
- THEN the change is reviewed via normal pull request process
- AND all developers get the updated config on their next cluster bootstrap

##### Scenario: Mock identity fallback

- GIVEN `DISABLE_AUTH=true` is set in a local dev environment
- WHEN a request arrives without a JWT
- THEN the backend uses a configurable mock identity
- AND impersonation is set to the mock user
- AND this mode MUST NOT be available in production deployments

#### Requirement: E2E Test Authentication

End-to-end tests SHALL authenticate without requiring interactive SSO login. The
platform SHALL support a non-interactive authentication path for test automation.
In Kind environments, E2E tests SHALL use the local Keycloak instance.

##### Scenario: E2E test with client_credentials grant

- GIVEN an E2E test environment with a Keycloak client_credentials client
- WHEN the test suite starts
- THEN it obtains a JWT via the client_credentials grant against Keycloak
- AND uses the JWT for all API requests during the test run

##### Scenario: E2E test against local Keycloak

- GIVEN a Kind cluster with the local Keycloak running
- WHEN the E2E test suite starts
- THEN it authenticates against the local Keycloak using pre-configured test credentials
- AND the backend validates the resulting JWT normally

##### Scenario: E2E token not exposed to browser

- GIVEN the E2E test authentication token
- WHEN the test framework injects the token
- THEN the token SHALL be injected server-side (via cookie or API route)
- AND SHALL NOT be exposed as a browser-accessible environment variable

#### Requirement: Feature-Flagged Migration

The transition from OAuth proxy to SSO authentication SHALL be gated behind a feature
flag (`sso-authentication` in Unleash). During migration, the platform SHALL support
both authentication modes simultaneously. The feature flag SHALL control which
authentication path is active per deployment.

This is an infrastructure flag, not a user-facing feature toggle. It is not visible
in workspace settings and is not user-configurable. The ops team enables it
per-environment as part of the SSO rollout.

##### Scenario: Legacy mode (flag off)

- GIVEN the SSO auth feature flag is disabled
- WHEN a request arrives with an OAuth proxy header
- THEN the backend uses the existing OAuth proxy flow
- AND K8s calls use the opaque token directly as a bearer token

##### Scenario: SSO mode (flag on)

- GIVEN the SSO auth feature flag is enabled
- WHEN a request arrives with `Authorization: Bearer <jwt>`
- THEN the backend validates the JWT against the JWKS endpoint
- AND K8s calls use impersonation

##### Scenario: Flag removal

- GIVEN the SSO auth migration is complete across all environments
- WHEN the feature flag is removed
- THEN all OAuth proxy code paths, forwarded header handling, and opaque token
  support SHALL be removed
- AND the OAuth proxy sidecar manifests SHALL be deleted

#### Requirement: Manifest Changes

The deployment manifests SHALL be updated to support the new authentication model.

##### Scenario: OAuth proxy sidecar removed

- GIVEN a production deployment with SSO auth enabled
- WHEN the frontend is deployed
- THEN no OAuth proxy sidecar container is present
- AND the frontend Service routes traffic directly to the Next.js container port

##### Scenario: SSO client credentials provisioned

- GIVEN a deployment with SSO auth enabled
- WHEN the frontend pod starts
- THEN a K8s Secret containing `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, and `SSO_ISSUER_URL`
  is mounted into the frontend container

#### Requirement: SSO Client Configuration

Each deployed environment SHALL have its own OIDC confidential client registered in
Red Hat SSO. The client SHALL be configured with:

- Client authentication enabled (confidential)
- Authorization Code grant type
- Valid redirect URI pointing to the frontend OIDC callback route
- Valid post-logout redirect URI pointing to the frontend root
- Web origins matching the frontend host (for CORS on the token endpoint)

Local development environments (Kind, local-dev) SHALL use a local Keycloak instance
with pre-configured clients instead of registering clients in Red Hat SSO.

In deployed environments where the platform operates its own Keycloak instance, that
instance MAY be federated to Red Hat SSO via Identity Brokering — Keycloak delegates
login to RH SSO but issues its own tokens. This provides full client management
autonomy without requiring RH SSO realm admin access.

##### Scenario: One client per environment

- GIVEN stage and production deployments
- WHEN SSO clients are registered
- THEN each environment has its own client with its own secret
- AND a compromised secret in one environment does not affect others

##### Scenario: Audience isolation

- GIVEN separate clients for stage and production
- WHEN a JWT is minted for the stage client
- THEN the `aud` claim contains the stage client ID
- AND the production backend rejects it because the audience does not match

##### Scenario: Backend impersonation RBAC provisioned

- GIVEN a deployment with SSO auth enabled
- WHEN the backend pod starts
- THEN the backend ServiceAccount has a ClusterRoleBinding granting `impersonate` verb
  on `users`, `groups`, and `serviceaccounts` resources

### Roadmap

This spec covers **Phase 1** of a broader IAM consolidation. The full roadmap, informed
by the [IAM consolidation proposal](../../docs/internal/proposals/iam-consolidation-plan.md)
(PR #1466), is:

| Phase | Scope | Depends on |
|-------|-------|------------|
| **1. SSO user auth + impersonation** (this spec) | Frontend BFF, backend JWT validation, K8s impersonation. API keys and runner auth unchanged. | SSO confidential client registration |
| **2. API keys → SSO service accounts** | Replace K8s SA-based API keys with Keycloak confidential clients. Eliminates TokenReview fallback, K8s SA creation, and `last-used-at` annotation patching. | Keycloak Admin API access (`manage-clients` realm role) |
| **3. Runner auth → OIDC token exchange** | Replace RSA keypair exchange with RFC 8693 token exchange. Runner exchanges projected K8s SA token for an SSO-issued JWT. Eliminates CP token server, RSA bootstrap, and operator 45-min refresh loop. | SSO token exchange enabled; SSO trusts cluster JWKS as identity provider |
| **4. DB RBAC reconciler** | DB `role_bindings` table becomes single write plane. Reconciler syncs K8s RoleBindings from DB state. Eliminates dual-grant problem (K8s RBAC + DB RBAC). | Phases 1-2 complete |
| **5. Credential consolidation** | Move per-user OAuth integration tokens (GitLab, Google, Jira, Gerrit, CodeRabbit) from K8s Secrets to the `credentials` table. Single audit trail and access control. | Phase 4 (DB RBAC) |

Phase 1 is designed to be independently shippable. Each subsequent phase removes a
category of K8s-managed identity state and moves it to SSO or the database, converging
toward a single IAM plane.

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| BFF with confidential client (not public client in browser) | IETF recommendation for web apps. Tokens never reach the browser, eliminating XSS-based token theft. Next.js already acts as a proxy, making BFF natural. |
| K8s impersonation (not cluster OIDC federation) | Platform MUST work on any K8s cluster (Kind, ROSA classic, ROSA HCP) without cluster-level OIDC configuration. Impersonation is a standard K8s feature available everywhere. |
| `email` claim as default impersonation identity | Existing RoleBindings use email addresses as subject names. Using `email` preserves all existing RBAC bindings without migration. |
| Feature-flagged migration (not big-bang cutover) | Enables incremental rollout, environment-by-environment. Legacy OAuth proxy path remains available as fallback. |
| Supersede ADR-0002 (not amend) | ADR-0002's core assumption — the auth token is a K8s-native opaque token — is no longer true. The security contract (user operations use user permissions) is preserved; only the mechanism changes. |
| CLI remains a public client with PKCE | CLIs cannot securely store client secrets. PKCE provides equivalent security for native apps per RFC 7636. |
| Dual-path auth (JWT + TokenReview) | API keys are K8s ServiceAccount tokens that cannot be replaced with SSO JWTs. The backend tries JWT first, falls back to TokenReview, preserving both authentication paths. |
| SSAR cache includes impersonated identity | Under impersonation, the bearer token is shared (backend SA). Caching by token alone would leak authorization decisions across users. |
| E2E tokens injected server-side | Browser-exposed test tokens (via `NEXT_PUBLIC_*` env vars) are an XSS risk. Server-side injection via cookies or API routes prevents accidental token exposure. |
| Local Keycloak for dev (not mock mode or static JWKS) | Real OIDC flow in dev catches integration issues early. Same validation code path as production — no dev-only auth logic to maintain. Replaces ad-hoc static JWKS ConfigMap, `DISABLE_AUTH`, and `OC_TOKEN` env vars. |
| Keycloak Identity Brokering for deployed environments | Federating to RH SSO provides full client management autonomy without requiring realm admin access. Only one client registration needed in RH SSO (the Keycloak instance itself). |

---

## RBAC Enforcement

The ambient-api-server SHALL enforce scope-aware authorization on all API endpoints
(HTTP and gRPC) using the database-backed Role and RoleBinding model defined in the
[Ambient Data Model Spec](platform.spec.md). Every request that passes
authentication SHALL be evaluated against the caller's role bindings, restricting
access to the specific resources identified by each binding's scope. Users start with
zero permissions and gain access by creating projects (self-service) or receiving
grants from existing owners.

All user authentication is via JWT (SSO or local Keycloak). The
[SSO Authentication Spec](#sso-authentication) governs how JWTs are obtained
and validated; this spec governs what happens after authentication succeeds.

### Requirements

#### Requirement: Scope-Aware Permission Evaluation

The authorization middleware SHALL evaluate permissions against the binding's scope
context, not just the permission string. A binding with `scope=project` and
`project_id=A` SHALL only authorize access to resources within Project A.

The middleware SHALL extract the resource scope context from the request URL. For
project-scoped routes (`/projects/{id}/...`), the project ID is the path parameter.
For top-level routes (`/sessions/{id}`), the middleware SHALL resolve the owning
project from the database when scope filtering is required.

Bindings at broader scopes grant access to all resources within that scope:

- `global` grants access to all resources on the platform
- `project` grants access to all resources within one project (agents, sessions, inbox)
- `agent` grants access to one agent and its sessions
- `session` grants access to one session run
- `credential` governs access to one credential record

Effective permissions = union of all bindings that match the request context. No deny
rules.

##### Scenario: Project-scoped binding restricts access

- GIVEN user A has `project:editor` bound with `scope=project`, `project_id=proj-1`
- WHEN user A calls `GET /projects/proj-2/agents`
- THEN the middleware returns 403 Forbidden
- AND user A's binding for proj-1 is not considered because proj-2 is requested

##### Scenario: Global binding grants cross-project access

- GIVEN user A has `platform:admin` bound with `scope=global`
- WHEN user A calls `GET /projects/proj-2/agents`
- THEN the request is authorized
- AND all agents in proj-2 are returned

##### Scenario: Agent-scoped binding restricts to one agent

- GIVEN user A has `agent:operator` bound with `scope=agent`, `agent_id=agent-1`
- WHEN user A calls `PATCH /projects/proj-1/agents/agent-2`
- THEN the middleware returns 403 Forbidden
- AND user A's binding for agent-1 does not grant access to agent-2

##### Scenario: Scope hierarchy inheritance

- GIVEN user A has `project:owner` bound with `scope=project`, `project_id=proj-1`
- WHEN user A calls `GET /projects/proj-1/agents/agent-1`
- THEN the request is authorized
- AND the project-scoped binding covers all agents within that project

##### Scenario: Multiple bindings evaluated as union

- GIVEN user A has `project:viewer` on proj-1 AND `project:editor` on proj-2
- WHEN user A calls `POST /projects/proj-2/agents`
- THEN the request is authorized via the proj-2 editor binding
- AND the proj-1 viewer binding does not interfere

#### Requirement: Resource List Filtering

List endpoints SHALL return only resources the caller has access to, based on their
bindings. A user with bindings for Projects A and B SHALL see only resources from those
two projects, not the full table.

The middleware SHALL NOT return 403 for list endpoints when the caller has zero matching
resources — it SHALL return an empty list. List access is implicit: if a user holds any
binding that grants `read` or `list` on a resource type, they can call the list endpoint.
The response is filtered to resources within their authorized scope.

##### Scenario: Session list filtered by project bindings

- GIVEN user A has `project:viewer` on proj-1 only
- AND sessions exist in proj-1 and proj-2
- WHEN user A calls `GET /sessions`
- THEN only sessions belonging to proj-1 are returned
- AND sessions in proj-2 are omitted

##### Scenario: Project list filtered by bindings

- GIVEN user A has bindings for proj-1 and proj-3
- AND proj-1, proj-2, proj-3 exist
- WHEN user A calls `GET /projects`
- THEN only proj-1 and proj-3 are returned

##### Scenario: Platform viewer sees all

- GIVEN user A has `platform:viewer` with `scope=global`
- WHEN user A calls `GET /sessions`
- THEN all sessions across all projects are returned

##### Scenario: No bindings returns empty list

- GIVEN user A has no project bindings
- WHEN user A calls `GET /sessions`
- THEN an empty list is returned with HTTP 200
- AND the response is not 403

#### Requirement: User Auto-Provisioning

The system SHALL automatically create a User record when a JWT-authenticated caller
is seen for the first time. The User record SHALL be populated from standard OIDC claims
(`sub`, `email`, `preferred_username`). No explicit `POST /users` is required for
bootstrap.

Auto-provisioning SHALL NOT grant any role bindings. The new user starts with zero
permissions and gains access by creating a project or receiving a grant from an
existing owner.

Auto-provisioning SHALL only apply to JWT-authenticated human users. Service callers
authenticating with the platform service token SHALL NOT trigger user auto-provisioning.

##### Scenario: First-time user auto-provisioned

- GIVEN a user authenticates via SSO for the first time
- AND no User record exists for their identity
- WHEN any authenticated API request is processed
- THEN a User record is created from the JWT claims
- AND no role bindings are created
- AND the request proceeds to authorization evaluation

##### Scenario: Existing user not duplicated

- GIVEN a user has an existing User record
- WHEN the user authenticates again
- THEN no duplicate User record is created
- AND the existing record is used

##### Scenario: Concurrent first-time requests are idempotent

- GIVEN a user authenticates for the first time
- WHEN two requests arrive simultaneously before either commits a User record
- THEN exactly one User record is created (upsert semantics)
- AND both requests proceed normally

##### Scenario: Service caller does not trigger auto-provisioning

- GIVEN a request authenticates with the platform service token
- WHEN the request is processed
- THEN no User record is created
- AND the request bypasses RBAC as a service caller

#### Requirement: Bootstrap via Project Creation

Any authenticated user SHALL be able to create a project. `POST /projects` SHALL be
exempt from authorization checks — only authentication (valid JWT) is required. On
successful project creation, the system SHALL automatically create a `project:owner`
RoleBinding for the authenticated user, scoped to the new project.

This is the platform's bootstrap mechanism. Users start with zero bindings and gain
access by creating a project.

##### Scenario: New user creates their first project

- GIVEN a user authenticates via SSO for the first time
- AND the user has zero role bindings
- WHEN the user calls `POST /projects` with `{"name": "my-project"}`
- THEN the project is created
- AND a RoleBinding is created: `role=project:owner`, `scope=project`, `project_id=my-project`, `user_id=<caller>`
- AND the user can immediately manage the project

##### Scenario: Project owner binding is atomic with creation

- GIVEN a user creates a project
- WHEN the project is persisted
- THEN the RoleBinding is created in the same database transaction
- AND if the RoleBinding creation fails, the project creation is rolled back

##### Scenario: New user cannot list other projects

- GIVEN a new user with zero bindings
- WHEN the user calls `GET /projects`
- THEN an empty list is returned
- AND no other users' projects are visible

##### Scenario: New user cannot access existing resources

- GIVEN a new user with zero bindings
- WHEN the user calls `GET /sessions` or `GET /projects/other-project`
- THEN the sessions list is empty
- AND the project get returns 404 (existence not disclosed)

#### Requirement: Credential Self-Service Bootstrap

Any authenticated user SHALL be able to create a credential. `POST /credentials` SHALL
be exempt from authorization checks — only authentication is required. On successful
credential creation, the system SHALL automatically create a `credential:owner`
RoleBinding for the authenticated user, scoped to the new credential.

Binding a credential to a project (`POST /role_bindings` with `scope=credential`)
SHALL require the caller to hold **both** `credential:owner` on the credential being
bound AND `project:owner` on the target project.

##### Scenario: User creates a credential

- GIVEN an authenticated user
- WHEN the user calls `POST /credentials` with a valid payload
- THEN the credential is created
- AND a RoleBinding is created: `role=credential:owner`, `scope=credential`, `credential_id=<new-id>`, `user_id=<caller>`

##### Scenario: Credential owner binding is atomic with creation

- GIVEN a user calls `POST /credentials`
- WHEN the credential is persisted
- THEN the `credential:owner` RoleBinding is created in the same database transaction
- AND if the RoleBinding creation fails, the credential creation is rolled back

##### Scenario: Credential owner binds to their project

- GIVEN user A owns credential C and holds `project:owner` on proj-1
- WHEN user A calls `POST /role_bindings` with `scope=credential`, `credential_id=C`, `project_id=proj-1`
- THEN the binding is created
- AND runners in proj-1 can access credential C

##### Scenario: Non-project-owner cannot bind credential to project

- GIVEN user B does NOT hold `project:owner` on proj-1
- WHEN user B calls `POST /role_bindings` with `scope=credential`, `credential_id=C`, `project_id=proj-1`
- THEN the request returns 403 Forbidden

##### Scenario: Non-credential-owner cannot bind credential to project

- GIVEN user B holds `project:owner` on proj-1 but does NOT hold `credential:owner` on credential C
- WHEN user B calls `POST /role_bindings` with `scope=credential`, `credential_id=C`, `project_id=proj-1`
- THEN the request returns 403 Forbidden

##### Scenario: Credential list filtered by ownership

- GIVEN user A owns credentials C1 and C2
- AND user B owns credential C3
- WHEN user A calls `GET /credentials`
- THEN only C1 and C2 are returned

#### Requirement: Platform Admin Seeding

The first `platform:admin` binding SHALL be created via a CLI command or database
migration, not through the API. This breaks the bootstrap chicken-and-egg: RBAC
endpoints for role binding mutation are themselves RBAC-gated, so the first admin
cannot grant themselves access through the API.

The platform SHALL provide a CLI command to seed the initial admin binding. Subsequent
admins can be granted access through the API by existing admins.

##### Scenario: Seed first admin via CLI

- GIVEN a fresh deployment with no role bindings
- WHEN an operator runs the admin seeding CLI command with a username
- THEN a RoleBinding is created: `role=platform:admin`, `scope=global`, `user_id=<username>`
- AND the admin can now manage all platform resources via the API

##### Scenario: Existing admin grants new admin

- GIVEN user A has `platform:admin`
- WHEN user A calls `POST /role_bindings` with `role_id=<platform:admin role>`, `scope=global`, `user_id=B`
- THEN user B receives platform:admin access

##### Scenario: Non-admin cannot create global bindings

- GIVEN user A has `project:owner` on proj-1 (but not platform:admin)
- WHEN user A calls `POST /role_bindings` with `scope=global`
- THEN the request returns 403 Forbidden

#### Requirement: RoleBinding Mutation Authorization

Creating, updating, and deleting role bindings SHALL be authorized based on the
caller's existing bindings. A user SHALL only be able to grant roles **strictly
below** their own level in the role hierarchy. This prevents privilege escalation —
no user can mint a peer at their own tier. The sole exception is `platform:admin`,
which MAY grant `platform:admin` to others (since there is no higher role).

The role hierarchy for escalation checks (higher number = lower privilege):

| Level | Roles |
|-------|-------|
| 0 | `platform:admin` (may grant at own level) |
| 1 | `project:owner`, `credential:owner` |
| 2 | `project:editor`, `agent:operator`, `credential:viewer` |
| 3 | `project:viewer`, `agent:observer` |

For credential-scoped role bindings (`scope=credential`), the caller SHALL hold
`credential:owner` on the target credential in addition to satisfying the level
hierarchy check. This prevents users with unrelated project ownership from granting
credential access on credentials they do not own.

Platform-internal roles (`agent:runner`, `credential:token-reader`) SHALL NOT be
grantable via `POST /role_bindings`. These roles are managed exclusively by the
platform (e.g., the operator grants `agent:runner` to session service accounts at
session start, and `credential:token-reader` to runner pods). Attempting to grant
a platform-internal role via the API SHALL return 403 Forbidden.

##### Scenario: Project owner grants project editor

- GIVEN user A has `project:owner` on proj-1
- WHEN user A calls `POST /role_bindings` with `role=project:editor`, `scope=project`, `project_id=proj-1`, `user_id=B`
- THEN the binding is created
- AND user B gains editor access to proj-1

##### Scenario: Project owner cannot grant project owner

- GIVEN user A has `project:owner` on proj-1
- WHEN user A calls `POST /role_bindings` with `role=project:owner`, `scope=project`, `project_id=proj-1`, `user_id=B`
- THEN the request returns 403 Forbidden
- AND owners cannot mint peers at their own level

##### Scenario: Platform admin grants platform admin

- GIVEN user A has `platform:admin`
- WHEN user A calls `POST /role_bindings` with `role=platform:admin`, `scope=global`, `user_id=B`
- THEN the binding is created
- AND this is the sole exception to the "strictly below" rule

##### Scenario: Project owner cannot grant on other projects

- GIVEN user A has `project:owner` on proj-1 only
- WHEN user A calls `POST /role_bindings` with `scope=project`, `project_id=proj-2`
- THEN the request returns 403 Forbidden

##### Scenario: Project editor cannot grant project owner

- GIVEN user A has `project:editor` on proj-1
- WHEN user A calls `POST /role_bindings` with `role=project:owner`, `scope=project`, `project_id=proj-1`
- THEN the request returns 403 Forbidden
- AND editors cannot escalate to owner

##### Scenario: Non-credential-owner cannot grant credential-scoped roles

- GIVEN user B holds `project:owner` on proj-1 but does NOT hold `credential:owner` on credential C
- WHEN user B calls `POST /role_bindings` with `role=credential:viewer`, `credential_id=C`, `user_id=X`
- THEN the request returns 403 Forbidden
- AND project ownership does not substitute for credential ownership

##### Scenario: Granting platform-internal role rejected

- GIVEN user A has `platform:admin`
- WHEN user A calls `POST /role_bindings` with `role=agent:runner`
- THEN the request returns 403 Forbidden
- AND platform-internal roles are not user-grantable

##### Scenario: Project owner can revoke bindings in their project

- GIVEN user A has `project:owner` on proj-1
- AND user B has a `project:viewer` binding on proj-1
- WHEN user A calls `DELETE /role_bindings/{binding-id}`
- THEN the binding is deleted
- AND user B loses viewer access to proj-1

##### Scenario: Cannot delete own last owner binding on a project

- GIVEN user A is the sole `project:owner` on proj-1
- WHEN user A calls `DELETE /role_bindings/{own-owner-binding}`
- THEN the request returns 409 Conflict
- AND the system prevents orphaned projects with no owner

##### Scenario: Cannot delete sole credential owner binding

- GIVEN user A is the sole `credential:owner` on credential C
- WHEN user A calls `DELETE /role_bindings/{own-credential-owner-binding}`
- THEN the request returns 409 Conflict
- AND the system prevents orphaned credentials with no owner

#### Requirement: Auth-Exempt Endpoints

The following endpoints SHALL require only authentication (valid JWT), not authorization.
They are necessary for system operation and bootstrap.

| Endpoint | Reason |
|----------|--------|
| `POST /projects` | Bootstrap — users gain access by creating a project |
| `POST /credentials` | Self-service — users manage their own credentials |
| `GET /roles` | Discovery — users need to see available roles |
| `GET /roles/{id}` | Discovery — read a specific role's permissions |

Health, metrics, and version endpoints are already bypassed at the authentication
layer and do not reach the authorization middleware.

All other endpoints SHALL require both authentication and authorization.

#### Requirement: gRPC Authorization

gRPC handlers SHALL enforce the same authorization rules as HTTP handlers. The gRPC
authorization interceptor SHALL extract the caller identity from the request metadata
and evaluate permissions using the same scope-aware logic as the HTTP middleware.

##### Scenario: gRPC session watch authorized

- GIVEN user A has `project:viewer` on proj-1
- WHEN user A opens a gRPC `WatchSessions` stream
- THEN only session events for proj-1 are streamed
- AND events for other projects are filtered out

##### Scenario: gRPC session watch unauthorized

- GIVEN user A has no bindings
- WHEN user A opens a gRPC `WatchSessions` stream
- THEN no session events are streamed
- AND the stream remains open but idle (no error for watches)

##### Scenario: Idle watch stream resource limit

- GIVEN a caller opens multiple gRPC watch streams with no matching bindings
- WHEN the streams have been idle (no events delivered) beyond the server's idle timeout
- THEN the server SHALL close idle streams to prevent connection exhaustion
- AND the client MAY reconnect

##### Scenario: gRPC inbox push authorized

- GIVEN user A has `project:editor` on proj-1
- WHEN user A sends a gRPC `PushInboxMessage` for an agent in proj-1
- THEN the message is accepted

##### Scenario: gRPC inbox push unauthorized

- GIVEN user A has `project:viewer` on proj-1 (read-only)
- WHEN user A sends a gRPC `PushInboxMessage` for an agent in proj-1
- THEN the request returns a permission denied error

#### Requirement: Service Caller Bypass

Requests originating from internal platform services (control plane, operator) SHALL
bypass RBAC authorization. Service callers are identified by authenticating with
the platform service token. Service callers are trusted infrastructure — they
reconcile state on behalf of the platform, not on behalf of any individual user.

The service caller bypass SHALL apply to both HTTP and gRPC request paths.

The service token endpoint SHALL only be reachable from within the cluster.
Exfiltration of the service token MUST NOT grant external access. See
[Security Specification — Proxy Authentication](#requirement-proxy-authentication)
for cluster-internal caller validation requirements.

##### Scenario: Control plane updates session status

- GIVEN the control plane authenticates with the service token
- WHEN the CP calls `PATCH /sessions/{id}` to update session status
- THEN the request is authorized regardless of RBAC bindings

##### Scenario: Service token not available to external callers

- GIVEN an external caller with a valid user JWT
- WHEN the caller's request is evaluated
- THEN the caller is not identified as a service caller
- AND RBAC is enforced normally

##### Scenario: Service token rejected from outside the cluster

- GIVEN an external caller who has obtained the service token
- WHEN the caller sends a request with the service token from outside the cluster
- THEN the request is rejected
- AND the service token bypass does not apply to non-cluster-internal traffic

#### Requirement: Integration Test Coverage

Integration tests SHALL exercise RBAC enforcement. The test environment SHALL NOT
disable the authorization middleware. Tests SHALL create roles and role bindings
explicitly and verify that authorization is enforced.

Each plugin's integration test suite SHALL include at least:
- A test that verifies access is granted with the correct binding
- A test that verifies access is denied without a binding
- A test that verifies scope isolation (binding for resource A does not grant access to resource B)

##### Scenario: Test creates binding and verifies access

- GIVEN the integration test environment with RBAC enabled
- WHEN a test creates a user, a project, and a `project:editor` binding
- THEN the user can create agents in that project
- AND a second user without a binding receives 403

##### Scenario: Auth-exempt endpoints work without bindings

- GIVEN a test user with zero bindings
- WHEN the user calls `POST /projects`
- THEN the project is created successfully
- AND a `project:owner` binding exists for the user

#### Requirement: Production Rollout

RBAC enforcement SHALL be gated behind a configuration flag. The production
environment SHALL explicitly disable enforcement initially, then enable it after:

1. The admin seeding CLI command has been run to create the first admin
2. Auth-exempt endpoints are verified in staging
3. Existing users have been granted appropriate bindings (manually or via migration)

The rollout SHALL NOT require downtime.

The `project:owner` and `credential:owner` RoleBindings SHALL be created on
`POST /projects` and `POST /credentials` regardless of whether RBAC enforcement
is enabled. Binding creation is not gated by the enforcement flag — only
authorization evaluation is. This prevents projects and credentials created during
the rollout window from becoming orphaned when enforcement is enabled.

##### Scenario: Enforcement disabled — all authenticated requests pass

- GIVEN enforcement is disabled via configuration
- WHEN an authenticated user calls any endpoint
- THEN RBAC is not evaluated
- AND the request proceeds

##### Scenario: Bindings created even when enforcement is disabled

- GIVEN enforcement is disabled via configuration
- WHEN a user calls `POST /projects` with `{"name": "new-proj"}`
- THEN the project is created
- AND a `project:owner` RoleBinding is created for the caller
- AND when enforcement is later enabled, the project has an owner

##### Scenario: Enforcement enabled

- GIVEN enforcement is enabled
- AND the admin has been seeded
- WHEN an authenticated user calls `GET /projects/proj-1`
- THEN the middleware checks the user's bindings for proj-1
- AND returns 403 if no matching binding exists

#### Requirement: Error Response Opacity

The authorization middleware SHALL NOT disclose which permissions are missing or which
bindings were evaluated. This prevents authorization probing attacks.

For singleton resource endpoints (`GET /projects/{id}`, `GET /sessions/{id}`, etc.),
the middleware SHALL return 404 when the caller has no binding that covers the
requested resource — regardless of whether the resource actually exists. Returning
403 on a singleton GET leaks resource existence and enables ID enumeration.

For list endpoints, the middleware SHALL return 200 with an empty items array when
the caller has no matching resources.

##### Scenario: Singleton GET returns 404, not 403

- GIVEN user A has no binding covering proj-1
- WHEN user A calls `GET /projects/proj-1`
- THEN the response is 404
- AND no information about whether proj-1 exists is disclosed

##### Scenario: Forbidden response on mutation is opaque

- GIVEN user A lacks permission to mutate a resource they can see
- WHEN user A calls `PATCH /projects/proj-1` or `DELETE /projects/proj-1`
- THEN the response is 403 with a generic error body
- AND no details about required permissions or existing bindings are included

##### Scenario: List endpoint with no access returns empty

- GIVEN user A has no bindings matching a list query
- WHEN user A calls a list endpoint
- THEN the response is 200 with an empty items array
- AND no 403 is returned

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| Project creation is auth-exempt (bootstrap entry point) | Users gain their first RoleBinding by creating a project. No auto-provisioning of permissions, no admin approval required. Self-service from day one. Alternative (auto-grant on first login) was rejected — it grants access to resources the user didn't ask for and complicates revocation. |
| User auto-provisioned from JWT, not via explicit registration | Users should not need to call a separate registration endpoint. The User record is a side-effect of authentication, not a privileged operation. This eliminates a bootstrap step without granting any permissions. |
| Credential creation is auth-exempt | Same self-service pattern as projects. Users own what they create. Binding credentials to projects requires both `credential:owner` and `project:owner`, preventing unauthorized sharing in either direction. |
| Admin seeded via CLI, not API | Breaks the chicken-and-egg. The RBAC endpoints are themselves gated, so the first admin cannot bootstrap through the API. A CLI command or migration is the standard pattern for initial admin seeding. |
| Scope-aware evaluation, not flat permission check | A flat check ("does this user have `project:read` anywhere?") leaks access across projects. Scope-aware evaluation checks "does this user have `project:read` on *this specific project*?" — the fundamental invariant for multi-tenancy. |
| List endpoints return filtered results, not 403 | Returning 403 on list endpoints breaks pagination and discoverability. An empty list is the correct response when the user has no access. This matches K8s behavior (RBAC-filtered list responses). |
| Service callers bypass RBAC | The control plane and operator are trusted infrastructure. They reconcile state on behalf of the platform. Requiring them to hold user-level bindings would create circular dependencies and make reconciliation fragile. |
| No deny rules | Union-only permission model. Simpler mental model, simpler evaluation. If a user should not have access, don't grant a binding. Deny rules create ordering problems and make debugging harder. |
| Cannot delete last owner binding (projects and credentials) | Prevents orphaned resources. An ownerless project or credential cannot be administered — no one can grant access, update, or delete it. The system enforces at least one owner per project and per credential. Platform admins can always intervene as a recovery path. |
| Strictly-below escalation with platform:admin exception | Users can only grant roles strictly below their own level. This prevents peer-minting (an owner creating another owner). `platform:admin` is the sole exception — since there is no higher role, admins must be able to grant admin to others. |
| Platform-internal roles not user-grantable | `agent:runner` and `credential:token-reader` are managed by the platform (operator grants them at session start). Allowing users to grant these roles would bypass the intended runtime-only access model and create security gaps. |
| Idle gRPC watch streams are closed by the server | An unauthenticated or unauthorized caller could open unlimited idle watch streams to exhaust server connections. The server closes streams that have been idle beyond a timeout to bound resource usage. |
| 404 on unauthorized singleton GETs, not 403 | Returning 403 on `GET /projects/{id}` confirms the resource exists to an unauthorized caller. Returning 404 prevents ID enumeration — the caller learns nothing about whether the resource exists. List endpoints correctly return 200+empty, which is safe because they don't confirm specific IDs. |
| Credential-scoped grants require credential:owner | Without this check, any Level 1+ user (e.g., a project:owner) could grant credential:viewer on credentials they don't own. The level hierarchy alone is insufficient — credential-scoped grants must also verify ownership of the target credential. |
| Owner bindings created regardless of enforcement flag | Projects and credentials created during the enforcement-disabled rollout window would become orphaned the moment enforcement is enabled. Creating bindings unconditionally means every resource has an owner from day one. |
| User auto-provisioning is idempotent (upsert) | Two concurrent first-time requests from the same user could race to create the User record. Upsert semantics (keyed on identity claim) prevent duplicate records and unhandled constraint violations. |
| Service token restricted to cluster-internal traffic | A stolen service token grants full RBAC bypass. Restricting acceptance to cluster-internal callers limits the blast radius of token exfiltration. |
| gRPC uses same evaluation as HTTP | One authorization model, not two. The gRPC interceptor uses the same evaluation logic as the HTTP middleware. Prevents divergence and bypass via protocol switching. |
| Tests exercise real RBAC | Disabling the middleware in tests means RBAC bugs ship to production undetected. Tests should create bindings explicitly and verify enforcement. The test helper should make this ergonomic, not skip it. |
| Configuration flag for rollout | Gradual enablement. Operators can seed admins and verify behavior in staging before enabling in production. No big-bang cutover. |
| Proxy routes out of scope | Routes forwarded by the proxy plugin to external backends are outside the scope of ambient-api-server RBAC. Those backends handle their own authorization. |

---

## Credential Binding

Credentials are global resources. Access to a credential's token at session runtime is governed by `scope=credential` RoleBindings that link a credential to a project or a specific agent within a project. The control plane resolves which credentials a session receives by walking these bindings from most-specific to least-specific scope. A credential with no binding covering the session's project and agent is not injected.

This spec defines the resolver algorithm, authorization rules for creating bindings at each level, and the `credential:token-reader` grant lifecycle.

### Terminology

- **Agent-level binding**: A `scope=credential` RoleBinding with `credential_id`, `project_id`, and `agent_id` all set. Grants the credential to one specific agent.
- **Project-level binding**: A `scope=credential` RoleBinding with `credential_id` and `project_id` set, `agent_id` NULL. Grants the credential to all agents in the project.
- **Global binding**: A `scope=credential` RoleBinding with `credential_id` set, `project_id` NULL, `agent_id` NULL. Grants the credential as a platform-wide default.
- **Session OIDC service identity**: A machine identity provisioned by the control plane at session start via OIDC `client_credentials` grant. Materializes as a `user_id` in RoleBinding records (e.g., `service-account-<client-id>`). The control plane uses this identity to grant `credential:token-reader` bindings on behalf of the session pod.

### Dependencies

- **Global credential binding pattern**: The `scope=credential` binding with both `project_id=NULL` and `agent_id=NULL` is a new pattern. `ambient-model.spec.md` SHALL be amended to document this as valid for credential scope.

### Requirements

#### Requirement: Hierarchical Credential Resolution

The control plane SHALL resolve credentials for a session by walking `scope=credential` RoleBindings from most-specific to least-specific scope: **agent → project → global**.

For each credential provider (github, gitlab, google, jira, kubeconfig, vertex):

1. If a `scope=credential` binding exists where `credential_id` references a credential of this provider, `project_id` matches the session's project, AND `agent_id` matches the session's agent — use that credential (**agent-level binding**).
2. Otherwise, if a `scope=credential` binding exists where `credential_id` references a credential of this provider, `project_id` matches the session's project, AND `agent_id` is NULL — use that credential (**project-level binding**).
3. Otherwise, if a `scope=credential` binding exists where `credential_id` references a credential of this provider, `project_id` is NULL, AND `agent_id` is NULL — use that credential (**global binding**).
4. Otherwise, no credential is injected for this provider.

The API server SHALL reject creation of duplicate bindings at the same scope level for the same provider (same `credential.provider`, same `project_id`, same `agent_id`). If duplicates exist despite this (e.g., from prior data), the binding with the earliest `created_at` timestamp wins.

##### Scenario: Agent-level binding overrides project-level

- GIVEN credential A (provider=github) is bound to project P with `agent_id=NULL`
- AND credential B (provider=github) is bound to project P with `agent_id=agent-1`
- WHEN a session starts for agent-1 in project P
- THEN the session receives credential B (agent-level wins)

##### Scenario: Project-level binding used when no agent-level exists

- GIVEN credential A (provider=github) is bound to project P with `agent_id=NULL`
- AND no agent-level github binding exists for agent-1 in project P
- WHEN a session starts for agent-1 in project P
- THEN the session receives credential A (project-level fallback)

##### Scenario: No binding means no injection

- GIVEN credential A (provider=github) is bound to project P
- AND no github credential is bound to project Q at any level
- WHEN a session starts in project Q
- THEN no github credential is injected into the session

##### Scenario: Multiple providers resolved independently

- GIVEN credential A (provider=github) is bound to project P at project-level
- AND credential B (provider=jira) is bound to project P at agent-level for agent-1
- AND no google credential is bound to project P
- WHEN a session starts for agent-1 in project P
- THEN the session receives credential A (github, project-level) and credential B (jira, agent-level)
- AND no google credential is injected

##### Scenario: Global binding provides default

- GIVEN credential A (provider=github) has a `scope=credential` binding with `project_id=NULL` and `agent_id=NULL`
- AND no project-level or agent-level github binding exists for project P
- WHEN a session starts in project P
- THEN the session receives credential A (global fallback)

##### Scenario: Agent-level binding overrides global

- GIVEN credential A (provider=github) has a global binding (`project_id=NULL`, `agent_id=NULL`)
- AND credential B (provider=github) is bound to project P with `agent_id=agent-1`
- WHEN a session starts for agent-1 in project P
- THEN the session receives credential B (agent-level overrides global)

#### Requirement: Credential Binding Authorization

**Binding** (creating) and **unbinding** (deleting) `scope=credential` RoleBindings have asymmetric authorization rules. Binding grants access to a secret and requires ownership of both sides. Unbinding revokes access from a project and only requires ownership of the destination.

##### Binding (create)

**All credential bindings** require the caller to hold `credential:owner` on the target credential. You can only bind credentials you own.

**Project-level and agent-level bindings** additionally require the caller to hold `project:editor` or higher on the target project.

**Agent-level bindings** additionally require:
1. The specified agent to belong to the project specified in the binding (`project_id`), validated by the API server
2. The `project_id` to be non-NULL (agent-credential bindings without a project are invalid)

**Global bindings** additionally require the caller to hold `platform:admin`.

##### Unbinding (delete)

**Project-level and agent-level bindings** require the caller to hold `project:editor` or higher on the binding's project. The caller does NOT need `credential:owner` — a project editor/owner can remove any credential from their project regardless of who bound it.

**Global bindings** require the caller to hold `platform:admin`.

##### Scenario: Project owner binds own credential to project

- GIVEN user A holds `credential:owner` on credential C
- AND user A holds `project:owner` on project P
- WHEN user A creates a RoleBinding with `scope=credential`, `credential_id=C`, `project_id=P`, `agent_id=NULL`
- THEN the binding is created (201)

##### Scenario: Project owner binds own credential to specific agent

- GIVEN user A holds `credential:owner` on credential C
- AND user A holds `project:owner` on project P
- AND agent-1 belongs to project P
- WHEN user A creates a RoleBinding with `scope=credential`, `credential_id=C`, `project_id=P`, `agent_id=agent-1`
- THEN the binding is created (201)

##### Scenario: Non-credential-owner cannot bind

- GIVEN user A does NOT hold `credential:owner` on credential C
- AND user A holds `project:owner` on project P
- WHEN user A creates a RoleBinding with `scope=credential`, `credential_id=C`, `project_id=P`
- THEN the request returns 403 Forbidden

##### Scenario: Project editor binds own credential to project

- GIVEN user A holds `credential:owner` on credential C
- AND user A holds `project:editor` on project P
- WHEN user A creates a RoleBinding with `scope=credential`, `credential_id=C`, `project_id=P`
- THEN the binding is created (201)

##### Scenario: Project viewer cannot bind credentials

- GIVEN user A holds `credential:owner` on credential C
- AND user A holds `project:viewer` on project P
- WHEN user A creates a RoleBinding with `scope=credential`, `credential_id=C`, `project_id=P`
- THEN the request returns 403 Forbidden

##### Scenario: Non-project-member cannot bind credential

- GIVEN user A holds `credential:owner` on credential C
- AND user A has no role on project P
- WHEN user A creates a RoleBinding with `scope=credential`, `credential_id=C`, `project_id=P`, `agent_id=agent-1`
- THEN the request returns 403 Forbidden

##### Scenario: Agent-credential binding requires project_id

- GIVEN user A holds `credential:owner` on credential C
- WHEN user A creates a RoleBinding with `scope=credential`, `credential_id=C`, `agent_id=agent-1`, `project_id=NULL`
- THEN the request returns 400 Bad Request
- AND the error indicates that agent-scoped credential bindings require a project_id

##### Scenario: Agent must belong to the specified project

- GIVEN user A holds `credential:owner` on credential C
- AND user A holds `project:owner` on project P
- AND agent-1 belongs to project Q (not P)
- WHEN user A creates a RoleBinding with `scope=credential`, `credential_id=C`, `project_id=P`, `agent_id=agent-1`
- THEN the request returns 400 Bad Request

##### Scenario: Platform admin creates global credential binding

- GIVEN user A holds `platform:admin`
- AND user A holds `credential:owner` on credential C
- WHEN user A creates a RoleBinding with `scope=credential`, `credential_id=C`, `project_id=NULL`, `agent_id=NULL`
- THEN the binding is created (201)

##### Scenario: Non-admin cannot create global credential binding

- GIVEN user A holds `credential:owner` on credential C
- AND user A does NOT hold `platform:admin`
- WHEN user A creates a RoleBinding with `scope=credential`, `credential_id=C`, `project_id=NULL`, `agent_id=NULL`
- THEN the request returns 403 Forbidden

##### Scenario: Project editor unbinds credential they don't own

- GIVEN user B (not credential owner) holds `project:editor` on project P
- AND credential C (owned by user A) is bound to project P
- WHEN user B deletes the `scope=credential` RoleBinding for credential C on project P
- THEN the binding is deleted (204)

##### Scenario: Project viewer cannot unbind

- GIVEN user A holds `project:viewer` on project P
- AND credential C is bound to project P
- WHEN user A deletes the `scope=credential` RoleBinding for credential C on project P
- THEN the request returns 403 Forbidden

#### Requirement: credential:token-reader Grant Lifecycle

The control plane SHALL grant `credential:token-reader` to the session's OIDC service identity for each credential resolved by the hierarchical resolver. This grant SHALL be scoped to the specific credential and SHALL be revoked when the session terminates.

The control plane authenticates as a platform service account and creates these bindings via the standard `POST /role_bindings` API. Because `credential:token-reader` is an internal role, only service callers (not human users) can create these bindings.

##### Scenario: Token-reader granted at session start

- GIVEN credential A is resolved for a session via the hierarchical resolver
- WHEN the control plane provisions the session pod
- THEN a RoleBinding is created with `role=credential:token-reader`, `scope=credential`, `credential_id=A`, `user_id=<session-oidc-service-account>`

##### Scenario: Token-reader revoked at session end

- GIVEN a session was provisioned with `credential:token-reader` for credential A
- WHEN the session terminates (Completed, Failed, or Stopped)
- THEN the `credential:token-reader` RoleBinding for credential A is deleted

##### Scenario: Sidecar can fetch token with granted role

- GIVEN the control plane granted `credential:token-reader` for credential A to the session's service identity
- WHEN the credential sidecar calls `GET /credentials/{A}/token` with the session's bearer token
- THEN the API server returns the decrypted token (200)

##### Scenario: Sidecar cannot fetch unbound credential token

- GIVEN credential B was NOT resolved for this session (no binding)
- AND no `credential:token-reader` was granted for credential B
- WHEN the credential sidecar calls `GET /credentials/{B}/token`
- THEN the API server returns 404

#### Requirement: Binding Deletion Does Not Affect Running Sessions

Deleting a `scope=credential` RoleBinding SHALL NOT terminate running sessions that were provisioned with the previously-bound credential. The credential remains available for the session's lifetime via its existing `credential:token-reader` grant. New sessions started after the binding deletion SHALL NOT receive the credential.

##### Scenario: Running session keeps credential after binding deleted

- GIVEN a session is Running with credential A (bound at project-level)
- WHEN the project-level binding for credential A is deleted
- THEN the running session continues to use credential A
- AND the `credential:token-reader` grant for this session is NOT revoked

##### Scenario: New session does not receive deleted binding's credential

- GIVEN the project-level binding for credential A on project P was deleted
- WHEN a new session starts in project P
- THEN credential A is NOT injected (resolver finds no matching binding)

### Migration

#### Existing consumers

| Consumer | Current behavior | Required change |
|----------|-----------------|-----------------|
| Control plane `resolveCredentialIDs` | Lists all credentials via `sdk.Credentials().ListAll()`, picks first per provider | Query `scope=credential` RoleBindings filtered by `project_id` and `agent_id`, implement hierarchical resolution |
| RBAC middleware (credential binding creation) | Validates `credential:owner` + `project:owner` for project-level bindings | Relax bind check to `project:editor`+, add agent-level validation (verify agent belongs to project), global bindings (require `platform:admin`), reject `agent_id` without `project_id`, and asymmetric unbind auth (`project:editor`+ can unbind without `credential:owner`) |
| Credential sidecar entrypoint | Fetches token via bearer token from CP token exchange | No change — consumes `CREDENTIAL_IDS` produced by CP |
| Runner `populate_runtime_credentials` | Fetches tokens from `CREDENTIAL_IDS` env var | No change — consumes `CREDENTIAL_IDS` produced by CP |
| UI binding matrix | Creates RoleBindings with `credential_id` + `project_id` ± `agent_id` | No change — already creates correct binding structure |

#### Specs requiring amendment

| Spec | Amendment |
|------|-----------|
| `rbac-enforcement.spec.md` | Relax credential binding from `project:owner` to `project:editor`+; document bind/unbind asymmetry (editors can unbind without `credential:owner`) |
| `ambient-model.spec.md` | Document global credential binding pattern (`scope=credential` with `project_id=NULL`, `agent_id=NULL`); add credential binding scope terms (agent-level, project-level, global) |

---

## Credential Encryption

Credential tokens (PATs, kubeconfigs, service account keys) are stored in PostgreSQL. Today they are plaintext. This spec defines encryption at rest using AES-256-GCM with a versioned encryption key stored in a Kubernetes Secret, providing confidentiality if the database is compromised. This is a stepping stone toward Vault-only secret storage — the encryption layer is internal to the API server and invisible to all consumers.

> **Glossary:** "token" in this spec refers exclusively to the credential's stored secret value (PAT, kubeconfig, service account key), not HTTP bearer tokens or auth tokens.

### Requirements

#### Requirement: Encrypted Storage

The API server SHALL encrypt credential tokens before writing them to PostgreSQL and decrypt them when reading. The `token` column SHALL contain only ciphertext after encryption is enabled. No consumer (sidecar, runner, SDK, CLI) SHALL be aware of the encryption — the API contract is unchanged.

Encryption and decryption SHALL occur at the service layer (inside `CredentialService`), not in handlers or presenters. This ensures all code paths that touch the token — including any future presenters — always receive plaintext after decryption and never accidentally expose ciphertext.

Note: the `List` handler uses `GenericService.List()` which bypasses `CredentialService` and reads raw column values. This is safe because `PresentCredential` omits the `Token` field from list/get responses. If `PresentCredential` is ever modified to include `Token`, it MUST route through `CredentialService` to ensure decryption.

No DDL or schema migration is required. The existing `token` column is PostgreSQL `TEXT` (unbounded) and accommodates the ciphertext format without modification.

##### Scenario: Create credential with encryption enabled

- GIVEN the API server has a valid encryption key configured
- WHEN a user creates a credential with `provider=github` and `token=ghp_abc123`
- THEN the `token` column in PostgreSQL contains a versioned ciphertext blob (not `ghp_abc123`)
- AND the `GET /credentials/{id}/token` response returns the original plaintext `ghp_abc123`

##### Scenario: Rotate token on existing credential

- GIVEN an encrypted credential exists
- WHEN the user patches it with a new token value
- THEN the old ciphertext is replaced with a new ciphertext of the new token
- AND the key version tag reflects the current active key

##### Scenario: API contract unchanged

- GIVEN encryption is enabled
- WHEN a sidecar calls `GET /credentials/{id}/token`
- THEN it receives the same JSON shape and plaintext token as before encryption was enabled

#### Requirement: Encryption Key Management

The encryption keyring SHALL be provided as an environment variable (`CREDENTIAL_ENCRYPTION_KEYRING`) sourced from a Kubernetes Secret. The value is a JSON object mapping version numbers (as strings) to base64-encoded 32-byte keys. The active version is specified by `CREDENTIAL_ENCRYPTION_KEY_VERSION`.

Encryption key values MUST NOT appear in log output, error messages, API responses, or debug traces. Log messages about the keyring SHALL reference key versions only (e.g., "using encryption key v2, keyring contains versions: 1, 2").

##### Scenario: Server startup with valid keyring

- GIVEN `CREDENTIAL_ENCRYPTION_KEYRING` is set to a valid JSON keyring (e.g., `{"1":"base64key1"}`)
- AND `CREDENTIAL_ENCRYPTION_KEY_VERSION` is set to `1`
- WHEN the API server starts
- THEN it initializes the encryption subsystem and serves requests normally

##### Scenario: Server startup with missing keyring and encrypted tokens

- GIVEN `CREDENTIAL_ENCRYPTION_KEYRING` is not set
- AND at least one credential in the database has an encrypted token (version-prefixed ciphertext)
- WHEN the API server starts
- THEN it SHALL refuse to start and log a fatal error: "encryption keyring required but not configured"

##### Scenario: Server startup with no keyring and no encrypted tokens (fail-closed)

- GIVEN `CREDENTIAL_ENCRYPTION_KEYRING` is not set
- AND `CREDENTIAL_ENCRYPTION_ALLOW_PLAINTEXT` is not set to `true`
- WHEN the API server starts
- THEN it SHALL refuse to start and log a fatal error: "credential encryption disabled — set CREDENTIAL_ENCRYPTION_KEYRING or set CREDENTIAL_ENCRYPTION_ALLOW_PLAINTEXT=true to override"

##### Scenario: Server startup with explicit plaintext opt-in

- GIVEN `CREDENTIAL_ENCRYPTION_KEYRING` is not set
- AND `CREDENTIAL_ENCRYPTION_ALLOW_PLAINTEXT` is set to `true`
- WHEN the API server starts
- THEN it SHALL start normally with encryption disabled
- AND write and read tokens as plaintext (backward-compatible)
- AND log a WARNING at startup: "credential encryption disabled — running in plaintext mode"

#### Requirement: Ciphertext Format

Each encrypted token SHALL be stored as a version-tagged string with the format:

```
enc:v{N}:{base64(nonce + ciphertext + tag)}
```

Where:
- `enc:` is a fixed prefix distinguishing ciphertext from plaintext
- `v{N}` is the key version (monotonically increasing integer, starting at `1`)
- The base64 payload contains the 12-byte GCM nonce prepended to the ciphertext and authentication tag

The credential ID SHALL be bound as Additional Authenticated Data (AAD) in the GCM `Seal()`/`Open()` calls. This prevents ciphertext from being swapped between credential rows — decryption will fail if the ciphertext is moved to a different credential's row.

The version tag in the ciphertext prefix (`v{N}`) determines which key is used for decryption. The system SHALL NOT use try-decrypt fallback logic; a mismatched version tag is an error.

Plaintext tokens (pre-migration) lack the `enc:` prefix, enabling the system to distinguish encrypted from unencrypted values.

Token recognition SHALL use strict envelope validation, not just prefix matching. A value is treated as ciphertext only when all of the following hold:
1. It matches the pattern `enc:v{integer}:{base64}`
2. The base64 payload decodes successfully
3. The decoded payload is at least 28 bytes (12-byte nonce + 16-byte GCM tag minimum)

If a value has the `enc:` prefix but fails any validation step, the system SHALL treat it as a decryption error (not silently fall back to plaintext) and return an error to the caller. This prevents silent data corruption if ciphertext is truncated or corrupted.

##### Scenario: Distinguish encrypted from plaintext

- GIVEN a credential with token `enc:v1:SGVsbG8gV29ybGQ=`
- WHEN the API server reads this token
- THEN it detects the `enc:` prefix and decrypts using key version 1

##### Scenario: Legacy plaintext token

- GIVEN a credential with token `ghp_abc123` (no `enc:` prefix)
- AND `CREDENTIAL_ENCRYPTION_KEYRING` and `CREDENTIAL_ENCRYPTION_KEY_VERSION` are configured
- WHEN the API server reads this token via `GET /credentials/{id}/token`
- THEN it returns the plaintext value as-is (no decryption needed)
- AND the token remains plaintext in the database until explicitly migrated

#### Requirement: Key Rotation

The API server SHALL support rotating the encryption key via the `encrypt-credentials` CLI command, which bulk re-encrypts all tokens with the current key.

##### Scenario: Bulk re-encrypt

- GIVEN 50 credentials exist, all encrypted with key version 1
- AND the operator deploys a new encryption key (version 2) via the K8s Secret
- WHEN the operator runs `ambient-api-server encrypt-credentials`
- THEN all 50 tokens are decrypted with the version-1 key and re-encrypted with the version-2 key
- AND each token's version tag updates from `v1` to `v2`
- AND the command reports: "50 credentials re-encrypted from v1 to v2"

##### Scenario: Interrupted re-encryption

- GIVEN a bulk re-encrypt is running
- WHEN it fails after processing 30 of 50 credentials
- THEN 30 credentials are tagged `v2` and 20 remain tagged `v1`
- AND the command exits with an error listing the 20 unprocessed credential IDs
- AND a subsequent run of `encrypt-credentials` processes only the remaining `v1` credentials

##### Scenario: Key version tracking

- GIVEN a K8s Secret containing the encryption keyring
- WHEN the operator needs to rotate
- THEN they add the new key to `CREDENTIAL_ENCRYPTION_KEYRING` with the next version number
- AND set `CREDENTIAL_ENCRYPTION_KEY_VERSION` to the new version (e.g., `2`)
- AND old keys MUST be retained in the keyring until `encrypt-credentials` re-encrypts all tokens to the current version

#### Requirement: Initial Migration

The `encrypt-credentials` CLI command SHALL encrypt all existing plaintext tokens in-place.

##### Scenario: First-time encryption

- GIVEN 100 credentials exist with plaintext tokens (no `enc:` prefix)
- AND `CREDENTIAL_ENCRYPTION_KEYRING` is configured with version 1
- WHEN the operator runs `ambient-api-server encrypt-credentials`
- THEN all 100 tokens are encrypted with the version-1 key
- AND each token is updated to `enc:v1:{ciphertext}`
- AND the command reports: "100 credentials encrypted (plaintext → v1)"

##### Scenario: Idempotent execution

- GIVEN all credentials are already encrypted with version 1
- WHEN the operator runs `encrypt-credentials` with the same version-1 key
- THEN the command reports: "0 credentials need encryption. All up to date."
- AND no database writes occur

#### Requirement: Decryption Rollback

The `encrypt-credentials` command SHALL support a `--decrypt` flag that reverses all encrypted tokens to plaintext in the database.

The `--decrypt` flag requires all encryption key versions referenced by stored ciphertext to be present in the keyring. If tokens span `v1`, `v2`, and `v3`, all three keys MUST be in `CREDENTIAL_ENCRYPTION_KEYRING`.

##### Scenario: Bulk decrypt

- GIVEN 50 credentials exist with encrypted tokens (all `enc:v1:...`)
- WHEN the operator runs `ambient-api-server encrypt-credentials --decrypt`
- THEN all 50 tokens are decrypted and stored as plaintext (no `enc:` prefix)
- AND the command reports: "50 credentials decrypted to plaintext"

##### Scenario: Decrypt after partial rotation

- GIVEN 30 credentials are `enc:v2` and 20 are `enc:v1`
- AND both keys are available in the keyring
- WHEN the operator runs `encrypt-credentials --decrypt`
- THEN all 50 tokens are decrypted to plaintext using their respective key versions

#### Requirement: CLI Integration

The `encrypt-credentials` command SHALL be a cobra subcommand of `ambient-api-server`, alongside the existing `serve` and `migrate` commands. It SHALL reuse the existing `SessionFactory` for database access and the standard environment system for configuration.

The command operates directly on the database — it does not go through the REST API. It is a privileged operation intended for platform operators with direct database and K8s Secret access. No application-level RBAC role grants access to this command; authorization is enforced by infrastructure access (K8s RBAC on the pod/namespace and database credentials).

Decrypted token values are never exposed to end users. The `GET /credentials/{id}/token` endpoint requires the `credential:token-reader` role, which is granted only to runner service accounts — not to human users.

##### Scenario: Command execution

- GIVEN the operator has `kubectl exec` access to the API server pod (or runs the binary locally with DB connectivity)
- WHEN they run `ambient-api-server encrypt-credentials`
- THEN the command connects to PostgreSQL, processes all credential tokens, and exits

##### Scenario: Dry run

- GIVEN credentials exist in mixed states (some plaintext, some encrypted)
- WHEN the operator runs `ambient-api-server encrypt-credentials --dry-run`
- THEN the command reports what it would do without modifying any data
- AND outputs: "Would encrypt: 30 plaintext, Would re-encrypt: 20 (v1 → v2), Already current: 50"

#### Requirement: Vault Migration Path

The encryption layer SHALL be implemented as an internal concern of the credential plugin, not exposed in the API schema or OpenAPI spec. This enables a future migration to Vault-only storage by:
1. Replacing the encrypt/decrypt functions with Vault Transit API calls
2. Or replacing the token column with a Vault path reference

No API, SDK, CLI, sidecar, or runner changes SHALL be required when the storage backend changes.

##### Scenario: Future Vault adoption

- GIVEN the API server currently uses AES-256-GCM with a K8s Secret key
- WHEN the team migrates to Vault Transit
- THEN only the encryption/decryption functions inside the credential plugin change
- AND the `GET /credentials/{id}/token` response is identical
- AND no consumer needs modification

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CREDENTIAL_ENCRYPTION_KEYRING` | No (see startup scenarios) | JSON object mapping version numbers to base64-encoded 32-byte keys. E.g., `{"1":"base64key1","2":"base64key2"}`. Sourced from K8s Secret. All keys referenced by stored ciphertext MUST be present. |
| `CREDENTIAL_ENCRYPTION_KEY_VERSION` | When keyring is set | Integer version of the active key used for new encryptions (e.g., `2`). Must exist in the keyring. |
| `CREDENTIAL_ENCRYPTION_ALLOW_PLAINTEXT` | No | Set to `true` to allow startup without encryption. Without this, the server fails closed if no keyring is configured. |

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| AES-256-GCM | Authenticated encryption. Go stdlib (`crypto/aes` + `crypto/cipher`). No external dependencies. Industry standard. 96-bit random nonce; birthday collision risk negligible at credential-scale volumes (well under 2^32 encryptions). |
| Credential ID as AAD | Binding the credential ID as GCM additional authenticated data prevents ciphertext swapping between database rows. Decryption fails if a ciphertext blob is copied to a different credential's row. |
| Version-tagged ciphertext | Enables safe key rotation — the system always knows which key encrypted a given token. Also distinguishes encrypted from legacy plaintext. |
| JSON keyring env var | Supports arbitrary number of historical key versions in a single env var. Version-tagged ciphertext selects the correct key from the keyring — no try-decrypt fallback needed. Consistent with existing API server config pattern (env vars from K8s Secrets). |
| Explicit CLI command for migration | Follows industry practice (Rails, Django, Kubernetes, Vault). Never auto-encrypt on startup — the operation is privileged, auditable, and must be recoverable from partial failure. |
| Encryption at service layer | Decrypt in `CredentialService.Get()`, encrypt in `CredentialService.Create()`/`Replace()`. Handlers and presenters never see ciphertext. Prevents accidental exposure if new presenters are added. |
| Encryption invisible to API consumers | The `GET /credentials/{id}/token` contract is unchanged. Sidecars, runners, SDK, CLI are unaware. This maximizes the migration surface to Vault later. |
| Fail-closed without key | Server refuses to start unless a keyring is configured or `CREDENTIAL_ENCRYPTION_ALLOW_PLAINTEXT=true` is set. Prevents silent plaintext degradation in production. Dev environments opt in explicitly. |
| No DDL migration required | The `token` column is PostgreSQL `TEXT` (unbounded). Ciphertext with the `enc:v1:...` prefix fits without schema changes. |
| `--decrypt` rollback supported | The decrypt capability exists inherently (needed for `GET /token`). A `--decrypt` flag on the CLI command reverses encryption if the feature must be rolled back. |
| Cobra subcommand, not gormigrate | `encrypt-credentials` is a standalone subcommand like `serve` and `migrate`, not a numbered migration. It's re-runnable, idempotent, and supports `--dry-run` and `--decrypt` flags. |

---

## OpenShell Sandbox

**Date:** 2026-06-04
**Status:** Implemented — validated end-to-end on ROSA OpenShift (kernel 5.14.0-570.99.1.el9_6)
**Related:** `specs/platform.spec.md` § Runner / OpenShell Sandbox Isolation, § Control Plane

---

### Purpose

This specification defines the requirements for sandboxing the Claude Code agent
subprocess using NVIDIA OpenShell's Supervisor binary. The sandbox prevents a
compromised or misbehaving agent from accessing credentials, filesystem regions,
network endpoints, or syscalls outside its declared policy.

---

### Requirements

#### Requirement: Sandbox Activation

The sandbox SHALL be activated when the control plane environment variable
`OPENSHELL_ENABLED` is set to `true`. When not enabled, the runner SHALL launch
Claude Code directly without any sandbox wrapper.

##### Scenario: Sandbox enabled

- GIVEN the CP config has `OpenShellEnabled = true`
- WHEN a session pod is provisioned
- THEN the runner container SHALL have `OPENSHELL_ENABLED=true` in its environment
- AND the Claude CLI SHALL be launched through the OpenShell Supervisor wrapper

##### Scenario: Sandbox disabled (default)

- GIVEN the CP config has `OpenShellEnabled = false` (or unset)
- WHEN a session pod is provisioned
- THEN the runner container SHALL NOT have OpenShell environment variables
- AND the Claude CLI SHALL be launched directly by the Claude Agent SDK

---

#### Requirement: File Mode Operation

The Supervisor SHALL operate in file mode using local policy files. The system
SHALL NOT require an OpenShell Gateway service.

##### Scenario: Policy file delivery

- GIVEN an `openshell-policy` ConfigMap exists in the CP namespace
- WHEN a session is provisioned in a runner namespace
- THEN the reconciler SHALL copy the ConfigMap to the runner namespace
- AND mount it as a read-only volume at `/etc/openshell`

##### Scenario: Policy file format

- GIVEN the ConfigMap contains `policy.rego` and `policy.yaml`
- WHEN the Supervisor starts
- THEN it SHALL load the Rego rules from `--policy-rules`
- AND load the YAML data from `--policy-data`
- AND validate the policy before spawning the child process

---

#### Requirement: Network Namespace Isolation

The agent subprocess SHALL run in a separate Linux network namespace. All network
traffic from the agent SHALL route through the Supervisor's TLS proxy.

##### Scenario: Network namespace creation

- GIVEN the Supervisor starts with network policy configured
- WHEN it creates the sandbox environment
- THEN it SHALL create a new network namespace with a veth pair
- AND the host side SHALL listen on `10.200.0.1:3128` (HTTP CONNECT proxy)
- AND the sandbox side SHALL have `10.200.0.2/24` with default route via `10.200.0.1`
- AND the child process SHALL have `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` set to `http://10.200.0.1:3128`

##### Scenario: Blocked endpoint

- GIVEN an endpoint is NOT listed in any `network_policies` entry
- WHEN the agent attempts to connect to that endpoint
- THEN the proxy SHALL refuse the connection
- AND the agent SHALL receive a connection error

##### Scenario: Allowed endpoint

- GIVEN an endpoint IS listed in a `network_policies` entry
- AND the requesting binary matches the policy's `binaries` list
- WHEN the agent connects to that endpoint
- THEN the proxy SHALL establish an HTTP CONNECT tunnel
- AND perform TLS termination with the ephemeral per-sandbox CA
- AND forward the request to the upstream server

---

#### Requirement: TLS Proxy

The Supervisor SHALL generate an ephemeral CA certificate per sandbox lifetime and
inject it into the child process via `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, and
`GIT_SSL_CAINFO` environment variables.

##### Scenario: TLS trust chain

- GIVEN the Supervisor generates an ephemeral CA at startup
- WHEN the agent makes an HTTPS request through the proxy
- THEN the proxy SHALL issue a per-hostname leaf certificate signed by the ephemeral CA
- AND the agent's TLS client SHALL trust the certificate via the injected CA bundle
- AND the proxy SHALL verify upstream certificates against the system CA store

---

#### Requirement: Filesystem Isolation (Landlock LSM)

The agent subprocess SHALL be confined to a filesystem allowlist enforced by
Landlock LSM.

##### Scenario: Read-only paths

- GIVEN the policy declares `/usr`, `/lib`, `/proc`, `/dev/urandom`, `/app`, `/etc`, `/var/log`, `/home/sandbox` as read-only
- WHEN the agent attempts to write to any of these paths
- THEN the write SHALL be denied by the kernel

##### Scenario: Read-write paths

- GIVEN the policy declares `/workspace`, `/tmp`, `/dev/null`, `/app/.claude` as read-write
- WHEN the agent writes to these paths
- THEN the write SHALL succeed

##### Scenario: Undeclared paths

- GIVEN a path is not listed in either read-only or read-write lists
- WHEN the agent attempts to access that path
- THEN access SHALL be denied by the kernel

##### Scenario: Landlock compatibility

- GIVEN the kernel supports Landlock ABI v2 or higher
- WHEN the Supervisor applies the Landlock ruleset
- THEN it SHALL apply all rules
- AND report the number of rules applied and skipped

- GIVEN the kernel does NOT support Landlock
- AND the policy has `landlock.compatibility: best_effort`
- WHEN the Supervisor attempts to apply Landlock
- THEN it SHALL log a warning and continue without filesystem isolation

---

#### Requirement: Process Privilege Drop

The Supervisor SHALL drop privileges before executing the agent binary.

##### Scenario: Privilege drop sequence

- GIVEN the Supervisor starts as root (UID 0)
- WHEN it forks the child process
- THEN the pre_exec closure SHALL call `setgroups`, `setgid`, `setuid` to switch to the `sandbox` user
- AND set `RLIMIT_CORE` to 0 (no core dumps)
- AND set `PR_SET_DUMPABLE` to 0 (blocks ptrace attach)
- AND set `PR_SET_NO_NEW_PRIVS` to 1 (no setuid escalation)

##### Scenario: Privilege drop verification

- GIVEN the child has called `setuid(sandbox_uid)`
- WHEN the Supervisor verifies the drop
- THEN it SHALL attempt `setuid(0)` and confirm it returns `EPERM`

---

#### Requirement: Syscall Filtering (seccomp-BPF)

The agent subprocess SHALL have a seccomp-BPF filter applied that blocks
dangerous syscalls.

##### Scenario: Blocked syscalls

- GIVEN the seccomp filter is applied
- WHEN the agent attempts `ptrace`, `memfd_create`, or `io_uring_setup`
- THEN the syscall SHALL be blocked

##### Scenario: Blocked socket domains

- GIVEN the seccomp filter is applied
- WHEN the agent attempts to create sockets with `AF_PACKET`, `AF_NETLINK`, or `AF_BLUETOOTH`
- THEN the socket creation SHALL be blocked

---

#### Requirement: Container Security Context

The reconciler SHALL configure the runner container's security context based on
the `OpenShellEnabled` flag.

##### Scenario: OpenShell enabled

- GIVEN `OpenShellEnabled = true`
- WHEN the reconciler builds the pod spec
- THEN the container security context SHALL include:
  - `allowPrivilegeEscalation: true`
  - `runAsUser: 0`
  - `runAsNonRoot: false`
  - `capabilities.drop: [ALL]`
  - `capabilities.add: [NET_ADMIN, SYS_ADMIN, SYS_PTRACE, SETUID, SETGID, CHOWN, DAC_OVERRIDE]`
- AND the pod-level security context SHALL include `seccompProfile.type: Unconfined`

##### Scenario: OpenShell disabled

- GIVEN `OpenShellEnabled = false`
- WHEN the reconciler builds the pod spec
- THEN the container security context SHALL include:
  - `allowPrivilegeEscalation: false`
  - `capabilities.drop: [ALL]`
- AND the pod-level security context SHALL NOT override seccomp

---

#### Requirement: Policy ConfigMap Propagation

The reconciler SHALL propagate the OpenShell policy ConfigMap from the control
plane namespace to each runner namespace.

##### Scenario: ConfigMap already exists

- GIVEN the policy ConfigMap already exists in the runner namespace
- WHEN the reconciler provisions a session
- THEN it SHALL skip the copy
- AND proceed with pod creation

##### Scenario: ConfigMap does not exist

- GIVEN the policy ConfigMap does NOT exist in the runner namespace
- AND the ConfigMap exists in the CP namespace
- WHEN the reconciler provisions a session
- THEN it SHALL create a copy in the runner namespace
- AND the copy SHALL contain the same `data` keys as the source

---

#### Requirement: Runner Image Prerequisites

The runner container image SHALL include all dependencies required for sandbox
operation.

##### Scenario: Image contents

- GIVEN the runner Dockerfile
- WHEN the image is built
- THEN it SHALL contain:
  - `/openshell-sandbox` binary (pinned to a specific version)
  - `iproute` package (provides `ip netns` for network namespace management)
  - A `sandbox` user and group (for privilege drop target)
  - `/var/run/netns` directory with mode 777 (for network namespace mount points)
  - `/workspace` directory owned by `sandbox:sandbox`
  - `/usr/local/bin/claude` symlink to the bundled Claude CLI binary
  - `/app/openshell-claude-wrapper.sh` wrapper script

---

#### Requirement: Wrapper Script Dispatch

The wrapper script SHALL dispatch to the Supervisor or directly to Claude based
on the `OPENSHELL_ENABLED` environment variable.

##### Scenario: OpenShell enabled

- GIVEN `OPENSHELL_ENABLED=true`
- WHEN the wrapper script executes
- THEN it SHALL exec the Supervisor with `--policy-rules`, `--policy-data`, `--log-level` flags
- AND pass the Claude binary path and all arguments after `--`

##### Scenario: OpenShell disabled

- GIVEN `OPENSHELL_ENABLED` is unset or not `true`
- WHEN the wrapper script executes
- THEN it SHALL exec the Claude binary directly

---

### Operational Notes

#### Supervisor Log Messages (OCSF Format)

The Supervisor emits structured logs in OCSF (Open Cybersecurity Schema Framework) format:

| Log Entry | Severity | Meaning |
|-----------|----------|---------|
| `CONFIG:LOADING` | INFO | Loading policy from local files |
| `CONFIG:VALIDATED` | INFO | Sandbox user validated in image |
| `CONFIG:ENABLED` | INFO | TLS termination enabled, ephemeral CA generated |
| `CONFIG:CREATING` | INFO | Creating network namespace |
| `CONFIG:CREATED` | INFO | Network namespace created with IP addresses |
| `CONFIG:DEGRADED` | MEDIUM | `nft` not found; bypass detection rules not installed |
| `CONFIG:PROBED` | INFO | Landlock availability probed |
| `CONFIG:BUILT` | INFO | Landlock ruleset built with rule counts |
| `NET:LISTEN` | INFO | Proxy listening on address |
| `PROC:LAUNCH` | INFO | Child process spawned |
| `CONFIG:CLEANED_UP` | INFO | Network namespace cleaned up |

#### Debugging

Set `OPENSHELL_LOG_LEVEL=debug` in the wrapper script or environment to enable
verbose Supervisor logging. Debug output includes individual Landlock rule
applications, `ip` command invocations, and certificate processing details.

#### OpenShift Cluster Setup

1. Create a custom SCC named `openshell-sandbox` with the required capabilities
2. Bind the SCC to the runner service account via a ClusterRoleBinding or
   namespace-scoped RoleBinding with `system:openshift:scc:openshell-sandbox`
3. Verify with `oc get pod <pod> -o jsonpath='{.metadata.annotations.openshift\.io/scc}'`
   — it should show `openshell-sandbox`

---

## References

### From: Identity Boundaries

References

- [Ambient Data Model Spec](platform.spec.md) — Credential/RBAC schemas, endpoints, provider enum
- [Security Standards](standards/security/security.spec.md)
- [User Token Authentication ADR](../../docs/internal/adr/0002-user-token-authentication.md)

### From: SSO Authentication

References

- [Security Specification](#identity-boundaries) — identity boundaries, token propagation
- [K8s Client Usage Patterns](standards/control-plane/conventions.spec.md) — user-scoped vs. SA client patterns
- [Security Standards](standards/security/security.spec.md) — token handling, RBAC enforcement
- [ADR-0002](../../docs/internal/adr/0002-user-token-authentication.md) — superseded by this spec
- [OAuth 2.0 for Browser-Based Applications](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps) — BFF recommendation
- [K8s User Impersonation](https://kubernetes.io/docs/reference/access-authn-authz/authentication/#user-impersonation)
- Migration workflow: removed (content archived in git history as `workflows/security/sso-migration.workflow.md`)
- [IAM consolidation proposal](../../docs/internal/proposals/iam-consolidation-plan.md) (PR #1466) — full IAM audit and long-term consolidation plan

### From: RBAC Enforcement

References

- [Ambient Data Model Spec](platform.spec.md) — Role, RoleBinding schemas, built-in roles, permission matrix
- [Security Specification](#identity-boundaries) — identity boundaries, credential authorization model
- [SSO Authentication Spec](#sso-authentication) — JWT validation, identity claims
- [Security Standards](standards/security/security.spec.md) — token handling, RBAC patterns