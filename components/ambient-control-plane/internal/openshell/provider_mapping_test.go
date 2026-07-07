package openshell

import (
	"testing"
)

func TestProviderCredentialsFromSecret(t *testing.T) {
	tests := []struct {
		name     string
		provider string
		secret   map[string]string
		want     map[string]string
	}{
		{
			name:     "vertex ADC returns empty map",
			provider: "vertex",
			secret:   map[string]string{"token": `{"type":"authorized_user","client_id":"id","client_secret":"secret","refresh_token":"tok"}`},
			want:     map[string]string{},
		},
		{
			name:     "vertex SA key returns GOOGLE_SERVICE_ACCOUNT_KEY",
			provider: "vertex",
			secret:   map[string]string{"token": `{"type":"service_account","client_email":"sa@proj.iam","private_key":"-----BEGIN RSA"}`},
			want:     map[string]string{"GOOGLE_SERVICE_ACCOUNT_KEY": `{"type":"service_account","client_email":"sa@proj.iam","private_key":"-----BEGIN RSA"}`},
		},
		{
			name:     "vertex with unparseable token falls through to SA key",
			provider: "vertex",
			secret:   map[string]string{"token": "not-json"},
			want:     map[string]string{"GOOGLE_SERVICE_ACCOUNT_KEY": "not-json"},
		},
		{
			name:     "vertex with no token key returns empty secret data",
			provider: "vertex",
			secret:   map[string]string{"other": "val"},
			want:     map[string]string{"other": "val"},
		},
		{
			name:     "anthropic maps token to ANTHROPIC_API_KEY",
			provider: "anthropic",
			secret:   map[string]string{"token": "sk-ant-xxx"},
			want:     map[string]string{"ANTHROPIC_API_KEY": "sk-ant-xxx"},
		},
		{
			name:     "github maps token to GITHUB_TOKEN",
			provider: "github",
			secret:   map[string]string{"token": "ghp_xxx"},
			want:     map[string]string{"GITHUB_TOKEN": "ghp_xxx"},
		},
		{
			name:     "known type without token key falls through to passthrough",
			provider: "github",
			secret:   map[string]string{"custom-key": "val"},
			want:     map[string]string{"custom-key": "val"},
		},
		{
			name:     "unknown type passes all keys through",
			provider: "custom",
			secret:   map[string]string{"API_KEY": "abc", "API_SECRET": "xyz"},
			want:     map[string]string{"API_KEY": "abc", "API_SECRET": "xyz"},
		},
		{
			name:     "mlflow excludes URI and experiment name from credentials",
			provider: "mlflow",
			secret:   map[string]string{"MLFLOW_TRACKING_URI": "https://mlflow.example.com", "MLFLOW_TRACKING_TOKEN": "tok", "MLFLOW_EXPERIMENT_NAME": "exp", "MLFLOW_TRACKING_AUTH": "kubernetes"},
			want:     map[string]string{"MLFLOW_TRACKING_TOKEN": "tok", "MLFLOW_TRACKING_AUTH": "kubernetes"},
		},
		{
			name:     "mlflow with only token",
			provider: "mlflow",
			secret:   map[string]string{"MLFLOW_TRACKING_TOKEN": "tok"},
			want:     map[string]string{"MLFLOW_TRACKING_TOKEN": "tok"},
		},
		{
			name:     "mlflow with only URI returns empty credentials",
			provider: "mlflow",
			secret:   map[string]string{"MLFLOW_TRACKING_URI": "https://mlflow.example.com"},
			want:     map[string]string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ProviderCredentialsFromSecret(tt.provider, tt.secret)
			if len(got) != len(tt.want) {
				t.Fatalf("got %d keys %v, want %d keys %v", len(got), got, len(tt.want), tt.want)
			}
			for k, wantVal := range tt.want {
				if got[k] != wantVal {
					t.Errorf("key %q: got %q, want %q", k, got[k], wantVal)
				}
			}
		})
	}
}

func TestVertexRefreshCredentialKey(t *testing.T) {
	tests := []struct {
		name     string
		credType GoogleCredentialType
		want     string
	}{
		{
			name:     "ADC returns GOOGLE_VERTEX_AI_TOKEN",
			credType: GoogleCredentialAuthorizedUser,
			want:     "GOOGLE_VERTEX_AI_TOKEN",
		},
		{
			name:     "SA returns GOOGLE_VERTEX_AI_SERVICE_ACCOUNT_TOKEN",
			credType: GoogleCredentialServiceAccount,
			want:     "GOOGLE_VERTEX_AI_SERVICE_ACCOUNT_TOKEN",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := VertexRefreshCredentialKey(tt.credType)
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestDetectGoogleCredentialType(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		wantType GoogleCredentialType
		wantErr  bool
	}{
		{
			name:     "authorized_user",
			input:    `{"type":"authorized_user"}`,
			wantType: GoogleCredentialAuthorizedUser,
		},
		{
			name:     "service_account",
			input:    `{"type":"service_account"}`,
			wantType: GoogleCredentialServiceAccount,
		},
		{
			name:     "empty type defaults to service_account",
			input:    `{"type":""}`,
			wantType: GoogleCredentialServiceAccount,
		},
		{
			name:     "missing type field defaults to service_account",
			input:    `{"client_email":"sa@proj.iam"}`,
			wantType: GoogleCredentialServiceAccount,
		},
		{
			name:    "invalid JSON",
			input:   "not-json",
			wantErr: true,
		},
		{
			name:    "unsupported type",
			input:   `{"type":"external_account"}`,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := DetectGoogleCredentialType(tt.input)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.wantType {
				t.Errorf("got %d, want %d", got, tt.wantType)
			}
		})
	}
}

func TestMLflowSandboxEnvVars(t *testing.T) {
	tests := []struct {
		name   string
		secret map[string]string
		want   map[string]string
	}{
		{
			name:   "extracts URI and experiment name",
			secret: map[string]string{"MLFLOW_TRACKING_URI": "https://mlflow.example.com", "MLFLOW_EXPERIMENT_NAME": "exp", "MLFLOW_TRACKING_TOKEN": "tok"},
			want:   map[string]string{"MLFLOW_TRACKING_URI": "https://mlflow.example.com", "MLFLOW_EXPERIMENT_NAME": "exp"},
		},
		{
			name:   "URI only",
			secret: map[string]string{"MLFLOW_TRACKING_URI": "https://mlflow.example.com", "MLFLOW_TRACKING_TOKEN": "tok"},
			want:   map[string]string{"MLFLOW_TRACKING_URI": "https://mlflow.example.com"},
		},
		{
			name:   "empty secret returns empty map",
			secret: map[string]string{},
			want:   map[string]string{},
		},
		{
			name:   "empty values are excluded",
			secret: map[string]string{"MLFLOW_TRACKING_URI": "", "MLFLOW_EXPERIMENT_NAME": "exp"},
			want:   map[string]string{"MLFLOW_EXPERIMENT_NAME": "exp"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := MLflowSandboxEnvVars(tt.secret)
			if len(got) != len(tt.want) {
				t.Fatalf("got %d keys %v, want %d keys %v", len(got), got, len(tt.want), tt.want)
			}
			for k, wantVal := range tt.want {
				if got[k] != wantVal {
					t.Errorf("key %q: got %q, want %q", k, got[k], wantVal)
				}
			}
		})
	}
}

func TestOpenShellProviderType_MLflow(t *testing.T) {
	if got := OpenShellProviderType("mlflow"); got != "generic" {
		t.Errorf("OpenShellProviderType(mlflow) = %q, want %q", got, "generic")
	}
}
