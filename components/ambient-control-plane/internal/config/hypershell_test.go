package config

import "testing"

func TestHypershellConfigurationRequiresSeparateIdentitiesAndTLS(t *testing.T) {
	for name, value := range map[string]string{"HYPERSHELL_API_URL": "https://hypershell.test", "HYPERSHELL_OIDC_TOKEN_URL": "https://sso.test/token", "HYPERSHELL_OIDC_CLIENT_ID": "hypershell-manager", "HYPERSHELL_OIDC_CLIENT_SECRET": "fixture-value", "HYPERSHELL_INSTANCE_ID": "test-instance", "AMBIENT_RUNNER_GRPC_ADDR": "runner.test:443", "AMBIENT_RUNNER_TOKEN_URL": "https://cp.test/token", "HYPERSHELL_GATEWAY_TEMPLATE": "{}"} {
		t.Setenv(name, value)
	}
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
