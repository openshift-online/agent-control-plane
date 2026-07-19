package reconciler

import (
	"strings"
	"testing"

	sandboxpb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/sandbox/v1"
)

func TestParsePolicySpec(t *testing.T) {
	tests := []struct {
		name    string
		spec    string
		wantErr bool
		check   func(t *testing.T, p *sandboxpb.SandboxPolicy)
	}{
		{
			name: "filesystem_policy key populates Filesystem field",
			spec: `{"version":1,"filesystem_policy":{"include_workdir":true,"read_only":["/usr","/bin"],"read_write":["/workspace"]}}`,
			check: func(t *testing.T, p *sandboxpb.SandboxPolicy) {
				if p.Version != 1 {
					t.Errorf("Version = %d, want 1", p.Version)
				}
				if p.Filesystem == nil {
					t.Fatal("Filesystem is nil — filesystem_policy key was not mapped")
				}
				if !p.Filesystem.IncludeWorkdir {
					t.Error("IncludeWorkdir = false, want true")
				}
				if len(p.Filesystem.ReadOnly) != 2 {
					t.Errorf("ReadOnly count = %d, want 2", len(p.Filesystem.ReadOnly))
				}
				if len(p.Filesystem.ReadWrite) != 1 || p.Filesystem.ReadWrite[0] != "/workspace" {
					t.Errorf("ReadWrite = %v, want [/workspace]", p.Filesystem.ReadWrite)
				}
			},
		},
		{
			name: "no filesystem_policy key leaves Filesystem nil",
			spec: `{"version":2,"landlock":{"compatibility":"best_effort"}}`,
			check: func(t *testing.T, p *sandboxpb.SandboxPolicy) {
				if p.Version != 2 {
					t.Errorf("Version = %d, want 2", p.Version)
				}
				if p.Filesystem != nil {
					t.Errorf("Filesystem = %v, want nil", p.Filesystem)
				}
				if p.Landlock == nil || p.Landlock.Compatibility != "best_effort" {
					t.Errorf("Landlock not parsed correctly: %v", p.Landlock)
				}
			},
		},
		{
			name: "network_policies parsed",
			spec: `{"version":1,"filesystem_policy":{"read_only":["/usr"]},"network_policies":{"web":{"name":"web","endpoints":[{"host":"example.com","port":443}]}}}`,
			check: func(t *testing.T, p *sandboxpb.SandboxPolicy) {
				if p.Filesystem == nil {
					t.Fatal("Filesystem is nil")
				}
				if len(p.NetworkPolicies) != 1 {
					t.Fatalf("NetworkPolicies count = %d, want 1", len(p.NetworkPolicies))
				}
				rule := p.NetworkPolicies["web"]
				if rule == nil || rule.Name != "web" {
					t.Errorf("expected network policy 'web', got %v", rule)
				}
			},
		},
		{
			name: "process policy parsed",
			spec: `{"version":1,"process":{"run_as_user":"sandbox","run_as_group":"sandbox"}}`,
			check: func(t *testing.T, p *sandboxpb.SandboxPolicy) {
				if p.Process == nil {
					t.Fatal("Process is nil")
				}
				if p.Process.RunAsUser != "sandbox" {
					t.Errorf("RunAsUser = %q, want sandbox", p.Process.RunAsUser)
				}
				if p.Process.RunAsGroup != "sandbox" {
					t.Errorf("RunAsGroup = %q, want sandbox", p.Process.RunAsGroup)
				}
			},
		},
		{
			name:    "invalid JSON returns error",
			spec:    "not-json{{{",
			wantErr: true,
		},
		{
			name: "empty filesystem_policy object",
			spec: `{"version":1,"filesystem_policy":{}}`,
			check: func(t *testing.T, p *sandboxpb.SandboxPolicy) {
				if p.Filesystem == nil {
					t.Fatal("Filesystem is nil for empty filesystem_policy object")
				}
				if len(p.Filesystem.ReadOnly) != 0 {
					t.Errorf("ReadOnly = %v, want empty", p.Filesystem.ReadOnly)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			policy, err := parsePolicySpec(tt.spec)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tt.check != nil {
				tt.check(t, policy)
			}
		})
	}
}

func TestPlatformMergeOperations(t *testing.T) {
	ops := platformMergeOperations("pr-42")
	if len(ops) != 2 {
		t.Fatalf("expected 2 operations, got %d", len(ops))
	}

	// First operation: _acp_internal
	acpOp := ops[0]
	addRule := acpOp.GetAddRule()
	if addRule == nil {
		t.Fatal("expected AddRule operation for _acp_internal")
	}
	if addRule.RuleName != acpInternalPolicyKey {
		t.Errorf("rule name = %q, want %q", addRule.RuleName, acpInternalPolicyKey)
	}
	rule := addRule.Rule
	if rule == nil {
		t.Fatal("expected non-nil rule")
	}
	if rule.Name != "acp-internal" {
		t.Errorf("rule.Name = %q, want %q", rule.Name, "acp-internal")
	}
	if len(rule.Endpoints) != 6 {
		t.Errorf("endpoints count = %d, want 6", len(rule.Endpoints))
	}
	for _, ep := range rule.Endpoints {
		if !strings.Contains(ep.Host, "pr-42") {
			t.Errorf("endpoint host %q does not contain namespace pr-42", ep.Host)
		}
	}
	if len(rule.Binaries) != 4 {
		t.Errorf("binaries count = %d, want 4", len(rule.Binaries))
	}

	// Second operation: _mlflow_rh
	mlflowOp := ops[1]
	mlflowAddRule := mlflowOp.GetAddRule()
	if mlflowAddRule == nil {
		t.Fatal("expected AddRule operation for _mlflow_rh")
	}
	if mlflowAddRule.RuleName != mlflowPolicyKey {
		t.Errorf("rule name = %q, want %q", mlflowAddRule.RuleName, mlflowPolicyKey)
	}
	mlflowRule := mlflowAddRule.Rule
	if mlflowRule == nil {
		t.Fatal("expected non-nil mlflow rule")
	}
	if mlflowRule.Name != "mlflow-tracking" {
		t.Errorf("mlflow rule.Name = %q, want %q", mlflowRule.Name, "mlflow-tracking")
	}
	if len(mlflowRule.Endpoints) != 1 {
		t.Errorf("mlflow endpoints count = %d, want 1", len(mlflowRule.Endpoints))
	}
}

func TestPlatformMergeOperations_EndpointPorts(t *testing.T) {
	ops := platformMergeOperations("test-ns")
	rule := ops[0].GetAddRule().Rule

	expectedEndpoints := []struct {
		host string
		port uint32
	}{
		{"ambient-control-plane.test-ns.svc", 8080},
		{"ambient-control-plane.test-ns.svc.cluster.local", 8080},
		{"ambient-api-server.test-ns.svc", 8000},
		{"ambient-api-server.test-ns.svc.cluster.local", 8000},
		{"ambient-api-server.test-ns.svc", 9000},
		{"ambient-api-server.test-ns.svc.cluster.local", 9000},
	}

	for i, want := range expectedEndpoints {
		if rule.Endpoints[i].Host != want.host {
			t.Errorf("endpoint[%d].Host = %q, want %q", i, rule.Endpoints[i].Host, want.host)
		}
		if rule.Endpoints[i].Port != want.port {
			t.Errorf("endpoint[%d].Port = %d, want %d", i, rule.Endpoints[i].Port, want.port)
		}
	}
}

func TestPlatformMergeOperations_Binaries(t *testing.T) {
	ops := platformMergeOperations("ns")
	rule := ops[0].GetAddRule().Rule

	expectedBinaries := []string{
		"/sandbox/.venv/bin/python",
		"/sandbox/.venv/bin/python3",
		"/sandbox/.venv/bin/uvicorn",
		"/sandbox/.uv/python/cpython-*/bin/python*",
	}

	if len(rule.Binaries) != len(expectedBinaries) {
		t.Fatalf("binaries count = %d, want %d", len(rule.Binaries), len(expectedBinaries))
	}
	for i, want := range expectedBinaries {
		if rule.Binaries[i].Path != want {
			t.Errorf("binary[%d].Path = %q, want %q", i, rule.Binaries[i].Path, want)
		}
	}
}

func TestMergePlatformRules_EmptyPolicy(t *testing.T) {
	policy := &sandboxpb.SandboxPolicy{}
	result := mergePlatformRules(policy, "ns")

	if len(result.NetworkPolicies) != 2 {
		t.Fatalf("network policies count = %d, want 2", len(result.NetworkPolicies))
	}
	if _, ok := result.NetworkPolicies[acpInternalPolicyKey]; !ok {
		t.Error("missing _acp_internal rule")
	}
	if _, ok := result.NetworkPolicies[mlflowPolicyKey]; !ok {
		t.Error("missing _mlflow_rh rule")
	}

	acpRule := result.NetworkPolicies[acpInternalPolicyKey]
	if len(acpRule.Endpoints) != 6 {
		t.Errorf("_acp_internal endpoints = %d, want 6", len(acpRule.Endpoints))
	}
}

func TestMergePlatformRules_PreservesExistingRules(t *testing.T) {
	policy := &sandboxpb.SandboxPolicy{
		NetworkPolicies: map[string]*sandboxpb.NetworkPolicyRule{
			"custom_api": {
				Name: "custom-api",
				Endpoints: []*sandboxpb.NetworkEndpoint{
					{Host: "api.example.com", Port: 443},
				},
			},
		},
	}
	result := mergePlatformRules(policy, "test-ns")

	if len(result.NetworkPolicies) != 3 {
		t.Fatalf("network policies count = %d, want 3", len(result.NetworkPolicies))
	}
	if _, ok := result.NetworkPolicies["custom_api"]; !ok {
		t.Error("agent rule 'custom_api' was removed")
	}
	if _, ok := result.NetworkPolicies[acpInternalPolicyKey]; !ok {
		t.Error("missing _acp_internal rule")
	}
	if _, ok := result.NetworkPolicies[mlflowPolicyKey]; !ok {
		t.Error("missing _mlflow_rh rule")
	}
}

func TestMergePlatformRules_NamespaceScoped(t *testing.T) {
	policy := &sandboxpb.SandboxPolicy{}
	result := mergePlatformRules(policy, "pr-99")

	acpRule := result.NetworkPolicies[acpInternalPolicyKey]
	for _, ep := range acpRule.Endpoints {
		if !strings.Contains(ep.Host, "pr-99") {
			t.Errorf("endpoint host %q does not contain namespace pr-99", ep.Host)
		}
	}
}
