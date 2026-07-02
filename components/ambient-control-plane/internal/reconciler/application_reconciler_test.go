package reconciler

import (
	"testing"

	"github.com/rs/zerolog"
)

func TestAppContentHash_Deterministic(t *testing.T) {
	decl := gitAgentDeclaration{
		Name:        "test-agent",
		Description: "a test agent",
		LlmModel:    "claude-sonnet-4-20250514",
	}

	hash1 := appContentHash(decl)
	hash2 := appContentHash(decl)

	if hash1 == "" {
		t.Fatal("expected non-empty hash")
	}
	if hash1 != hash2 {
		t.Errorf("hash is not deterministic: %q != %q", hash1, hash2)
	}
}

func TestAppContentHash_DifferentInputs(t *testing.T) {
	decl1 := gitAgentDeclaration{Name: "agent-a"}
	decl2 := gitAgentDeclaration{Name: "agent-b"}

	hash1 := appContentHash(decl1)
	hash2 := appContentHash(decl2)

	if hash1 == hash2 {
		t.Errorf("expected different hashes for different inputs, got %q", hash1)
	}
}

func TestAppContentHash_EmptyStruct(t *testing.T) {
	hash := appContentHash(gitAgentDeclaration{})
	if hash == "" {
		t.Fatal("expected non-empty hash even for empty struct")
	}
}

func TestNewApplicationReconciler(t *testing.T) {
	rec := NewApplicationReconciler(nil, zerolog.Nop())
	if rec == nil {
		t.Fatal("expected non-nil reconciler")
	}
}
