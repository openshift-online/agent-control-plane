package types

import (
	"encoding/json"
	"testing"
)

func TestPolicyMarshalJSON_SpecAsObject(t *testing.T) {
	p := Policy{
		Name:      "test",
		ProjectID: "proj-1",
		Spec:      `{"version":1,"filesystem_policy":{"include_workdir":true}}`,
	}

	data, err := json.Marshal(&p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("unmarshal raw: %v", err)
	}

	spec := raw["spec"]
	if len(spec) == 0 {
		t.Fatal("spec missing from marshaled output")
	}
	if spec[0] == '"' {
		t.Fatalf("spec was serialized as a JSON string (double-encoded), got: %s", spec)
	}

	var obj map[string]any
	if err := json.Unmarshal(spec, &obj); err != nil {
		t.Fatalf("spec is not a valid JSON object: %v (got: %s)", err, spec)
	}
	if obj["version"] != float64(1) {
		t.Errorf("expected version=1, got %v", obj["version"])
	}
}

func TestPolicyMarshalJSON_EmptySpec(t *testing.T) {
	p := Policy{
		Name:      "test",
		ProjectID: "proj-1",
	}

	data, err := json.Marshal(&p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("unmarshal raw: %v", err)
	}

	if _, ok := raw["spec"]; ok {
		t.Fatal("empty spec should be omitted")
	}
}

func TestPolicyRoundTrip(t *testing.T) {
	original := Policy{
		Name:      "permissive",
		ProjectID: "proj-1",
		Spec:      `{"version":1,"network_policies":{"egress":{"allow":true}}}`,
	}

	data, err := json.Marshal(&original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded Policy
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.Name != original.Name {
		t.Errorf("name: got %q, want %q", decoded.Name, original.Name)
	}
	if decoded.Spec != original.Spec {
		t.Errorf("spec: got %q, want %q", decoded.Spec, original.Spec)
	}
}

func TestPolicyPatchSpec_SetsObject(t *testing.T) {
	b := NewPolicyPatchBuilder()
	PolicyPatchSpec(b, `{"version":1}`)
	patch := b.Build()

	data, err := json.Marshal(patch)
	if err != nil {
		t.Fatalf("marshal patch: %v", err)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	spec := raw["spec"]
	if spec[0] == '"' {
		t.Fatalf("patch spec serialized as string, got: %s", spec)
	}
}
