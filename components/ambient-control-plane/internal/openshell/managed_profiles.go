package openshell

import (
	"context"
	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
)

func (g *GatewayClient) GetProviderProfile(ctx context.Context, key string, request *pb.GetProviderProfileRequest) (*pb.ProviderProfileResponse, error) {
	ctx = g.authContext(ctx, key)
	client, err := g.clientForNamespace(ctx, key)
	if err != nil {
		return nil, err
	}
	return client.GetProviderProfile(ctx, request)
}
func (g *GatewayClient) ImportProviderProfiles(ctx context.Context, key string, request *pb.ImportProviderProfilesRequest) (*pb.ImportProviderProfilesResponse, error) {
	ctx = g.authContext(ctx, key)
	client, err := g.clientForNamespace(ctx, key)
	if err != nil {
		return nil, err
	}
	return client.ImportProviderProfiles(ctx, request)
}
func (g *GatewayClient) UpdateProviderProfiles(ctx context.Context, key string, request *pb.UpdateProviderProfilesRequest) (*pb.UpdateProviderProfilesResponse, error) {
	ctx = g.authContext(ctx, key)
	client, err := g.clientForNamespace(ctx, key)
	if err != nil {
		return nil, err
	}
	return client.UpdateProviderProfiles(ctx, request)
}
