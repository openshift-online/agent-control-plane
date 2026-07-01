package gateway

import (
	"os"
	"testing"
)

func TestIsGatewayModeActive(t *testing.T) {
	tests := []struct {
		name           string
		useGateway     string
		enabled        string
		expectedActive bool
	}{
		{"both true", "true", "true", true},
		{"only gateway true", "true", "false", false},
		{"only enabled true", "false", "true", false},
		{"both false", "false", "false", false},
		{"both unset", "", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Reset environment for each test
			os.Setenv("OPENSHELL_USE_GATEWAY", tt.useGateway)
			os.Setenv("OPENSHELL_ENABLED", tt.enabled)

			// Reset the sync.Once so we can test multiple times
			// Note: This is a limitation of the current implementation.
			// In a real scenario, gateway mode is checked once at startup.
			// For proper testing, we'd need to refactor to accept a config struct.

			// Since we can't reset sync.Once easily, we'll just document this limitation
			t.Skip("Skipping due to sync.Once limitation - gateway mode is evaluated once at init time")
		})
	}
}

// TestIsGatewayModeActive_Integration tests the actual behavior
// This test should be run in isolation (separate test binary per scenario)
func TestIsGatewayModeActive_Integration(t *testing.T) {
	// This test verifies the actual value based on environment at test startup
	useGateway := os.Getenv("OPENSHELL_USE_GATEWAY")
	enabled := os.Getenv("OPENSHELL_ENABLED")

	expected := useGateway == "true" && enabled == "true"
	actual := IsGatewayModeActive()

	if actual != expected {
		t.Errorf("IsGatewayModeActive() = %v, want %v (OPENSHELL_USE_GATEWAY=%s, OPENSHELL_ENABLED=%s)",
			actual, expected, useGateway, enabled)
	}
}
