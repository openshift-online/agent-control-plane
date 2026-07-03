package gateway

import (
	"testing"
)

func TestIsGatewayModeActive(t *testing.T) {
	if !IsGatewayModeActive() {
		t.Error("IsGatewayModeActive() = false, want true")
	}
}
