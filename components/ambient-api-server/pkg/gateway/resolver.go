package gateway

import (
	"context"
	"sync"

	"github.com/golang/glog"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/rbac"
	"github.com/openshift-online/rh-trex-ai/pkg/auth"
	"github.com/openshift-online/rh-trex-ai/pkg/errors"
)

var (
	globalResolver *TierResolver
	resolverOnce   sync.Once
)

func GetTierResolver() *TierResolver {
	resolverOnce.Do(func() {
		var err error
		globalResolver, err = NewTierResolver()
		if err != nil {
			glog.Errorf("Failed to initialize TierResolver: %v", err)
			globalResolver = &TierResolver{enabled: false}
		}
	})
	return globalResolver
}

func CheckEditorTier(ctx context.Context, projectID string) *errors.ServiceError {
	username := auth.GetUsernameFromContext(ctx)
	if username == "" {
		return nil
	}

	tier := GetTierResolver().ResolveTier(ctx, username, projectID)

	if tier == TierNone {
		authResult := rbac.GetAuthResult(ctx)
		if rbac.IsProjectAuthorized(authResult, projectID) {
			return nil
		}
	}

	if tier == TierViewer || tier == TierNone {
		return errors.Forbidden("This operation requires Editor or Admin tier access")
	}
	return nil
}

func CheckAdminTier(ctx context.Context, projectID string) *errors.ServiceError {
	username := auth.GetUsernameFromContext(ctx)
	if username == "" {
		return nil
	}

	tier := GetTierResolver().ResolveTier(ctx, username, projectID)

	if tier == TierNone {
		authResult := rbac.GetAuthResult(ctx)
		if authResult != nil && authResult.IsGlobalAdmin {
			return nil
		}
	}

	if tier != TierAdmin {
		return errors.Forbidden("This operation requires Admin tier access")
	}
	return nil
}
