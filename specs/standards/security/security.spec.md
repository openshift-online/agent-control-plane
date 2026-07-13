# Security Standards Quick Reference

<!-- TODO: Migrate upstream to OpenShift-Fleet/agentic-sdlc and import via APM -->

> Part of [CLAUDE.md Critical Conventions](../CLAUDE.md#critical-conventions)

**When to load:** Working on authentication, authorization, RBAC, or handling sensitive data

## Critical Security Rules

### Token Handling

**1. User Token Authentication Required**

```go
// ALWAYS for user-initiated operations
reqK8s, reqDyn := GetK8sClientsForRequest(c)
if reqK8s == nil {
    c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid or missing token"})
    c.Abort()
    return
}
```

**2. Token Redaction in Logs**

**FORBIDDEN:**

```go
log.Printf("Authorization: Bearer %s", token)
log.Printf("Request headers: %v", headers)
```

**REQUIRED:**

```go
log.Printf("Token length: %d", len(token))
// Redact in URL paths
path = strings.Split(path, "?")[0] + "?token=[REDACTED]"
```

**Token Redaction Pattern:** See `server/server.go:22-34`

```go
// Custom log formatter that redacts tokens
func customRedactingFormatter(param gin.LogFormatterParams) string {
    path := param.Path
    if strings.Contains(path, "token=") {
        path = strings.Split(path, "?")[0] + "?token=[REDACTED]"
    }
    // ... rest of formatting
}
```

### Token Lifetime (K8s TokenRequest)

K8s `TokenRequest` API does NOT support non-expiring tokens. If `ExpirationSeconds` is omitted, K8s silently applies a default (~1h). Maximum enforced lifetime: **1 year** (31536000 seconds), validated in backend `CreateProjectKey`. Frontend default: 90 days.

### RBAC Enforcement

**1. Always Check Permissions Before Operations**

```go
ssar := &authv1.SelfSubjectAccessReview{
    Spec: authv1.SelfSubjectAccessReviewSpec{
        ResourceAttributes: &authv1.ResourceAttributes{
            Group:     "vteam.ambient-code",
            Resource:  "agenticsessions",
            Verb:      "list",
            Namespace: project,
        },
    },
}
res, err := reqK8s.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, ssar, v1.CreateOptions{})
if err != nil || !res.Status.Allowed {
    c.JSON(http.StatusForbidden, gin.H{"error": "Unauthorized"})
    return
}
```

**2. Namespace Isolation**

- Each project maps to a Kubernetes namespace
- User token must have permissions in that namespace
- Never bypass namespace checks

### Container Security

**Always Set SecurityContext for Job Pods**

```go
SecurityContext: &corev1.SecurityContext{
    AllowPrivilegeEscalation: boolPtr(false),
    ReadOnlyRootFilesystem:   boolPtr(false),  // Only if temp files needed
    Capabilities: &corev1.Capabilities{
        Drop: []corev1.Capability{"ALL"},
    },
},
```

### Input Validation

**1. Validate All User Input**

```go
// Validate resource names (K8s DNS label requirements)
if !isValidK8sName(name) {
    c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid name format"})
    return
}

// Validate URLs for repository inputs
if _, err := url.Parse(repoURL); err != nil {
    c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid repository URL"})
    return
}
```

**2. Sanitize for Log Injection**

```go
// Prevent log injection with newlines
name = strings.ReplaceAll(name, "\n", "")
name = strings.ReplaceAll(name, "\r", "")
```

## Common Security Patterns

### Pattern 1: Extracting Bearer Token

```go
rawAuth := c.GetHeader("Authorization")
parts := strings.SplitN(rawAuth, " ", 2)
if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
    c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid Authorization header"})
    return
}
token := strings.TrimSpace(parts[1])
// NEVER log token itself
log.Printf("Processing request with token (len=%d)", len(token))
```

### Pattern 2: Validating Project Access

```go
func ValidateProjectContext() gin.HandlerFunc {
    return func(c *gin.Context) {
        projectName := c.Param("projectName")

        // Get user-scoped K8s client
        reqK8s, _ := GetK8sClientsForRequest(c)
        if reqK8s == nil {
            c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
            c.Abort()
            return
        }

        // Check if user can access namespace
        ssar := &authv1.SelfSubjectAccessReview{
            Spec: authv1.SelfSubjectAccessReviewSpec{
                ResourceAttributes: &authv1.ResourceAttributes{
                    Resource:  "namespaces",
                    Verb:      "get",
                    Name:      projectName,
                },
            },
        }
        res, err := reqK8s.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, ssar, v1.CreateOptions{})
        if err != nil || !res.Status.Allowed {
            c.JSON(http.StatusForbidden, gin.H{"error": "Access denied to project"})
            c.Abort()
            return
        }

        c.Set("project", projectName)
        c.Next()
    }
}
```

### Pattern 3: Minting Service Account Tokens

```go
// Only backend service account can create tokens for runner pods
tokenRequest := &authv1.TokenRequest{
    Spec: authv1.TokenRequestSpec{
        ExpirationSeconds: int64Ptr(3600),
    },
}

tokenResponse, err := K8sClient.CoreV1().ServiceAccounts(namespace).CreateToken(
    ctx,
    serviceAccountName,
    tokenRequest,
    v1.CreateOptions{},
)
if err != nil {
    return fmt.Errorf("failed to create token: %w", err)
}

// Store token in secret (never log it)
secret := &corev1.Secret{
    ObjectMeta: v1.ObjectMeta{
        Name:      fmt.Sprintf("%s-token", sessionName),
        Namespace: namespace,
    },
    StringData: map[string]string{
        "token": tokenResponse.Status.Token,
    },
}
```

## Security Checklist

Before committing code that handles:

**Authentication:**

- [ ] Using user token (GetK8sClientsForRequest) for user operations
- [ ] Returning 401 if token is invalid/missing
- [ ] Not falling back to service account on auth failure

**Authorization:**

- [ ] RBAC check performed before resource access
- [ ] Using correct namespace for permission check
- [ ] Returning 403 if user lacks permissions

**Secrets & Tokens:**

- [ ] No tokens in logs (use len(token) instead)
- [ ] No tokens in error messages
- [ ] Tokens stored in Kubernetes Secrets
- [ ] Token redaction in request logs

**Input Validation:**

- [ ] All user input validated
- [ ] Resource names validated (K8s DNS label format)
- [ ] URLs parsed and validated
- [ ] Log injection prevented

**Container Security:**

- [ ] SecurityContext set on all Job pods
- [ ] AllowPrivilegeEscalation: false
- [ ] Capabilities dropped (ALL)
- [ ] OwnerReferences set for cleanup

## Audit-Driven Requirements

> Requirements in this section address findings from the 2026-07 ProdSec security audit.
> Each requirement references the originating finding ID (fNNN) for traceability.

### Requirement: Database Credentials Must Not Be Committed (f023)

PostgreSQL credentials SHALL NOT be committed in the kustomize base or any overlay.
The `ambient-api-server-db` Secret SHALL be provisioned via external-secrets,
sealed-secrets, or an `.example-template` pattern (matching the repo's own
convention for other secrets). The hardcoded password SHALL be rotated everywhere
the base was deployed.

Database connections SHALL use `--db-sslmode=require` (not `disable`) in all
overlays including production.

### Requirement: TLS Certificate Validation Must Not Be Disabled (f025)

`NODE_TLS_REJECT_UNAUTHORIZED=0` SHALL NOT be set in any production or
production-equivalent overlay. The UI BFF SHALL mount the OpenShift service-ca
bundle and set `NODE_EXTRA_CA_CERTS` to the bundle path instead of disabling
TLS verification process-wide.

### Requirement: Default-Deny NetworkPolicy with Explicit Allows (f027)

Each namespace SHALL have a default-deny NetworkPolicy. The base
`runner-networkpolicy.yaml` SHALL NOT contain an empty ingress rule (`- {}`),
which Kubernetes interprets as "allow all." Explicit per-service allow rules
SHALL be added for required traffic paths (api-server→postgres, runner→token-svc,
etc.).

The hcmais overlay SHALL NOT delete the NetworkPolicy entirely.

### Requirement: Egress NetworkPolicy for Tenant Runner Pods (f034)

Session and namespace NetworkPolicies SHALL include egress restrictions (not
ingress-only). Untrusted agent code SHALL be denied outbound access to:
- Kubernetes API server (unless required for brokered auth)
- Cloud metadata endpoints (`169.254.169.254`)
- Other tenants' unprotected services
- Arbitrary internet hosts (exfiltration prevention)

The `GCE_METADATA_HOST=metadata.invalid` env var is insufficient — agent code
can unset it. An explicit egress deny for `169.254.169.254/32` is required.

### Requirement: Pod Security Standards and SecurityContext Hardening (f044)

All workload pods (including PostgreSQL, MinIO, otel-collector, grafana,
oauth-proxy) SHALL specify a restricted SecurityContext: `runAsNonRoot: true`,
`allowPrivilegeEscalation: false`, capabilities `drop: [ALL]`, and
`seccompProfile: type: RuntimeDefault`.

All ACP-managed namespaces SHALL carry the Pod Security Admission label
`pod-security.kubernetes.io/enforce: restricted` (or `baseline` where restricted
is infeasible).

The API server Dockerfile SHALL set `USER 1001` (matching all other component
images).

## Security Review Resources

- OWASP Top 10: <https://owasp.org/www-project-top-ten/>
- Kubernetes Security Best Practices: <https://kubernetes.io/docs/concepts/security/>
- RBAC Documentation: <https://kubernetes.io/docs/reference/access-authn-authz/rbac/>
