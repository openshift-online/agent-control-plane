package gateway

import (
	"os"
	"sync"
)

var (
	gatewayMode bool
	once        sync.Once
)

// IsGatewayModeActive returns true when both OPENSHELL_USE_GATEWAY=true
// AND OPENSHELL_ENABLED=true. Computed once at init time.
func IsGatewayModeActive() bool {
	once.Do(func() {
		useGateway := os.Getenv("OPENSHELL_USE_GATEWAY") == "true"
		enabled := os.Getenv("OPENSHELL_ENABLED") == "true"
		gatewayMode = useGateway && enabled
	})
	return gatewayMode
}
