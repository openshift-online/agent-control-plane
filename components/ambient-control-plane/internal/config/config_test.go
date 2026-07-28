package config

import (
	"os"
	"strings"
	"testing"
)

func TestLoadOpenShellGatewaySATokenPath(t *testing.T) {
	const (
		envName     = "OPENSHELL_GATEWAY_SA_TOKEN_PATH"
		defaultPath = "/var/run/secrets/kubernetes.io/serviceaccount/token"
	)
	tests := []struct {
		name  string
		set   bool
		value string
		want  string
	}{
		{name: "unset uses production default", want: defaultPath},
		{name: "explicit empty disables bearer token", set: true, value: "", want: ""},
		{name: "explicit path overrides default", set: true, value: "/custom/token", want: "/custom/token"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("AMBIENT_API_TOKEN", "test-token")
			if tt.set {
				t.Setenv(envName, tt.value)
			} else {
				t.Setenv(envName, "restore-sentinel")
				if err := os.Unsetenv(envName); err != nil {
					t.Fatalf("Unsetenv(%q): %v", envName, err)
				}
			}
			cfg, err := Load()
			if err != nil {
				t.Fatalf("Load() error = %v", err)
			}
			if cfg.OpenShellGatewaySATokenPath != tt.want {
				t.Fatalf("OpenShellGatewaySATokenPath = %q, want %q", cfg.OpenShellGatewaySATokenPath, tt.want)
			}
		})
	}
}

func TestLoadValidatesMLflowTrackingURI(t *testing.T) {
	tests := []struct {
		name    string
		uri     string
		wantErr string
	}{
		{
			name: "https URI is accepted",
			uri:  "https://mlflow.example.com",
		},
		{
			name: "http loopback URI is accepted",
			uri:  "http://127.0.0.1:5000",
		},
		{
			name:    "relative URI is rejected",
			uri:     "/mlflow",
			wantErr: "absolute URL",
		},
		{
			name:    "credential-bearing URI is rejected",
			uri:     "https://user:pass@mlflow.example.com",
			wantErr: "must not include credentials",
		},
		{
			name:    "non-https remote URI is rejected",
			uri:     "http://mlflow.example.com",
			wantErr: "must use https",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("AMBIENT_API_TOKEN", "test-token")
			t.Setenv("MLFLOW_TRACKING_URI", tt.uri)

			_, err := Load()
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("Load() error = %v, want nil", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("Load() error = nil, want %q", tt.wantErr)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("Load() error = %q, want substring %q", err, tt.wantErr)
			}
		})
	}
}
