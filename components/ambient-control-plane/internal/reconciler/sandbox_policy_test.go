package reconciler

import (
	"strings"
	"testing"

	sandboxpb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/sandbox/v1"
)

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
