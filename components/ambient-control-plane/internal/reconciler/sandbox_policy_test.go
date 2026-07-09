package reconciler

import (
	"strings"
	"testing"
)

func TestACPInternalMergeOperation(t *testing.T) {
	op := acpInternalMergeOperation("pr-42")
	addRule := op.GetAddRule()
	if addRule == nil {
		t.Fatal("expected AddRule operation")
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
}

func TestACPInternalMergeOperation_EndpointPorts(t *testing.T) {
	op := acpInternalMergeOperation("test-ns")
	rule := op.GetAddRule().Rule

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

func TestACPInternalMergeOperation_Binaries(t *testing.T) {
	op := acpInternalMergeOperation("ns")
	rule := op.GetAddRule().Rule

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
