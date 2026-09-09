package openshell

import (
	"context"
	"testing"
	"time"

	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (s *managedTestServer) GetSandboxPolicyStatus(ctx context.Context, req *pb.GetSandboxPolicyStatusRequest) (*pb.GetSandboxPolicyStatusResponse, error) {
	if req.Global || req.Version != 0 || req.Name != "same-sandbox" {
		return nil, status.Error(codes.InvalidArgument, "expected latest sandbox-scoped authored policy")
	}
	if err := s.record(ctx, "policy", req.Workspace); err != nil {
		return nil, err
	}
	return &pb.GetSandboxPolicyStatusResponse{}, nil
}

func TestManagedAuthoredPolicyUsesTargetWorkspaceAndCredential(t *testing.T) {
	client, server, _, _ := managedTestClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, name := range []string{"a", "b"} {
		if _, err := client.GetSandboxPolicyStatus(ctx, TargetKey(testGatewayPrefix+name, "session-"+name), "same-sandbox"); err != nil {
			t.Fatal(err)
		}
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	expected := []string{"policy|session-a|Bearer gateway-a-token", "policy|session-b|Bearer gateway-b-token"}
	if len(server.calls) != len(expected) {
		t.Fatalf("received %d calls", len(server.calls))
	}
	for i, call := range expected {
		if server.calls[i] != call {
			t.Fatalf("call %d = %q, want %q", i, server.calls[i], call)
		}
	}
}
