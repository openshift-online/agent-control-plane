package openshell

import (
	"context"

	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
)

// GetSandboxPolicyStatus reads the latest authored revision. GetSandboxConfig
// returns an effective policy with provider rules and is unsuitable for edits.
func (g *GatewayClient) GetSandboxPolicyStatus(ctx context.Context, key, name string) (*pb.GetSandboxPolicyStatusResponse, error) {
	ctx = g.authContext(ctx, key)
	client, err := g.clientForNamespace(ctx, key)
	if err != nil {
		return nil, err
	}
	return client.GetSandboxPolicyStatus(ctx, &pb.GetSandboxPolicyStatusRequest{Name: name})
}
