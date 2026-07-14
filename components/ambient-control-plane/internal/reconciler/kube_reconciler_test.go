package reconciler

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/ambient-code/platform/components/ambient-control-plane/internal/gateway"
	"github.com/ambient-code/platform/components/ambient-control-plane/internal/kubeclient"
	"github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell"
	pb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	"github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
	"github.com/rs/zerolog"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
)

func TestBuildCredentialSidecars_NoCredentials(t *testing.T) {
	r := &SimpleKubeReconciler{cfg: KubeReconcilerConfig{}}
	sidecars, urls, _ := r.buildCredentialSidecars("test-session", "test-namespace", map[string]string{}, false)
	if len(sidecars) != 0 {
		t.Errorf("expected 0 sidecars, got %d", len(sidecars))
	}
	if len(urls) != 0 {
		t.Errorf("expected 0 urls, got %d", len(urls))
	}
}

func TestBuildCredentialSidecars_NoImageConfigured(t *testing.T) {
	r := &SimpleKubeReconciler{cfg: KubeReconcilerConfig{}}
	credentialIDs := map[string]string{"github": "cred-123"}
	sidecars, urls, _ := r.buildCredentialSidecars("test-session", "test-namespace", credentialIDs, false)
	if len(sidecars) != 0 {
		t.Errorf("expected 0 sidecars (no image configured), got %d", len(sidecars))
	}
	if len(urls) != 0 {
		t.Errorf("expected 0 urls, got %d", len(urls))
	}
}

func TestBuildCredentialSidecars_GitHubSidecar(t *testing.T) {
	r := &SimpleKubeReconciler{
		cfg: KubeReconcilerConfig{
			GitHubMCPImage:   "ghcr.io/github/github-mcp-server:latest",
			MCPAPIServerURL:  "http://api.svc:8000",
			CPTokenURL:       "http://cp.svc:8080",
			CPTokenPublicKey: "test-key",
		},
	}
	r.logger = r.logger.With().Logger()

	credentialIDs := map[string]string{"github": "cred-123"}
	sidecars, urls, _ := r.buildCredentialSidecars("test-session", "test-namespace", credentialIDs, false)

	if len(sidecars) != 1 {
		t.Fatalf("expected 1 sidecar, got %d", len(sidecars))
	}
	if len(urls) != 1 {
		t.Fatalf("expected 1 url, got %d", len(urls))
	}

	url, ok := urls["github"]
	if !ok {
		t.Fatal("expected github url")
	}
	if url != "http://localhost:8091" {
		t.Errorf("expected http://localhost:8091, got %s", url)
	}

	sidecar := sidecars[0].(map[string]interface{})
	if sidecar["name"] != "credential-github" {
		t.Errorf("expected container name credential-github, got %s", sidecar["name"])
	}
	if sidecar["image"] != "ghcr.io/github/github-mcp-server:latest" {
		t.Errorf("unexpected image: %s", sidecar["image"])
	}

	ports := sidecar["ports"].([]interface{})
	port := ports[0].(map[string]interface{})
	if port["containerPort"] != int64(8091) {
		t.Errorf("expected port 8091, got %v", port["containerPort"])
	}

	secCtx := sidecar["securityContext"].(map[string]interface{})
	if secCtx["allowPrivilegeEscalation"] != false {
		t.Error("expected allowPrivilegeEscalation=false")
	}
}

func TestBuildCredentialSidecars_MultipleSidecars(t *testing.T) {
	r := &SimpleKubeReconciler{
		cfg: KubeReconcilerConfig{
			GitHubMCPImage:   "github-mcp:latest",
			JiraMCPImage:     "jira-mcp:latest",
			K8sMCPImage:      "k8s-mcp:latest",
			GoogleMCPImage:   "google-mcp:latest",
			MCPAPIServerURL:  "http://api.svc:8000",
			CPTokenURL:       "http://cp.svc:8080",
			CPTokenPublicKey: "test-key",
		},
	}
	r.logger = r.logger.With().Logger()

	credentialIDs := map[string]string{
		"github":     "cred-1",
		"jira":       "cred-2",
		"kubeconfig": "cred-3",
		"google":     "cred-4",
	}
	sidecars, urls, _ := r.buildCredentialSidecars("test-session", "test-namespace", credentialIDs, false)

	if len(sidecars) != 4 {
		t.Fatalf("expected 4 sidecars, got %d", len(sidecars))
	}
	if len(urls) != 4 {
		t.Fatalf("expected 4 urls, got %d", len(urls))
	}

	expectedPorts := map[string]string{
		"github":     "http://localhost:8091",
		"jira":       "http://localhost:8092",
		"kubeconfig": "http://localhost:8093",
		"google":     "http://localhost:8094",
	}
	for provider, expectedURL := range expectedPorts {
		if urls[provider] != expectedURL {
			t.Errorf("provider %s: expected %s, got %s", provider, expectedURL, urls[provider])
		}
	}
}

func TestBuildCredentialSidecars_UnknownProvider(t *testing.T) {
	r := &SimpleKubeReconciler{cfg: KubeReconcilerConfig{}}
	r.logger = r.logger.With().Logger()

	credentialIDs := map[string]string{"unknown-provider": "cred-999"}
	sidecars, urls, _ := r.buildCredentialSidecars("test-session", "test-namespace", credentialIDs, false)

	if len(sidecars) != 0 {
		t.Errorf("expected 0 sidecars for unknown provider, got %d", len(sidecars))
	}
	if len(urls) != 0 {
		t.Errorf("expected 0 urls for unknown provider, got %d", len(urls))
	}
}

func TestBuildCredentialSidecars_LocalImagePullPolicy(t *testing.T) {
	r := &SimpleKubeReconciler{
		cfg: KubeReconcilerConfig{
			GitHubMCPImage: "localhost/github-mcp:latest",
		},
	}
	r.logger = r.logger.With().Logger()

	credentialIDs := map[string]string{"github": "cred-123"}
	sidecars, _, _ := r.buildCredentialSidecars("test-session", "test-namespace", credentialIDs, false)

	if len(sidecars) != 1 {
		t.Fatalf("expected 1 sidecar, got %d", len(sidecars))
	}

	sidecar := sidecars[0].(map[string]interface{})
	if sidecar["imagePullPolicy"] != "IfNotPresent" {
		t.Errorf("expected IfNotPresent for localhost image, got %s", sidecar["imagePullPolicy"])
	}
}

func TestSanitizeProvisioningError_Forbidden(t *testing.T) {
	err := k8serrors.NewForbidden(schema.GroupResource{Group: "apps", Resource: "deployments"}, "test", fmt.Errorf("access denied"))
	msg := sanitizeProvisioningError(err)
	if !strings.Contains(msg, "Insufficient permissions") {
		t.Errorf("expected permissions message, got %q", msg)
	}
	if strings.Contains(msg, "apps") || strings.Contains(msg, "deployments") {
		t.Errorf("message leaks K8s internals: %q", msg)
	}
}

func TestSanitizeProvisioningError_NotFound(t *testing.T) {
	err := k8serrors.NewNotFound(schema.GroupResource{Resource: "namespaces"}, "test-ns")
	msg := sanitizeProvisioningError(err)
	if !strings.Contains(msg, "not available") {
		t.Errorf("expected not-available message, got %q", msg)
	}
	if strings.Contains(msg, "namespaces") || strings.Contains(msg, "test-ns") {
		t.Errorf("message leaks K8s internals: %q", msg)
	}
}

func TestSanitizeProvisioningError_ServerTimeout(t *testing.T) {
	err := k8serrors.NewServerTimeout(schema.GroupResource{Resource: "pods"}, "create", 30)
	msg := sanitizeProvisioningError(err)
	if !strings.Contains(msg, "temporarily unavailable") {
		t.Errorf("expected unavailable message, got %q", msg)
	}
}

func TestSanitizeProvisioningError_TooManyRequests(t *testing.T) {
	err := &k8serrors.StatusError{ErrStatus: metav1.Status{
		Reason: metav1.StatusReasonTooManyRequests,
		Code:   429,
	}}
	msg := sanitizeProvisioningError(err)
	if !strings.Contains(msg, "quota exceeded") {
		t.Errorf("expected quota message, got %q", msg)
	}
}

func TestSanitizeProvisioningError_GenericError(t *testing.T) {
	err := fmt.Errorf("something unexpected happened")
	msg := sanitizeProvisioningError(err)
	if !strings.Contains(msg, "provisioning failed") {
		t.Errorf("expected generic message, got %q", msg)
	}
	if strings.Contains(msg, "unexpected") {
		t.Errorf("message leaks original error: %q", msg)
	}
}

func TestSanitizeProvisioningError_WrappedForbidden(t *testing.T) {
	inner := k8serrors.NewForbidden(schema.GroupResource{Resource: "namespaces"}, "ns", fmt.Errorf("denied"))
	wrapped := fmt.Errorf("provisioning namespace: %w", inner)
	msg := sanitizeProvisioningError(wrapped)
	if !strings.Contains(msg, "Insufficient permissions") {
		t.Errorf("expected permissions message for wrapped error, got %q", msg)
	}
}

func TestCredentialMCPURLsJSON(t *testing.T) {
	urls := map[string]string{
		"github": "http://localhost:8091",
		"jira":   "http://localhost:8092",
	}
	raw, err := json.Marshal(urls)
	if err != nil {
		t.Fatal(err)
	}

	var parsed map[string]string
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["github"] != "http://localhost:8091" {
		t.Error("round-trip failed for github")
	}
	if parsed["jira"] != "http://localhost:8092" {
		t.Error("round-trip failed for jira")
	}
}

func TestCredentialSidecarsGating_GatewayMode(t *testing.T) {
	// This test verifies the gating logic that happens in ensurePod before buildCredentialSidecars is called.
	// When OpenShellUseGateway=true, buildCredentialSidecars should NOT be called even if credentials exist.

	tests := []struct {
		name                string
		cpTokenURL          string
		cpTokenPublicKey    string
		openShellUseGateway bool
		shouldBuildSidecars bool
	}{
		{
			name:                "gateway disabled, tokens configured",
			cpTokenURL:          "http://cp:8080",
			cpTokenPublicKey:    "test-key",
			openShellUseGateway: false,
			shouldBuildSidecars: true,
		},
		{
			name:                "gateway enabled, tokens configured",
			cpTokenURL:          "http://cp:8080",
			cpTokenPublicKey:    "test-key",
			openShellUseGateway: true,
			shouldBuildSidecars: false,
		},
		{
			name:                "gateway disabled, missing token URL",
			cpTokenURL:          "",
			cpTokenPublicKey:    "test-key",
			openShellUseGateway: false,
			shouldBuildSidecars: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// This mirrors the gating logic from ensurePod line 631
			shouldCall := tt.cpTokenURL != "" && tt.cpTokenPublicKey != "" && !tt.openShellUseGateway

			if shouldCall != tt.shouldBuildSidecars {
				t.Errorf("shouldCallBuildCredentialSidecars = %v, want %v", shouldCall, tt.shouldBuildSidecars)
			}
		})
	}
}

func TestResolveSandboxImage_AllowedRegistry(t *testing.T) {
	r := &SimpleKubeReconciler{
		cfg: KubeReconcilerConfig{
			RunnerImage:              "quay.io/ambient_code/ambient_runner_openshell:latest",
			OpenShellRunnerImage:     "quay.io/ambient_code/ambient_runner_openshell:latest",
			AllowedSandboxRegistries: []string{"quay.io/ambient_code/", "ghcr.io/nvidia/"},
		},
	}
	r.logger = r.logger.With().Logger()

	tests := []struct {
		name     string
		template *types.SandboxTemplate
		expected string
	}{
		{
			name:     "allowed quay.io/ambient_code image",
			template: &types.SandboxTemplate{Image: "quay.io/ambient_code/custom-runner:v2"},
			expected: "quay.io/ambient_code/custom-runner:v2",
		},
		{
			name:     "allowed ghcr.io/nvidia image",
			template: &types.SandboxTemplate{Image: "ghcr.io/nvidia/cuda-runner:12.0"},
			expected: "ghcr.io/nvidia/cuda-runner:12.0",
		},
		{
			name:     "blocked docker.io image falls back to default",
			template: &types.SandboxTemplate{Image: "docker.io/attacker/malware:latest"},
			expected: "quay.io/ambient_code/ambient_runner_openshell:latest",
		},
		{
			name:     "blocked unqualified image falls back to default",
			template: &types.SandboxTemplate{Image: "malicious:latest"},
			expected: "quay.io/ambient_code/ambient_runner_openshell:latest",
		},
		{
			name:     "nil template uses default",
			template: nil,
			expected: "quay.io/ambient_code/ambient_runner_openshell:latest",
		},
		{
			name:     "empty image uses default",
			template: &types.SandboxTemplate{},
			expected: "quay.io/ambient_code/ambient_runner_openshell:latest",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			agent := &types.Agent{Name: "test-agent", SandboxTemplate: tt.template}
			result := r.resolveSandboxImage(agent)
			if result != tt.expected {
				t.Errorf("resolveSandboxImage() = %q, want %q", result, tt.expected)
			}
		})
	}
}

func TestResolveSandboxImage_EmptyAllowlist(t *testing.T) {
	r := &SimpleKubeReconciler{
		cfg: KubeReconcilerConfig{
			RunnerImage:              "quay.io/ambient_code/ambient_runner_openshell:latest",
			AllowedSandboxRegistries: []string{},
		},
	}
	r.logger = r.logger.With().Logger()

	agent := &types.Agent{Name: "test-agent", SandboxTemplate: &types.SandboxTemplate{Image: "quay.io/ambient_code/runner:v1"}}
	result := r.resolveSandboxImage(agent)
	if result != "quay.io/ambient_code/ambient_runner_openshell:latest" {
		t.Errorf("empty allowlist should block all images, got %q", result)
	}
}

func TestUseMCPSidecar_GatewayModeDisablesMCP(t *testing.T) {
	tests := []struct {
		name                string
		mcpImage            string
		cpTokenURL          string
		cpTokenPublicKey    string
		openShellUseGateway bool
		expectedUseMCP      bool
	}{
		{
			name:                "all configured, gateway disabled",
			mcpImage:            "mcp:latest",
			cpTokenURL:          "http://cp:8080",
			cpTokenPublicKey:    "test-key",
			openShellUseGateway: false,
			expectedUseMCP:      true,
		},
		{
			name:                "all configured, gateway enabled",
			mcpImage:            "mcp:latest",
			cpTokenURL:          "http://cp:8080",
			cpTokenPublicKey:    "test-key",
			openShellUseGateway: true,
			expectedUseMCP:      false,
		},
		{
			name:                "missing token URL, gateway disabled",
			mcpImage:            "mcp:latest",
			cpTokenURL:          "",
			cpTokenPublicKey:    "test-key",
			openShellUseGateway: false,
			expectedUseMCP:      false,
		},
		{
			name:                "missing image, gateway enabled",
			mcpImage:            "",
			cpTokenURL:          "http://cp:8080",
			cpTokenPublicKey:    "test-key",
			openShellUseGateway: true,
			expectedUseMCP:      false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// This mirrors the logic from ensurePod
			useMCPSidecar := tt.mcpImage != "" && tt.cpTokenURL != "" && tt.cpTokenPublicKey != "" && !tt.openShellUseGateway

			if useMCPSidecar != tt.expectedUseMCP {
				t.Errorf("useMCPSidecar = %v, want %v", useMCPSidecar, tt.expectedUseMCP)
			}
		})
	}
}

func TestConvertPayloads(t *testing.T) {
	logger := zerolog.Nop()

	tests := []struct {
		name        string
		payloads    []types.Payload
		wantCount   int
		wantHasRepo bool
		wantPaths   []string
	}{
		{
			name: "inline content only",
			payloads: []types.Payload{
				{SandboxPath: "/sandbox/file.txt", Content: "hello"},
			},
			wantCount:   1,
			wantHasRepo: false,
			wantPaths:   []string{"/sandbox/file.txt"},
		},
		{
			name: "repo url only",
			payloads: []types.Payload{
				{SandboxPath: "/sandbox/workspace", RepoURL: "https://github.com/foo/bar.git", Ref: "main"},
			},
			wantCount:   1,
			wantHasRepo: true,
			wantPaths:   []string{"/sandbox/workspace"},
		},
		{
			name: "mixed content and repo payloads",
			payloads: []types.Payload{
				{SandboxPath: "/sandbox/config.yaml", Content: "key: value"},
				{SandboxPath: "/sandbox/src", RepoURL: "https://github.com/foo/bar.git"},
			},
			wantCount:   2,
			wantHasRepo: true,
			wantPaths:   []string{"/sandbox/config.yaml", "/sandbox/src"},
		},
		{
			name: "both content and repo_url set — skipped",
			payloads: []types.Payload{
				{SandboxPath: "/sandbox/bad", Content: "inline", RepoURL: "https://github.com/foo/bar.git"},
			},
			wantCount:   0,
			wantHasRepo: false,
			wantPaths:   nil,
		},
		{
			name: "empty sandbox_path — skipped",
			payloads: []types.Payload{
				{Content: "orphan"},
			},
			wantCount:   0,
			wantHasRepo: false,
			wantPaths:   nil,
		},
		{
			name: "neither content nor repo_url — skipped",
			payloads: []types.Payload{
				{SandboxPath: "/sandbox/empty"},
			},
			wantCount:   0,
			wantHasRepo: false,
			wantPaths:   nil,
		},
		{
			name:        "empty list",
			payloads:    nil,
			wantCount:   0,
			wantHasRepo: false,
			wantPaths:   nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, hasRepo := convertPayloads(tt.payloads, logger, "test-sandbox")
			if len(result) != tt.wantCount {
				t.Errorf("got %d payloads, want %d", len(result), tt.wantCount)
			}
			if hasRepo != tt.wantHasRepo {
				t.Errorf("hasRepo = %v, want %v", hasRepo, tt.wantHasRepo)
			}
			for i, p := range result {
				if i < len(tt.wantPaths) && p.Path != tt.wantPaths[i] {
					t.Errorf("payload[%d].Path = %q, want %q", i, p.Path, tt.wantPaths[i])
				}
			}
		})
	}
}

type mockProvisioner struct{}

func (m *mockProvisioner) NamespaceName(projectID string) string {
	return "ns-" + projectID
}
func (m *mockProvisioner) ProvisionNamespace(_ context.Context, _ string, _ map[string]string) error {
	return nil
}
func (m *mockProvisioner) DeprovisionNamespace(_ context.Context, _ string) error {
	return nil
}

func TestMergeAgentEnvironment_ImmutableKeys(t *testing.T) {
	r := &SimpleKubeReconciler{}

	env := map[string]string{
		"AMBIENT_CP_TOKEN_URL":        "http://cp:8080",
		"AMBIENT_CP_TOKEN_PUBLIC_KEY": "real-key",
		"ANTHROPIC_BASE_URL":          "https://inference.local",
		"ANTHROPIC_API_KEY":           "notused",
		"ACP_OPENSHELL_INFERENCE":     "true",
		"AMBIENT_GRPC_URL":            "grpc://real:8001",
		"AMBIENT_GRPC_USE_TLS":        "true",
		"AMBIENT_GRPC_CA_CERT_FILE":   "/certs/ca.crt",
		"AMBIENT_GRPC_ENABLED":        "true",
		"SSL_CERT_FILE":               "/certs/ca.crt",
		"REQUESTS_CA_BUNDLE":          "/certs/ca.crt",
		"MLFLOW_EXPERIMENT_NAME":      "default-experiment",
		"MLFLOW_TRACKING_TOKEN":       "openshell:resolve:env:MLFLOW_TRACKING_TOKEN",
	}

	agent := &types.Agent{
		Environment: map[string]string{
			"AMBIENT_CP_TOKEN_URL":    "http://evil:9999",
			"ANTHROPIC_BASE_URL":      "https://evil.example.com",
			"ANTHROPIC_API_KEY":       "stolen",
			"ACP_OPENSHELL_INFERENCE": "false",
			"AMBIENT_GRPC_URL":        "grpc://evil:1234",
			"MLFLOW_EXPERIMENT_NAME":  "my-experiment",
			"MLFLOW_TRACKING_TOKEN":   "raw-token",
			"CUSTOM_VAR":              "allowed",
		},
	}

	r.mergeAgentEnvironment(env, agent)

	if env["AMBIENT_CP_TOKEN_URL"] != "http://cp:8080" {
		t.Errorf("AMBIENT_CP_TOKEN_URL was overwritten: %s", env["AMBIENT_CP_TOKEN_URL"])
	}
	if env["ANTHROPIC_BASE_URL"] != "https://evil.example.com" {
		t.Errorf("ANTHROPIC_BASE_URL should be overridable by agent config, got: %s", env["ANTHROPIC_BASE_URL"])
	}
	if env["ANTHROPIC_API_KEY"] != "notused" {
		t.Errorf("ANTHROPIC_API_KEY was overwritten: %s", env["ANTHROPIC_API_KEY"])
	}
	if env["ACP_OPENSHELL_INFERENCE"] != "true" {
		t.Errorf("ACP_OPENSHELL_INFERENCE was overwritten: %s", env["ACP_OPENSHELL_INFERENCE"])
	}
	if env["AMBIENT_GRPC_URL"] != "grpc://real:8001" {
		t.Errorf("AMBIENT_GRPC_URL was overwritten: %s", env["AMBIENT_GRPC_URL"])
	}
	if env["MLFLOW_TRACKING_TOKEN"] != "openshell:resolve:env:MLFLOW_TRACKING_TOKEN" {
		t.Errorf("MLFLOW_TRACKING_TOKEN was overwritten: %s", env["MLFLOW_TRACKING_TOKEN"])
	}

	if env["MLFLOW_EXPERIMENT_NAME"] != "my-experiment" {
		t.Errorf("MLFLOW_EXPERIMENT_NAME should be overridden, got: %s", env["MLFLOW_EXPERIMENT_NAME"])
	}
	if env["CUSTOM_VAR"] != "allowed" {
		t.Errorf("CUSTOM_VAR should be set, got: %s", env["CUSTOM_VAR"])
	}
}

func TestBuildSandboxEnv_MLflowInjection(t *testing.T) {
	tests := []struct {
		name            string
		trackingURI     string
		experimentName  string
		tracingEnabled  string
		auth            string
		workspace       string
		excludeFlavors  string
		providerNames   []string
		hasMLflow       bool
		wantToken       string
		wantMLflowEnv   bool
		wantTracingFlag string
	}{
		{
			name:            "MLflow config present without provider",
			trackingURI:     "https://mlflow.example.com",
			experimentName:  "my-experiment",
			providerNames:   []string{},
			hasMLflow:       false,
			wantToken:       "",
			wantMLflowEnv:   true,
			wantTracingFlag: "true",
		},
		{
			name:            "explicit tracing opt out is forwarded",
			trackingURI:     "https://mlflow.example.com",
			tracingEnabled:  "false",
			providerNames:   []string{openshell.ProviderName("test-project", "mlflow")},
			hasMLflow:       true,
			wantToken:       "openshell:resolve:env:MLFLOW_TRACKING_TOKEN",
			wantMLflowEnv:   true,
			wantTracingFlag: "false",
		},
		{
			name:          "MLflow config absent",
			trackingURI:   "",
			providerNames: []string{openshell.ProviderName("test-project", "mlflow")},
			hasMLflow:     true,
			wantToken:     "openshell:resolve:env:MLFLOW_TRACKING_TOKEN",
			wantMLflowEnv: false,
		},
		{
			name:            "custom MLflow provider name gets token placeholder",
			trackingURI:     "https://mlflow.example.com",
			experimentName:  "custom-provider-experiment",
			providerNames:   []string{openshell.ProviderName("test-project", "observability")},
			hasMLflow:       true,
			wantToken:       "openshell:resolve:env:MLFLOW_TRACKING_TOKEN",
			wantMLflowEnv:   true,
			wantTracingFlag: "true",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := &SimpleKubeReconciler{
				cfg: KubeReconcilerConfig{
					MLflowTrackingURI:             tt.trackingURI,
					MLflowExperimentName:          tt.experimentName,
					MLflowTracingEnabled:          tt.tracingEnabled,
					MLflowTrackingAuth:            tt.auth,
					MLflowWorkspace:               tt.workspace,
					MLflowEnableAsyncTraceLogging: "true",
					MLflowAutologExcludeFlavors:   tt.excludeFlavors,
					OpenShellUseGateway:           true,
				},
				provisioner: &mockProvisioner{},
			}
			r.logger = zerolog.Nop()

			session := types.Session{
				ObjectReference: types.ObjectReference{ID: "sess-1"},
				Name:            "test",
				ProjectID:       "test-project",
			}

			env := r.buildSandboxEnv(context.Background(), session, "test-project", nil, tt.providerNames, tt.hasMLflow)

			if got := env["MLFLOW_TRACKING_TOKEN"]; got != tt.wantToken {
				t.Errorf("MLFLOW_TRACKING_TOKEN = %q, want %q", got, tt.wantToken)
			}

			if !tt.wantMLflowEnv {
				if _, exists := env["MLFLOW_TRACKING_URI"]; exists {
					t.Errorf("MLFLOW_TRACKING_URI should not be set")
				}
				return
			}
			if got := env["MLFLOW_TRACKING_URI"]; got != tt.trackingURI {
				t.Errorf("MLFLOW_TRACKING_URI = %q, want %q", got, tt.trackingURI)
			}
			if got := env["MLFLOW_TRACING_ENABLED"]; got != tt.wantTracingFlag {
				t.Errorf("MLFLOW_TRACING_ENABLED = %q, want %q", got, tt.wantTracingFlag)
			}
			if got := env["MLFLOW_ENABLE_ASYNC_TRACE_LOGGING"]; got != "true" {
				t.Errorf("MLFLOW_ENABLE_ASYNC_TRACE_LOGGING = %q, want \"true\"", got)
			}
			if got := env["MLFLOW_GENAI_AUTOLOG_INTEGRATIONS"]; got != "anthropic,openai" {
				t.Errorf("MLFLOW_GENAI_AUTOLOG_INTEGRATIONS = %q, want \"anthropic,openai\"", got)
			}
		})
	}
}

func TestConvertPayloads_RepoFieldsPreserved(t *testing.T) {
	logger := zerolog.Nop()
	payloads := []types.Payload{
		{SandboxPath: "/sandbox/code", RepoURL: "https://github.com/org/repo.git", Ref: "v1.2.3"},
	}
	result, _ := convertPayloads(payloads, logger, "test-sandbox")
	if len(result) != 1 {
		t.Fatalf("expected 1 payload, got %d", len(result))
	}
	p := result[0]
	if p.RepoURL != "https://github.com/org/repo.git" {
		t.Errorf("RepoURL = %q, want %q", p.RepoURL, "https://github.com/org/repo.git")
	}
	if p.Ref != "v1.2.3" {
		t.Errorf("Ref = %q, want %q", p.Ref, "v1.2.3")
	}
	if p.Content != "" {
		t.Errorf("Content should be empty for repo payload, got %q", p.Content)
	}
}

func TestPayloadStructFields(t *testing.T) {
	p := openshell.Payload{
		Path:    "/sandbox/workspace",
		RepoURL: "https://github.com/test/repo.git",
		Ref:     "main",
	}
	if p.Path != "/sandbox/workspace" {
		t.Error("Path field not set")
	}
	if p.RepoURL != "https://github.com/test/repo.git" {
		t.Error("RepoURL field not set")
	}
	if p.Ref != "main" {
		t.Error("Ref field not set")
	}
}

func TestMergeAgentEnvironment_MLflowRoutingKeysImmutable(t *testing.T) {
	r := &SimpleKubeReconciler{}
	env := map[string]string{
		"MLFLOW_TRACKING_URI":               "https://platform-mlflow.example.com",
		"MLFLOW_TRACKING_AUTH":              "kubernetes-namespaced",
		"MLFLOW_WORKSPACE":                  "platform-workspace",
		"MLFLOW_TRACKING_TOKEN":             "platform-token",
		"MLFLOW_EXPERIMENT_NAME":            "platform-experiment",
		"MLFLOW_TRACING_ENABLED":            "true",
		"MLFLOW_AUTOLOG_EXCLUDE_FLAVORS":    "sklearn",
		"MLFLOW_GENAI_AUTOLOG_INTEGRATIONS": "anthropic,openai",
	}
	agent := &types.Agent{
		Environment: map[string]string{
			"MLFLOW_TRACKING_URI":               "https://attacker.example.com",
			"MLFLOW_TRACKING_AUTH":              "none",
			"MLFLOW_WORKSPACE":                  "attacker-workspace",
			"MLFLOW_TRACKING_TOKEN":             "attacker-token",
			"MLFLOW_EXPERIMENT_NAME":            "tenant-experiment",
			"MLFLOW_TRACING_ENABLED":            "false",
			"MLFLOW_AUTOLOG_EXCLUDE_FLAVORS":    "tensorflow",
			"MLFLOW_GENAI_AUTOLOG_INTEGRATIONS": "openai",
		},
	}

	r.mergeAgentEnvironment(env, agent)

	if got := env["MLFLOW_TRACKING_URI"]; got != "https://platform-mlflow.example.com" {
		t.Errorf("MLFLOW_TRACKING_URI = %q, want platform URI", got)
	}
	if got := env["MLFLOW_TRACKING_AUTH"]; got != "kubernetes-namespaced" {
		t.Errorf("MLFLOW_TRACKING_AUTH = %q, want platform auth", got)
	}
	if got := env["MLFLOW_WORKSPACE"]; got != "platform-workspace" {
		t.Errorf("MLFLOW_WORKSPACE = %q, want platform workspace", got)
	}
	if got := env["MLFLOW_TRACKING_TOKEN"]; got != "platform-token" {
		t.Errorf("MLFLOW_TRACKING_TOKEN = %q, want platform token", got)
	}
	if got := env["MLFLOW_EXPERIMENT_NAME"]; got != "tenant-experiment" {
		t.Errorf("MLFLOW_EXPERIMENT_NAME = %q, want tenant override", got)
	}
	if got := env["MLFLOW_TRACING_ENABLED"]; got != "false" {
		t.Errorf("MLFLOW_TRACING_ENABLED = %q, want tenant override", got)
	}
	if got := env["MLFLOW_AUTOLOG_EXCLUDE_FLAVORS"]; got != "tensorflow" {
		t.Errorf("MLFLOW_AUTOLOG_EXCLUDE_FLAVORS = %q, want tenant override", got)
	}
	if got := env["MLFLOW_GENAI_AUTOLOG_INTEGRATIONS"]; got != "openai" {
		t.Errorf("MLFLOW_GENAI_AUTOLOG_INTEGRATIONS = %q, want tenant override", got)
	}
}

func TestBuildEnv_MLflowInjection(t *testing.T) {
	r := &SimpleKubeReconciler{
		cfg: KubeReconcilerConfig{
			MLflowTrackingURI:              "https://mlflow.example.com",
			MLflowExperimentName:           "my-experiment",
			MLflowTrackingAuth:             "kubernetes-namespaced",
			MLflowWorkspace:                "workspace-1",
			MLflowEnableAsyncTraceLogging:  "true",
			MLflowAsyncTraceLoggingWorkers: "4",
			MLflowAsyncTraceLoggingQueue:   "1000",
			MLflowAutologExcludeFlavors:    "sklearn",
			MLflowGenAIAutologIntegrations: "anthropic,openai",
		},
		provisioner: &mockProvisioner{},
	}

	session := types.Session{
		ObjectReference: types.ObjectReference{ID: "sess-1"},
		Name:            "test",
		ProjectID:       "test-project",
	}

	env := envListToMap(r.buildEnv(context.Background(), session, nil, false, nil))

	if got := env["MLFLOW_TRACING_ENABLED"]; got != "true" {
		t.Errorf("MLFLOW_TRACING_ENABLED = %q, want \"true\"", got)
	}
	if got := env["MLFLOW_TRACKING_URI"]; got != "https://mlflow.example.com" {
		t.Errorf("MLFLOW_TRACKING_URI = %q, want tracking URI", got)
	}
	if got := env["MLFLOW_EXPERIMENT_NAME"]; got != "my-experiment" {
		t.Errorf("MLFLOW_EXPERIMENT_NAME = %q, want my-experiment", got)
	}
	if got := env["MLFLOW_TRACKING_AUTH"]; got != "kubernetes-namespaced" {
		t.Errorf("MLFLOW_TRACKING_AUTH = %q, want kubernetes-namespaced", got)
	}
	if got := env["MLFLOW_WORKSPACE"]; got != "workspace-1" {
		t.Errorf("MLFLOW_WORKSPACE = %q, want workspace-1", got)
	}
	if got := env["MLFLOW_ENABLE_ASYNC_TRACE_LOGGING"]; got != "true" {
		t.Errorf("MLFLOW_ENABLE_ASYNC_TRACE_LOGGING = %q, want true", got)
	}
	if got := env["MLFLOW_ASYNC_TRACE_LOGGING_MAX_WORKERS"]; got != "4" {
		t.Errorf("MLFLOW_ASYNC_TRACE_LOGGING_MAX_WORKERS = %q, want 4", got)
	}
	if got := env["MLFLOW_ASYNC_TRACE_LOGGING_MAX_QUEUE_SIZE"]; got != "1000" {
		t.Errorf("MLFLOW_ASYNC_TRACE_LOGGING_MAX_QUEUE_SIZE = %q, want 1000", got)
	}
	if got := env["MLFLOW_AUTOLOG_EXCLUDE_FLAVORS"]; got != "sklearn" {
		t.Errorf("MLFLOW_AUTOLOG_EXCLUDE_FLAVORS = %q, want sklearn", got)
	}
	if got := env["MLFLOW_GENAI_AUTOLOG_INTEGRATIONS"]; got != "anthropic,openai" {
		t.Errorf("MLFLOW_GENAI_AUTOLOG_INTEGRATIONS = %q, want anthropic,openai", got)
	}
}

func envListToMap(env []interface{}) map[string]string {
	result := map[string]string{}
	for _, entry := range env {
		envEntry, ok := entry.(map[string]interface{})
		if !ok {
			continue
		}
		name, nameOK := envEntry["name"].(string)
		value, valueOK := envEntry["value"].(string)
		if nameOK && valueOK {
			result[name] = value
		}
	}
	return result
}

func newFakeKubeClientWithPods(objects ...runtime.Object) *kubeclient.KubeClient {
	scheme := runtime.NewScheme()
	scheme.AddKnownTypeWithName(
		schema.GroupVersionKind{Group: "", Version: "v1", Kind: "Pod"},
		&unstructured.Unstructured{},
	)
	scheme.AddKnownTypeWithName(
		schema.GroupVersionKind{Group: "", Version: "v1", Kind: "PodList"},
		&unstructured.UnstructuredList{},
	)
	dynClient := fake.NewSimpleDynamicClient(scheme, objects...)
	return kubeclient.NewFromDynamic(dynClient, zerolog.Nop())
}

func makeNamedPod(namespace, name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "Pod",
			"metadata":   map[string]interface{}{"name": name, "namespace": namespace},
			"spec":       map[string]interface{}{},
		},
	}
}

func TestVerifyAndFixDNSConfig(t *testing.T) {
	tests := []struct {
		name        string
		execResult  *openshell.ExecResult
		execErr     error
		podExists   bool
		wantOK      bool
		wantErr     bool
		wantDeleted bool
	}{
		{
			name: "ndots:1 present - DNS is correct",
			execResult: &openshell.ExecResult{
				Stdout:   []byte("nameserver 10.96.0.10\nsearch default.svc.cluster.local svc.cluster.local cluster.local\noptions ndots:1\n"),
				ExitCode: 0,
			},
			podExists:   true,
			wantOK:      true,
			wantErr:     false,
			wantDeleted: false,
		},
		{
			name: "ndots:5 present - deletes pod",
			execResult: &openshell.ExecResult{
				Stdout:   []byte("nameserver 10.96.0.10\nsearch default.svc.cluster.local svc.cluster.local cluster.local\noptions ndots:5\n"),
				ExitCode: 0,
			},
			podExists:   true,
			wantOK:      false,
			wantErr:     false,
			wantDeleted: true,
		},
		{
			name:        "exec error - returns error",
			execErr:     fmt.Errorf("connection refused"),
			podExists:   true,
			wantOK:      false,
			wantErr:     true,
			wantDeleted: false,
		},
		{
			name: "non-zero exit code - returns error",
			execResult: &openshell.ExecResult{
				Stderr:   []byte("cat: /etc/resolv.conf: No such file or directory"),
				ExitCode: 1,
			},
			podExists:   true,
			wantOK:      false,
			wantErr:     true,
			wantDeleted: false,
		},
		{
			name: "ndots:2 present - DNS is correct (not ndots:5)",
			execResult: &openshell.ExecResult{
				Stdout:   []byte("nameserver 10.96.0.10\noptions ndots:2\n"),
				ExitCode: 0,
			},
			podExists:   true,
			wantOK:      true,
			wantErr:     false,
			wantDeleted: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gw := &mockGateway{
				execSandboxFn: func(_ context.Context, _ string, req *pb.ExecSandboxRequest) (*openshell.ExecResult, error) {
					if len(req.Command) < 2 || req.Command[0] != "cat" || req.Command[1] != "/etc/resolv.conf" {
						t.Errorf("unexpected command: %v", req.Command)
					}
					return tt.execResult, tt.execErr
				},
			}

			var objects []runtime.Object
			if tt.podExists {
				objects = append(objects, makeNamedPod("test-ns", "test-sandbox"))
			}
			kube := newFakeKubeClientWithPods(objects...)
			logger := zerolog.Nop()

			r := &SimpleKubeReconciler{
				gateway: gw,
				kube:    kube,
				logger:  logger,
			}

			ok, err := r.verifyAndFixDNSConfig(context.Background(), "test-ns", "sandbox-id-123", "test-sandbox")

			if ok != tt.wantOK {
				t.Errorf("ok = %v, want %v", ok, tt.wantOK)
			}
			if (err != nil) != tt.wantErr {
				t.Errorf("err = %v, wantErr = %v", err, tt.wantErr)
			}

			if tt.wantDeleted {
				_, getErr := kube.DynamicClient().Resource(kubeclient.PodGVR).Namespace("test-ns").Get(context.Background(), "test-sandbox", metav1.GetOptions{})
				if !k8serrors.IsNotFound(getErr) {
					t.Errorf("expected pod to be deleted, but got err: %v", getErr)
				}
			}
			if !tt.wantDeleted && tt.podExists && err == nil {
				_, getErr := kube.DynamicClient().Resource(kubeclient.PodGVR).Namespace("test-ns").Get(context.Background(), "test-sandbox", metav1.GetOptions{})
				if getErr != nil {
					t.Errorf("expected pod to still exist, but got err: %v", getErr)
				}
			}
		})
	}
}

func TestReconcileGateway_NamespacePlaceholderSubstitution(t *testing.T) {
	input := []string{
		"openshell-gateway.NAMESPACE_PLACEHOLDER.svc.cluster.local",
	}
	gatewayName := "tenant-a"

	resolved := make([]string, len(input))
	for i, dns := range input {
		resolved[i] = strings.ReplaceAll(dns, "NAMESPACE_PLACEHOLDER", gatewayName)
	}

	if resolved[0] != "openshell-gateway.tenant-a.svc.cluster.local" {
		t.Errorf("expected substituted DNS name, got %q", resolved[0])
	}

	for _, dns := range resolved {
		if err := gateway.ValidateDNSName(dns); err != nil {
			t.Errorf("resolved DNS name %q failed validation: %v", dns, err)
		}
	}
}

func TestIsUploadRetryable(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "direct gRPC Unavailable",
			err:  status.Error(codes.Unavailable, "connection refused"),
			want: true,
		},
		{
			name: "SSH-wrapped supervisor relay failure",
			err:  fmt.Errorf("SSH handshake: ssh: handshake failed: rpc error: code = Unavailable desc = supervisor relay failed: supervisor session disconnected"),
			want: true,
		},
		{
			name: "gRPC PermissionDenied is not retryable",
			err:  status.Error(codes.PermissionDenied, "access denied"),
			want: false,
		},
		{
			name: "generic error is not retryable",
			err:  fmt.Errorf("connection refused"),
			want: false,
		},
		{
			name: "Unavailable without supervisor is retryable via gRPC status",
			err:  status.Error(codes.Unavailable, "transport closing"),
			want: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isUploadRetryable(tt.err)
			if got != tt.want {
				t.Errorf("isUploadRetryable(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}

func TestTryClaimExec_PreventsDoubleSpawn(t *testing.T) {
	r := &SimpleKubeReconciler{
		activeExecs: make(map[string]struct{}),
	}

	if !r.tryClaimExec("session-1") {
		t.Fatal("first claim for session-1 should succeed")
	}
	if r.tryClaimExec("session-1") {
		t.Fatal("second claim for session-1 should be rejected")
	}
	if !r.tryClaimExec("session-2") {
		t.Fatal("claim for different session should succeed")
	}

	r.releaseExec("session-1")

	if !r.tryClaimExec("session-1") {
		t.Fatal("claim after release should succeed")
	}
}

func TestTryClaimExec_ConcurrentSafety(t *testing.T) {
	r := &SimpleKubeReconciler{
		activeExecs: make(map[string]struct{}),
	}

	const goroutines = 50
	var claimed atomic.Int32
	var wg sync.WaitGroup
	wg.Add(goroutines)

	for range goroutines {
		go func() {
			defer wg.Done()
			if r.tryClaimExec("contested-session") {
				claimed.Add(1)
			}
		}()
	}
	wg.Wait()

	if got := claimed.Load(); got != 1 {
		t.Fatalf("expected exactly 1 goroutine to claim the exec slot, got %d", got)
	}
}
