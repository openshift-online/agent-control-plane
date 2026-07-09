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

func TestPolicyReplacementOperations_LockedDown(t *testing.T) {
	// A locked-down policy with no network_policies should produce:
	// len(bakedInRuleNames) RemoveRule ops + 2 platform AddRule ops
	ops := policyReplacementOperations("ns", &sandboxpb.SandboxPolicy{})

	removeCount := 0
	addCount := 0
	for _, op := range ops {
		if op.GetRemoveRule() != nil {
			removeCount++
		}
		if op.GetAddRule() != nil {
			addCount++
		}
	}

	if removeCount != len(bakedInRuleNames) {
		t.Errorf("remove ops = %d, want %d", removeCount, len(bakedInRuleNames))
	}
	if addCount != 2 {
		t.Errorf("add ops (platform) = %d, want 2", addCount)
	}

	// Platform rules should be the last two operations
	acpOp := ops[len(ops)-2].GetAddRule()
	if acpOp == nil || acpOp.RuleName != acpInternalPolicyKey {
		t.Error("second-to-last op should be _acp_internal AddRule")
	}
	mlOp := ops[len(ops)-1].GetAddRule()
	if mlOp == nil || mlOp.RuleName != mlflowPolicyKey {
		t.Error("last op should be _mlflow_rh AddRule")
	}
}

func TestPolicyReplacementOperations_WithAgentRules(t *testing.T) {
	agentPolicy := &sandboxpb.SandboxPolicy{
		NetworkPolicies: map[string]*sandboxpb.NetworkPolicyRule{
			"custom_api": {
				Name: "custom-api",
				Endpoints: []*sandboxpb.NetworkEndpoint{
					{Host: "api.example.com", Port: 443},
				},
			},
		},
	}
	ops := policyReplacementOperations("ns", agentPolicy)

	removeCount := 0
	addCount := 0
	addNames := make(map[string]bool)
	for _, op := range ops {
		if r := op.GetRemoveRule(); r != nil {
			removeCount++
		}
		if a := op.GetAddRule(); a != nil {
			addCount++
			addNames[a.RuleName] = true
		}
	}

	if removeCount != len(bakedInRuleNames) {
		t.Errorf("remove ops = %d, want %d", removeCount, len(bakedInRuleNames))
	}
	// 1 agent rule + 2 platform rules
	if addCount != 3 {
		t.Errorf("add ops = %d, want 3", addCount)
	}
	if !addNames["custom_api"] {
		t.Error("agent rule 'custom_api' not found in add operations")
	}
	if !addNames[acpInternalPolicyKey] {
		t.Errorf("platform rule %q not found", acpInternalPolicyKey)
	}
	if !addNames[mlflowPolicyKey] {
		t.Errorf("platform rule %q not found", mlflowPolicyKey)
	}
}
