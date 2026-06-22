# Security Specification

Security spec covering identity boundaries, SSO authentication, RBAC enforcement, credential binding, credential encryption, and sandbox isolation.

## Sub-Specs

### [Identity Boundaries](identity-boundaries.spec.md)

Six identity boundaries governing the platform: control plane SA, per-session SAs, user SSO tokens, global credentials, project-scoped build agents, and build pipeline SAs.

### [SSO Authentication](sso-authentication.spec.md)

OpenID Connect authentication with Red Hat SSO. Covers JWT validation, BFF token relay, Kubernetes user impersonation, local Keycloak for dev, and migration from OAuth proxy.

### [RBAC Enforcement](rbac-enforcement.spec.md)

Scope-aware authorization on all API endpoints (HTTP and gRPC). Covers role evaluation, permission matrix, self-service project creation, and service token bypass.

### [Credential Binding](credential-binding.spec.md)

Resolver algorithm that determines which global credentials are injected into a session. Covers agent-level, project-level, and global binding scopes with authorization rules.

### [Credential Encryption](credential-encryption.spec.md)

AES-256-GCM encryption at rest for credential tokens stored in PostgreSQL. Covers keyring management, versioned key rotation, and CLI encrypt/decrypt commands.

### [OpenShell Sandbox](openshell-sandbox.spec.md)

Network and filesystem isolation for runner pods using Linux namespaces. Covers sandbox supervisor, policy enforcement, OpenShift SCC requirements, and kernel compatibility.

### [References](references.spec.md)

Consolidated references from all security sub-specs — ADRs, external standards, and cross-spec links.

