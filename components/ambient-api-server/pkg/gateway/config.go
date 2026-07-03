package gateway

// IsGatewayModeActive always returns true. Gateway mode is the only supported
// operating mode — the env-var–gated dual-mode logic has been removed.
func IsGatewayModeActive() bool {
	return true
}
