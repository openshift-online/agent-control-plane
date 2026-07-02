package rbac

import (
	"context"
	"testing"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/middleware"
)

func TestIsRBACEnabled_DefaultsTrue(t *testing.T) {
	cleanup := OverrideForTesting(true)
	defer cleanup()
	if !IsRBACEnabled() {
		t.Fatal("expected RBAC enabled by default")
	}
}

func TestIsRBACEnabled_CanDisable(t *testing.T) {
	cleanup := OverrideForTesting(false)
	defer cleanup()
	if IsRBACEnabled() {
		t.Fatal("expected RBAC disabled after override")
	}
}

func TestRequireGitOpsManaged_AllowsServiceCaller(t *testing.T) {
	cleanup := OverrideForTesting(true)
	defer cleanup()
	ctx := middleware.WithCallerType(context.Background(), middleware.CallerTypeService)
	if err := RequireGitOpsManaged(ctx, "Agent"); err != nil {
		t.Fatalf("service caller should not be blocked: %v", err)
	}
}

func TestRequireGitOpsManaged_BlocksUserCaller(t *testing.T) {
	cleanup := OverrideForTesting(true)
	defer cleanup()
	if err := RequireGitOpsManaged(context.Background(), "Agent"); err == nil {
		t.Fatal("expected 403 for user caller when RBAC enabled")
	}
}

func TestRequireGitOpsManaged_DisabledAllowsAll(t *testing.T) {
	cleanup := OverrideForTesting(false)
	defer cleanup()
	if err := RequireGitOpsManaged(context.Background(), "Agent"); err != nil {
		t.Fatalf("should allow all when RBAC disabled: %v", err)
	}
}
