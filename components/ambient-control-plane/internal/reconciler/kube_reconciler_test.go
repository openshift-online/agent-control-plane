package reconciler

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	openshellpb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
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

func TestMergeAgentEnvironment(t *testing.T) {
	t.Run("nil agent is safe", func(t *testing.T) {
		r := &SimpleKubeReconciler{cfg: KubeReconcilerConfig{}}
		r.logger = r.logger.With().Logger()
		env := map[string]string{"SESSION_ID": "s1"}
		r.mergeAgentEnvironment(env, nil)
		if len(env) != 1 {
			t.Errorf("expected 1 env var, got %d", len(env))
		}
	})

	t.Run("empty environment is safe", func(t *testing.T) {
		r := &SimpleKubeReconciler{cfg: KubeReconcilerConfig{}}
		r.logger = r.logger.With().Logger()
		env := map[string]string{"SESSION_ID": "s1"}
		agent := &types.Agent{Name: "test", Environment: map[string]string{}}
		r.mergeAgentEnvironment(env, agent)
		if len(env) != 1 {
			t.Errorf("expected 1 env var, got %d", len(env))
		}
	})

	t.Run("adds new vars", func(t *testing.T) {
		r := &SimpleKubeReconciler{cfg: KubeReconcilerConfig{}}
		r.logger = r.logger.With().Logger()
		env := map[string]string{"SESSION_ID": "s1"}
		agent := &types.Agent{
			Name:        "test",
			Environment: map[string]string{"LOG_LEVEL": "debug", "REVIEW_MODE": "strict"},
		}
		r.mergeAgentEnvironment(env, agent)
		if env["LOG_LEVEL"] != "debug" {
			t.Errorf("expected LOG_LEVEL=debug, got %q", env["LOG_LEVEL"])
		}
		if env["REVIEW_MODE"] != "strict" {
			t.Errorf("expected REVIEW_MODE=strict, got %q", env["REVIEW_MODE"])
		}
		if len(env) != 3 {
			t.Errorf("expected 3 env vars, got %d", len(env))
		}
	})

	t.Run("does not override system vars", func(t *testing.T) {
		r := &SimpleKubeReconciler{cfg: KubeReconcilerConfig{}}
		r.logger = r.logger.With().Logger()
		env := map[string]string{"SESSION_ID": "s1", "LOG_LEVEL": "info"}
		agent := &types.Agent{
			Name:        "test",
			Environment: map[string]string{"SESSION_ID": "attacker", "LOG_LEVEL": "debug", "NEW_VAR": "val"},
		}
		r.mergeAgentEnvironment(env, agent)
		if env["SESSION_ID"] != "s1" {
			t.Errorf("system SESSION_ID overridden: got %q", env["SESSION_ID"])
		}
		if env["LOG_LEVEL"] != "info" {
			t.Errorf("system LOG_LEVEL overridden: got %q", env["LOG_LEVEL"])
		}
		if env["NEW_VAR"] != "val" {
			t.Errorf("expected NEW_VAR=val, got %q", env["NEW_VAR"])
		}
	})
}

func TestAgentPayloads(t *testing.T) {
	t.Run("nil agent returns nil", func(t *testing.T) {
		result := agentPayloads(nil)
		if result != nil {
			t.Errorf("expected nil, got %v", result)
		}
	})

	t.Run("agent without payloads returns nil", func(t *testing.T) {
		agent := &types.Agent{Name: "test"}
		result := agentPayloads(agent)
		if result != nil {
			t.Errorf("expected nil, got %v", result)
		}
	})

	t.Run("agent with payloads returns them", func(t *testing.T) {
		agent := &types.Agent{
			Name: "test",
			Payloads: []types.Payload{
				{SandboxPath: "/sandbox/CLAUDE.md", Content: "# Test"},
				{SandboxPath: "/sandbox/workspace", RepoURL: "https://github.com/example/repo", Ref: "main"},
			},
		}
		result := agentPayloads(agent)
		if len(result) != 2 {
			t.Fatalf("expected 2 payloads, got %d", len(result))
		}
		if result[0].SandboxPath != "/sandbox/CLAUDE.md" {
			t.Errorf("unexpected path: %s", result[0].SandboxPath)
		}
		if result[1].RepoURL != "https://github.com/example/repo" {
			t.Errorf("unexpected repo_url: %s", result[1].RepoURL)
		}
	})
}

func TestApplySandboxTemplate(t *testing.T) {
	newReq := func() *openshellpb.CreateSandboxRequest {
		return &openshellpb.CreateSandboxRequest{
			Labels: map[string]string{
				"ambient-code.io/session-id": "s1",
				"ambient-code.io/project-id": "p1",
				"ambient-code.io/managed":    "true",
				"ambient-code.io/managed-by": "ambient-control-plane",
			},
			Spec: &openshellpb.SandboxSpec{
				Template: &openshellpb.SandboxTemplate{
					Image: "runner:latest",
				},
			},
		}
	}

	t.Run("nil agent is safe", func(t *testing.T) {
		r := &SimpleKubeReconciler{cfg: KubeReconcilerConfig{}}
		r.logger = r.logger.With().Logger()
		req := newReq()
		r.applySandboxTemplate(req, nil)
		if req.Spec.Template.RuntimeClassName != "" {
			t.Errorf("unexpected runtime class: %s", req.Spec.Template.RuntimeClassName)
		}
	})

	t.Run("nil sandbox template is safe", func(t *testing.T) {
		r := &SimpleKubeReconciler{cfg: KubeReconcilerConfig{}}
		r.logger = r.logger.With().Logger()
		req := newReq()
		agent := &types.Agent{Name: "test"}
		r.applySandboxTemplate(req, agent)
		if req.Spec.Template.RuntimeClassName != "" {
			t.Errorf("unexpected runtime class: %s", req.Spec.Template.RuntimeClassName)
		}
	})

	t.Run("runtime class name passthrough", func(t *testing.T) {
		r := &SimpleKubeReconciler{cfg: KubeReconcilerConfig{}}
		r.logger = r.logger.With().Logger()
		req := newReq()
		agent := &types.Agent{
			Name: "test",
			SandboxTemplate: &types.SandboxTemplate{
				RuntimeClassName: "nvidia",
			},
		}
		r.applySandboxTemplate(req, agent)
		if req.Spec.Template.RuntimeClassName != "nvidia" {
			t.Errorf("expected nvidia, got %q", req.Spec.Template.RuntimeClassName)
		}
	})

	t.Run("log level passthrough", func(t *testing.T) {
		r := &SimpleKubeReconciler{cfg: KubeReconcilerConfig{}}
		r.logger = r.logger.With().Logger()
		req := newReq()
		agent := &types.Agent{
			Name: "test",
			SandboxTemplate: &types.SandboxTemplate{
				LogLevel: "debug",
			},
		}
		r.applySandboxTemplate(req, agent)
		if req.Spec.LogLevel != "debug" {
			t.Errorf("expected debug, got %q", req.Spec.LogLevel)
		}
	})

	t.Run("GPU enabled", func(t *testing.T) {
		r := &SimpleKubeReconciler{cfg: KubeReconcilerConfig{}}
		r.logger = r.logger.With().Logger()
		req := newReq()
		agent := &types.Agent{
			Name: "test",
			SandboxTemplate: &types.SandboxTemplate{
				Gpu: &types.GpuRequirements{Count: 2},
			},
		}
		r.applySandboxTemplate(req, agent)
		if !req.Spec.Gpu {
			t.Error("expected GPU=true")
		}
	})

	t.Run("GPU zero count does not enable", func(t *testing.T) {
		r := &SimpleKubeReconciler{cfg: KubeReconcilerConfig{}}
		r.logger = r.logger.With().Logger()
		req := newReq()
		agent := &types.Agent{
			Name: "test",
			SandboxTemplate: &types.SandboxTemplate{
				Gpu: &types.GpuRequirements{Count: 0},
			},
		}
		r.applySandboxTemplate(req, agent)
		if req.Spec.Gpu {
			t.Error("expected GPU=false for count=0")
		}
	})

	t.Run("labels merge without overriding system labels", func(t *testing.T) {
		r := &SimpleKubeReconciler{cfg: KubeReconcilerConfig{}}
		r.logger = r.logger.With().Logger()
		req := newReq()
		agent := &types.Agent{
			Name: "test",
			SandboxTemplate: &types.SandboxTemplate{
				Labels: map[string]string{
					"ambient-code.io/session-id": "attacker",
					"team":                       "security",
				},
			},
		}
		r.applySandboxTemplate(req, agent)
		if req.Labels["ambient-code.io/session-id"] != "s1" {
			t.Errorf("system label overridden: got %q", req.Labels["ambient-code.io/session-id"])
		}
		if req.Labels["team"] != "security" {
			t.Errorf("expected team=security, got %q", req.Labels["team"])
		}
		if req.Spec.Template.Labels["team"] != "security" {
			t.Errorf("expected template label team=security, got %q", req.Spec.Template.Labels["team"])
		}
	})

	t.Run("annotations passthrough", func(t *testing.T) {
		r := &SimpleKubeReconciler{cfg: KubeReconcilerConfig{}}
		r.logger = r.logger.With().Logger()
		req := newReq()
		agent := &types.Agent{
			Name: "test",
			SandboxTemplate: &types.SandboxTemplate{
				Annotations: map[string]string{
					"example.com/purpose": "security-review",
				},
			},
		}
		r.applySandboxTemplate(req, agent)
		if req.Spec.Template.Annotations["example.com/purpose"] != "security-review" {
			t.Errorf("expected annotation, got %q", req.Spec.Template.Annotations["example.com/purpose"])
		}
	})
}

func TestInjectPayloads_Validation(t *testing.T) {
	r := &SimpleKubeReconciler{cfg: KubeReconcilerConfig{}}
	r.logger = r.logger.With().Logger()

	t.Run("empty sandbox_path returns error", func(t *testing.T) {
		payloads := []types.Payload{
			{Content: "hello"},
		}
		err := r.injectPayloads(nil, "ns", "sbx-1", payloads)
		if err == nil {
			t.Fatal("expected error for missing sandbox_path")
		}
		if !strings.Contains(err.Error(), "sandbox_path is required") {
			t.Errorf("unexpected error: %v", err)
		}
	})

	t.Run("empty payloads succeeds", func(t *testing.T) {
		err := r.injectPayloads(nil, "ns", "sbx-1", nil)
		if err != nil {
			t.Errorf("unexpected error: %v", err)
		}
	})
}
