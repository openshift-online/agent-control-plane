package reconciler

import (
	"testing"

	sandboxpb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/sandbox/v1"
)

func TestRewriteServiceHostNamespace(t *testing.T) {
	tests := []struct {
		name      string
		host      string
		namespace string
		want      string
	}{
		{"cp short", "ambient-control-plane.ambient-code.svc", "ambient-dev", "ambient-control-plane.ambient-dev.svc"},
		{"cp fqdn", "ambient-control-plane.ambient-code.svc.cluster.local", "ambient-dev", "ambient-control-plane.ambient-dev.svc.cluster.local"},
		{"api short", "ambient-api-server.ambient-code.svc", "pr-42", "ambient-api-server.pr-42.svc"},
		{"api fqdn", "ambient-api-server.ambient-code.svc.cluster.local", "pr-42", "ambient-api-server.pr-42.svc.cluster.local"},
		{"already correct", "ambient-control-plane.ambient-dev.svc", "ambient-dev", "ambient-control-plane.ambient-dev.svc"},
		{"unknown service", "some-other-service.ambient-code.svc", "ambient-dev", "some-other-service.ambient-code.svc"},
		{"external host", "api.anthropic.com", "ambient-dev", "api.anthropic.com"},
		{"empty host", "", "ambient-dev", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := rewriteServiceHostNamespace(tt.host, tt.namespace)
			if got != tt.want {
				t.Errorf("rewriteServiceHostNamespace(%q, %q) = %q, want %q", tt.host, tt.namespace, got, tt.want)
			}
		})
	}
}

func TestEnsureACPInternalPolicy_NilPolicy(t *testing.T) {
	result := ensureACPInternalPolicy(nil, "ambient-dev")
	if result == nil {
		t.Fatal("expected non-nil policy")
	}
	rule, ok := result.NetworkPolicies[acpInternalPolicyKey]
	if !ok {
		t.Fatal("expected _acp_internal rule")
	}
	if rule.Name != "acp-internal" {
		t.Errorf("rule name = %q, want %q", rule.Name, "acp-internal")
	}
	if len(rule.Endpoints) != 6 {
		t.Errorf("endpoints count = %d, want 6", len(rule.Endpoints))
	}
	for _, ep := range rule.Endpoints {
		if !contains(ep.Host, "ambient-dev") {
			t.Errorf("endpoint host %q does not contain namespace ambient-dev", ep.Host)
		}
	}
	if len(rule.Binaries) != 4 {
		t.Errorf("binaries count = %d, want 4", len(rule.Binaries))
	}
}

func TestEnsureACPInternalPolicy_EmptyNetworkPolicies(t *testing.T) {
	policy := &sandboxpb.SandboxPolicy{}
	result := ensureACPInternalPolicy(policy, "my-ns")
	rule := result.NetworkPolicies[acpInternalPolicyKey]
	if rule == nil {
		t.Fatal("expected _acp_internal rule to be injected")
	}
	if rule.Endpoints[0].Host != "ambient-control-plane.my-ns.svc" {
		t.Errorf("first endpoint host = %q, want ambient-control-plane.my-ns.svc", rule.Endpoints[0].Host)
	}
}

func TestEnsureACPInternalPolicy_RewritesExisting(t *testing.T) {
	policy := &sandboxpb.SandboxPolicy{
		NetworkPolicies: map[string]*sandboxpb.NetworkPolicyRule{
			"_acp_internal": {
				Name: "acp-internal",
				Endpoints: []*sandboxpb.NetworkEndpoint{
					{Host: "ambient-control-plane.ambient-code.svc", Port: 8080},
					{Host: "ambient-control-plane.ambient-code.svc.cluster.local", Port: 8080},
					{Host: "ambient-api-server.ambient-code.svc", Port: 8000},
					{Host: "ambient-api-server.ambient-code.svc.cluster.local", Port: 8000},
					{Host: "ambient-api-server.ambient-code.svc", Port: 9000},
					{Host: "ambient-api-server.ambient-code.svc.cluster.local", Port: 9000},
				},
				Binaries: []*sandboxpb.NetworkBinary{
					{Path: "/sandbox/.venv/bin/python"},
				},
			},
			"claude_code_vertex": {
				Name: "claude-code-vertex",
				Endpoints: []*sandboxpb.NetworkEndpoint{
					{Host: "us-east5-aiplatform.googleapis.com", Port: 443},
				},
			},
		},
	}

	result := ensureACPInternalPolicy(policy, "ambient-dev")

	rule := result.NetworkPolicies[acpInternalPolicyKey]
	expectedHosts := []string{
		"ambient-control-plane.ambient-dev.svc",
		"ambient-control-plane.ambient-dev.svc.cluster.local",
		"ambient-api-server.ambient-dev.svc",
		"ambient-api-server.ambient-dev.svc.cluster.local",
		"ambient-api-server.ambient-dev.svc",
		"ambient-api-server.ambient-dev.svc.cluster.local",
	}
	for i, ep := range rule.Endpoints {
		if ep.Host != expectedHosts[i] {
			t.Errorf("endpoint[%d].Host = %q, want %q", i, ep.Host, expectedHosts[i])
		}
	}

	if len(rule.Binaries) != 1 {
		t.Errorf("binaries should be preserved, got %d", len(rule.Binaries))
	}

	vertex := result.NetworkPolicies["claude_code_vertex"]
	if vertex == nil {
		t.Fatal("other rules should be preserved")
	}
	if vertex.Endpoints[0].Host != "us-east5-aiplatform.googleapis.com" {
		t.Error("other rule endpoints should not be modified")
	}
}

func TestEnsureACPInternalPolicy_PreservesOtherFields(t *testing.T) {
	policy := &sandboxpb.SandboxPolicy{
		Version: 2,
		Filesystem: &sandboxpb.FilesystemPolicy{
			ReadOnly:  []string{"/usr"},
			ReadWrite: []string{"/tmp"},
		},
		Process: &sandboxpb.ProcessPolicy{
			RunAsUser:  "sandbox",
			RunAsGroup: "sandbox",
		},
	}

	result := ensureACPInternalPolicy(policy, "test-ns")

	if result.Version != 2 {
		t.Errorf("version = %d, want 2", result.Version)
	}
	if result.Filesystem == nil || result.Filesystem.ReadOnly[0] != "/usr" {
		t.Error("filesystem policy should be preserved")
	}
	if result.Process == nil || result.Process.RunAsUser != "sandbox" {
		t.Error("process policy should be preserved")
	}
	if _, ok := result.NetworkPolicies[acpInternalPolicyKey]; !ok {
		t.Error("_acp_internal should be injected")
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(substr) == 0 ||
		(len(s) > 0 && len(substr) > 0 && containsStr(s, substr)))
}

func containsStr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
