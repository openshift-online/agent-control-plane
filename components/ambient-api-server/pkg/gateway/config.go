package gateway

import (
	"os"
	"sync"
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
