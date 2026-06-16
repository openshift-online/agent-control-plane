# Control Plane Development Context

<!-- TODO: Migrate upstream to OpenShift-Fleet/agentic-sdlc and import via APM -->

> Part of [CLAUDE.md Critical Conventions](../../CLAUDE.md#critical-conventions)

**When to load:** Working on the control plane, reconciliation logic, or Job management

## Quick Reference

- **Language:** Go 1.21+
- **Pattern:** gRPC watch-stream reconciler (watches the API server via gRPC streams, not controller-runtime)
- **Primary Files:** `internal/handlers/sessions.go`, `internal/config/config.go`

## Critical Rules

### Resource Cleanup

The control plane is responsible for cleaning up Kubernetes resources (Pods, Secrets) when a session is deleted or completed. Since v2 does not use CRDs as parent objects, cleanup is driven by the API server's session lifecycle events received via gRPC.

### SecurityContext on Job Pod Specs

All Job pod specs must include a restrictive SecurityContext:

```go
SecurityContext: &corev1.SecurityContext{
    AllowPrivilegeEscalation: boolPtr(false),
    ReadOnlyRootFilesystem:   boolPtr(false),
    Capabilities: &corev1.Capabilities{
        Drop: []corev1.Capability{"ALL"},
    },
},
```

### Resource Limits and Requests

Job containers must specify resource requirements to prevent unbounded resource consumption.

### Reconciliation Error Handling

```go
// Resource deleted during reconciliation — NOT an error
if errors.IsNotFound(err) {
    log.Printf("Resource %s/%s deleted, skipping", namespace, name)
    return ctrl.Result{}, nil  // Don't requeue
}

// Transient error — return error to requeue
if err != nil {
    return ctrl.Result{}, fmt.Errorf("failed to get object: %w", err)
}
```

**Key patterns:**
- `IsNotFound` → return `ctrl.Result{}, nil` (resource gone, no retry)
- Transient errors → return `ctrl.Result{}, err` (triggers requeue with backoff)
- Terminal errors → update CR status to "Failed", return `ctrl.Result{}, nil` (don't retry)

### Status Updates on Error

When an operation fails, always update the CR status before returning:

```go
updateAgenticSessionStatus(namespace, name, map[string]interface{}{
    "phase":   "Failed",
    "message": fmt.Sprintf("Failed to create job: %v", err),
})
```

### Context Propagation

Use the context from the reconciliation request, not `context.TODO()`:

```go
// Bad
ctx := context.TODO()

// Good — use the ctx parameter from the Reconcile(ctx, req) signature
// The ctx is already provided as the first argument to Reconcile and phase handlers
```

### No panic() in Production

Same as backend: return `fmt.Errorf` with context instead. A panic crashes the entire control plane, affecting all sessions.

## Pre-Commit Checklist

- [ ] OwnerReferences set on all child resources
- [ ] SecurityContext on all Job pod specs
- [ ] Resource limits/requests on containers
- [ ] Status updated on error paths
- [ ] No `panic()` in non-test code
- [ ] Proper context propagation (no `context.TODO()`)
- [ ] `gofmt -w .` applied
- [ ] `go vet ./...` passes
