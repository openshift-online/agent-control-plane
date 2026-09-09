package config

import (
	"strings"
	"testing"
)

func setHypershellTestEnvironment(t *testing.T) {
	t.Helper()
	for name, value := range map[string]string{"HYPERSHELL_API_URL": "https://hypershell.test", "HYPERSHELL_OIDC_TOKEN_URL": "https://sso.test/token", "HYPERSHELL_OIDC_CLIENT_ID": "hypershell-manager", "HYPERSHELL_OIDC_CLIENT_SECRET": "fixture-value", "HYPERSHELL_INSTANCE_ID": "test-instance", "AMBIENT_RUNNER_GRPC_ADDR": "runner.test:443", "AMBIENT_RUNNER_TOKEN_URL": "https://cp.test/token", "HYPERSHELL_GATEWAY_TEMPLATE": "{}"} {
		t.Setenv(name, value)
	}
	t.Setenv("HYPERSHELL_SANDBOX_DRIVER_CONFIG", "")
}

func TestHypershellConfigurationRequiresSeparateIdentitiesAndTLS(t *testing.T) {
	setHypershellTestEnvironment(t)
	if _, err := LoadHypershell(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AMBIENT_RUNNER_TOKEN_URL", "http://cp.test/token")
	if _, err := LoadHypershell(); err == nil {
		t.Fatal("plaintext runner callback accepted")
	}
	t.Setenv("AMBIENT_RUNNER_TOKEN_URL", "https://cp.test/token")
	t.Setenv("HYPERSHELL_GATEWAY_TEMPLATE", `{"external_reference":"user-supplied"}`)
	if _, err := LoadHypershell(); err == nil {
		t.Fatal("operator template overrides binding reference")
	}
}

func TestHypershellSandboxConfigurationRejectsGatewayStorageSettings(t *testing.T) {
	setHypershellTestEnvironment(t)
	for _, test := range []struct{ config, message string }{
		{`{"workspace_storage_class":"test-storage"}`, "GATEWAY_WORKSPACE_STORAGE_CLASS"},
		{`{"workspace_default_storage_size":"2Gi"}`, "GATEWAY_WORKSPACE_DEFAULT_STORAGE_SIZE"},
		{`null`, "must be a JSON object"},
		{`[]`, "must be a JSON object"},
	} {
		t.Run(test.config, func(t *testing.T) {
			t.Setenv("HYPERSHELL_SANDBOX_DRIVER_CONFIG", test.config)
			if _, err := LoadHypershell(); err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("expected guidance %q, got %v", test.message, err)
			}
		})
	}
	t.Setenv("HYPERSHELL_SANDBOX_DRIVER_CONFIG", `{"containers":{"agent":{"resources":{"requests":{"memory":"1Gi"}}}},"future_driver_setting":true}`)
	if _, err := LoadHypershell(); err != nil {
		t.Fatalf("per-sandbox and future driver settings rejected: %v", err)
	}
}
