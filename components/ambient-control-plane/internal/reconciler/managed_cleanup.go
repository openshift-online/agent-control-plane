package reconciler

import (
	"context"
	"fmt"
	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type managedCleanupGateway interface {
	ListProviders(context.Context, string, *pb.ListProvidersRequest) (*pb.ListProvidersResponse, error)
	DeleteProvider(context.Context, string, string) error
	ListProviderProfiles(context.Context, string, *pb.ListProviderProfilesRequest) (*pb.ListProviderProfilesResponse, error)
	DeleteProviderProfile(context.Context, string, string) error
}

// Remove only resources owned by this session. Read all pages before deletion,
// so deleting an item cannot move another item behind the pagination offset.
func cleanupManagedProviders(ctx context.Context, gateway managedCleanupGateway, target, sessionID string) error {
	var providers, profiles []string
	for offset := uint32(0); ; offset += 100 {
		response, err := gateway.ListProviders(ctx, target, &pb.ListProvidersRequest{Limit: 100, Offset: offset})
		if status.Code(err) == codes.NotFound {
			return nil
		}
		if err != nil {
			return fmt.Errorf("list providers for cleanup: %w", err)
		}
		for _, item := range response.GetProviders() {
			meta := item.GetMetadata()
			if meta.GetLabels()[managedProviderLabel] == "true" && meta.GetAnnotations()[managedSessionAnnotation] == sessionID {
				providers = append(providers, meta.GetName())
			}
		}
		if len(response.GetProviders()) < 100 {
			break
		}
	}
	for offset := uint32(0); ; offset += 100 {
		response, err := gateway.ListProviderProfiles(ctx, target, &pb.ListProviderProfilesRequest{Limit: 100, Offset: offset})
		if err != nil {
			return fmt.Errorf("list provider profiles for cleanup: %w", err)
		}
		for _, item := range response.GetProfiles() {
			if item.GetScope() == "workspace" && item.GetAnnotations()[managedSessionAnnotation] == sessionID {
				profiles = append(profiles, item.GetId())
			}
		}
		if len(response.GetProfiles()) < 100 {
			break
		}
	}
	for _, name := range providers {
		if err := gateway.DeleteProvider(ctx, target, name); err != nil && status.Code(err) != codes.NotFound {
			return fmt.Errorf("delete session provider: %w", err)
		}
	}
	for _, id := range profiles {
		if err := gateway.DeleteProviderProfile(ctx, target, id); err != nil && status.Code(err) != codes.NotFound {
			return fmt.Errorf("delete session provider profile: %w", err)
		}
	}
	return nil
}
