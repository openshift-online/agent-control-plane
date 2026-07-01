package gateway

import (
	"testing"
)

func TestLoadGatewayConfig(t *testing.T) {
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
		{"gateway unset enabled true", "", "true", false},
		{"gateway true enabled unset", "true", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// t.Setenv auto-restores after the test and handles errors
			t.Setenv("OPENSHELL_USE_GATEWAY", tt.useGateway)
			t.Setenv("OPENSHELL_ENABLED", tt.enabled)

			cfg := LoadGatewayConfig()
			actual := cfg.UseGateway && cfg.Enabled

			if actual != tt.expectedActive {
				t.Errorf("LoadGatewayConfig() active = %v, want %v (UseGateway=%v, Enabled=%v)",
					actual, tt.expectedActive, cfg.UseGateway, cfg.Enabled)
			}
		})
	}
}
