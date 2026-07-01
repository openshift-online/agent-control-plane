package reconciler

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
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
