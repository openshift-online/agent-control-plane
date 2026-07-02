package rbac

import (
	"context"
	"os"
	"sync"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/middleware"
	"github.com/openshift-online/rh-trex-ai/pkg/errors"
)

var (
	rbacEnabled     bool
	rbacEnabledOnce sync.Once
	rbacOverride    *bool
)

// IsRBACEnabled returns true when RBAC gating is active. Defaults to true
// when the RBAC_ENABLED env var is unset or empty.
func IsRBACEnabled() bool {
	if v := rbacOverride; v != nil {
		return *v
	}
	rbacEnabledOnce.Do(func() {
		v := os.Getenv("RBAC_ENABLED")
		rbacEnabled = v != "false"
	})
	return rbacEnabled
}

// OverrideForTesting overrides the RBAC-enabled state, bypassing the
// cached env-var value. Returns a cleanup function that removes the override.
func OverrideForTesting(enabled bool) func() {
	rbacOverride = &enabled
	return func() {
		rbacOverride = nil
	}
}

// RequireGitOpsManaged enforces that GitOps-managed resources (projects,
// agents, providers, policies) can only be mutated by service accounts
// (the configmap-syncer) when RBAC is enabled. User-initiated API
// mutations are rejected with 403.
func RequireGitOpsManaged(ctx context.Context, resourceLabel string) *errors.ServiceError {
	if !IsRBACEnabled() {
		return nil
	}
	if middleware.IsServiceCaller(ctx) {
		return nil
	}
	return errors.Forbidden(
		"%s management is restricted to GitOps (ConfigMap) when RBAC is enabled.", resourceLabel)
}
