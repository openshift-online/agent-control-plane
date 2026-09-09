package openshell

import (
	"context"
	"fmt"

	datamodelpb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/datamodel/v1"
	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (g *GatewayClient) validateWorkspaceName(key, name string) error {
	if name == "" {
		return fmt.Errorf("workspace name is required")
	}
	if g.targetResolver != nil {
		_, workspace, err := ParseTargetKey(key)
		if err != nil {
			return err
		}
		if workspace != name {
			return fmt.Errorf("workspace name does not match the gateway target")
		}
	}
	return nil
}

// EnsureWorkspace creates a missing workspace and verifies its active state.
// OpenShell requires the workspace before sandbox or provider creation.
func (g *GatewayClient) EnsureWorkspace(ctx context.Context, key, name string) error {
	if err := g.validateWorkspaceName(key, name); err != nil {
		return err
	}
	ctx = g.authContext(ctx, key)
	client, err := g.clientForNamespace(ctx, key)
	if err != nil {
		return err
	}
	response, err := client.GetWorkspace(ctx, &pb.GetWorkspaceRequest{Name: name})
	if status.Code(err) == codes.NotFound {
		_, createErr := client.CreateWorkspace(ctx, &pb.CreateWorkspaceRequest{Name: name})
		if createErr != nil && status.Code(createErr) != codes.AlreadyExists {
			return createErr
		}
		response, err = client.GetWorkspace(ctx, &pb.GetWorkspaceRequest{Name: name})
	}
	if err != nil {
		return err
	}
	if response.GetWorkspace().GetStatus().GetPhase() != datamodelpb.WorkspacePhase_WORKSPACE_PHASE_ACTIVE {
		return fmt.Errorf("workspace is not active")
	}
	return nil
}

func (g *GatewayClient) DeleteWorkspace(ctx context.Context, key, name string) error {
	if err := g.validateWorkspaceName(key, name); err != nil {
		return err
	}
	ctx = g.authContext(ctx, key)
	client, err := g.clientForNamespace(ctx, key)
	if err != nil {
		return err
	}
	_, err = client.DeleteWorkspace(ctx, &pb.DeleteWorkspaceRequest{Name: name})
	if status.Code(err) == codes.NotFound {
		return nil
	}
	return err
}

func (g *GatewayClient) DeleteProvider(ctx context.Context, key, name string) error {
	ctx = g.authContext(ctx, key)
	client, err := g.clientForNamespace(ctx, key)
	if err != nil {
		return err
	}
	_, err = client.DeleteProvider(ctx, &pb.DeleteProviderRequest{Name: name})
	if status.Code(err) == codes.NotFound {
		return nil
	}
	return err
}

func (g *GatewayClient) StopSandbox(ctx context.Context, key, name string) (*pb.SandboxResponse, error) {
	ctx = g.authContext(ctx, key)
	client, err := g.clientForNamespace(ctx, key)
	if err != nil {
		return nil, err
	}
	return client.StopSandbox(ctx, &pb.StopSandboxRequest{Name: name})
}

func (g *GatewayClient) StartSandbox(ctx context.Context, key, name string) (*pb.SandboxResponse, error) {
	ctx = g.authContext(ctx, key)
	client, err := g.clientForNamespace(ctx, key)
	if err != nil {
		return nil, err
	}
	return client.StartSandbox(ctx, &pb.StartSandboxRequest{Name: name})
}

func (g *GatewayClient) ListProviders(ctx context.Context, key string, req *pb.ListProvidersRequest) (*pb.ListProvidersResponse, error) {
	ctx = g.authContext(ctx, key)
	client, err := g.clientForNamespace(ctx, key)
	if err != nil {
		return nil, err
	}
	return client.ListProviders(ctx, req)
}
func (g *GatewayClient) ListSandboxProviders(ctx context.Context, key string, req *pb.ListSandboxProvidersRequest) (*pb.ListSandboxProvidersResponse, error) {
	ctx = g.authContext(ctx, key)
	client, err := g.clientForNamespace(ctx, key)
	if err != nil {
		return nil, err
	}
	return client.ListSandboxProviders(ctx, req)
}
func (g *GatewayClient) AttachSandboxProvider(ctx context.Context, key string, req *pb.AttachSandboxProviderRequest) (*pb.AttachSandboxProviderResponse, error) {
	ctx = g.authContext(ctx, key)
	client, err := g.clientForNamespace(ctx, key)
	if err != nil {
		return nil, err
	}
	return client.AttachSandboxProvider(ctx, req)
}
func (g *GatewayClient) DetachSandboxProvider(ctx context.Context, key string, req *pb.DetachSandboxProviderRequest) (*pb.DetachSandboxProviderResponse, error) {
	ctx = g.authContext(ctx, key)
	client, err := g.clientForNamespace(ctx, key)
	if err != nil {
		return nil, err
	}
	return client.DetachSandboxProvider(ctx, req)
}

func (g *GatewayClient) ListProviderProfiles(ctx context.Context, key string, req *pb.ListProviderProfilesRequest) (*pb.ListProviderProfilesResponse, error) {
	ctx = g.authContext(ctx, key)
	client, err := g.clientForNamespace(ctx, key)
	if err != nil {
		return nil, err
	}
	return client.ListProviderProfiles(ctx, req)
}

func (g *GatewayClient) DeleteProviderProfile(ctx context.Context, key, id string) error {
	ctx = g.authContext(ctx, key)
	client, err := g.clientForNamespace(ctx, key)
	if err != nil {
		return err
	}
	_, err = client.DeleteProviderProfile(ctx, &pb.DeleteProviderProfileRequest{Id: id})
	if status.Code(err) == codes.NotFound {
		return nil
	}
	return err
}
