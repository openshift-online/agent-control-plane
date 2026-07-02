package gateway

import (
	"context"
	"os"
	"sync"

	"github.com/openshift-online/rh-trex-ai/pkg/auth"
)

// GatewayConfig holds the gateway mode configuration loaded from environment variables.
type GatewayConfig struct {
	UseGateway bool
	Enabled    bool
}

// LoadGatewayConfig reads the gateway configuration from environment variables.
// This function is pure (no sync.Once) and can be tested directly.
func LoadGatewayConfig() GatewayConfig {
	return GatewayConfig{
		UseGateway: os.Getenv("OPENSHELL_USE_GATEWAY") == "true",
		Enabled:    os.Getenv("OPENSHELL_ENABLED") == "true",
	}
}

var (
	gatewayConfig GatewayConfig
	once          sync.Once
)

// IsGatewayModeActive returns true when both OPENSHELL_USE_GATEWAY=true
// AND OPENSHELL_ENABLED=true. Computed once at init time.
func IsGatewayModeActive() bool {
	once.Do(func() {
		gatewayConfig = LoadGatewayConfig()
	})
	return gatewayConfig.UseGateway && gatewayConfig.Enabled
}

const controlPlaneSAUsername = "system:serviceaccount:ambient-code:ambient-control-plane"

// IsControlPlaneServiceAccount returns true when the request context
// carries the control-plane service account identity, OR when there
// is no username (non-JWT token like test-user-token or K8s SA token
// that wasn't validated via JWT).
func IsControlPlaneServiceAccount(ctx context.Context) bool {
	username := auth.GetUsernameFromContext(ctx)
	// Allow K8s service account in production
	if username == controlPlaneSAUsername {
		return true
	}
	// In dev/kind, the control plane uses a K8s SA token but JWT auth is enabled.
	// The token isn't validated as a JWT, so username will be empty.
	// We identify the control plane by the absence of a username (non-JWT token).
	return username == ""
}
