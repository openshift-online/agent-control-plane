package openshell

import (
	"encoding/json"
	"testing"

	sandboxpb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/sandbox/v1"
	pb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
)

func TestSandboxPhaseString(t *testing.T) {
	tests := []struct {
		phase pb.SandboxPhase
		want  string
	}{
		{pb.SandboxPhase_SANDBOX_PHASE_READY, "active"},
		{pb.SandboxPhase_SANDBOX_PHASE_PROVISIONING, "provisioning"},
		{pb.SandboxPhase_SANDBOX_PHASE_ERROR, "error"},
		{pb.SandboxPhase_SANDBOX_PHASE_DELETING, "deleting"},
		{pb.SandboxPhase(999), "unknown"},
	}
	for _, tt := range tests {
		t.Run(tt.want, func(t *testing.T) {
			got := SandboxPhaseString(tt.phase)
			if got != tt.want {
				t.Errorf("SandboxPhaseString(%v) = %q, want %q", tt.phase, got, tt.want)
			}
		})
	}
}

func TestPolicyToMap(t *testing.T) {
	policy := &sandboxpb.SandboxPolicy{Version: 3}
	m := PolicyToMap(policy)

	if v, ok := m["version"]; !ok {
		t.Fatal("missing 'version' key")
	} else if vf, ok := v.(float64); !ok || vf != 3 {
		t.Errorf("version = %v (%T), want 3 (float64)", v, v)
	}
}

func TestPolicyToMap_ZeroValue(t *testing.T) {
	policy := &sandboxpb.SandboxPolicy{}
	m := PolicyToMap(policy)
	if m == nil {
		t.Fatal("PolicyToMap returned nil for zero-value policy")
	}
}

func TestBuildSnapshotPatch(t *testing.T) {
	sbx := &pb.Sandbox{
		Spec: &pb.SandboxSpec{
			Policy: &sandboxpb.SandboxPolicy{Version: 5},
		},
		Status: &pb.SandboxStatus{
			Phase:                pb.SandboxPhase_SANDBOX_PHASE_READY,
			CurrentPolicyVersion: 2,
		},
	}

	patch, err := BuildSnapshotPatch(sbx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	raw, ok := patch["sandbox_policy_snapshot"]
	if !ok {
		t.Fatal("missing sandbox_policy_snapshot in patch")
	}

	var envelope map[string]interface{}
	if err := json.Unmarshal([]byte(raw.(string)), &envelope); err != nil {
		t.Fatalf("failed to unmarshal policy snapshot: %v", err)
	}

	checks := map[string]interface{}{
		"status":          "active",
		"source":          "gateway",
		"hash":            "",
		"config_revision": "2",
	}
	for key, want := range checks {
		got, ok := envelope[key]
		if !ok {
			t.Errorf("missing key %q in envelope", key)
		} else if got != want {
			t.Errorf("envelope[%q] = %v, want %v", key, got, want)
		}
	}

	if _, ok := envelope["policy"]; !ok {
		t.Error("missing 'policy' key in envelope")
	}
}

func TestBuildSnapshotPatch_NilSpec(t *testing.T) {
	sbx := &pb.Sandbox{}
	patch, err := BuildSnapshotPatch(sbx)
	if err != nil {
		t.Fatalf("unexpected error for nil spec: %v", err)
	}
	if _, ok := patch["sandbox_policy_snapshot"]; !ok {
		t.Fatal("missing sandbox_policy_snapshot even for nil spec")
	}
}
