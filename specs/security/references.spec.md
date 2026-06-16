# References

## From: Identity Boundaries

References

- [Ambient Data Model Spec](../platform/index.spec.md) — Credential/RBAC schemas, endpoints, provider enum
- [Security Standards](../standards/security/security.spec.md)
- [User Token Authentication ADR](../../docs/internal/adr/0002-user-token-authentication.md)

## From: SSO Authentication

References

- [Security Specification](identity-boundaries.spec.md) — identity boundaries, token propagation
- [K8s Client Usage Patterns](../standards/control-plane/conventions.spec.md) — user-scoped vs. SA client patterns
- [Security Standards](../standards/security/security.spec.md) — token handling, RBAC enforcement
- [ADR-0002](../../docs/internal/adr/0002-user-token-authentication.md) — superseded by this spec
- [OAuth 2.0 for Browser-Based Applications](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps) — BFF recommendation
- [K8s User Impersonation](https://kubernetes.io/docs/reference/access-authn-authz/authentication/#user-impersonation)
- Migration workflow: removed (content archived in git history as `workflows/security/sso-migration.workflow.md`)
- [IAM consolidation proposal](../../docs/internal/proposals/iam-consolidation-plan.md) (PR #1466) — full IAM audit and long-term consolidation plan

## From: RBAC Enforcement

References

- [Ambient Data Model Spec](../platform/index.spec.md) — Role, RoleBinding schemas, built-in roles, permission matrix
- [Security Specification](identity-boundaries.spec.md) — identity boundaries, credential authorization model
- [SSO Authentication Spec](sso-authentication.spec.md) — JWT validation, identity claims
- [Security Standards](../standards/security/security.spec.md) — token handling, RBAC patterns
