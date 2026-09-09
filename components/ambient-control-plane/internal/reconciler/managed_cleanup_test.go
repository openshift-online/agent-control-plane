package reconciler

import (
	"context"
	"fmt"
	datapb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/datamodel/v1"
	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	"reflect"
	"testing"
)

type cleanupGateway struct {
	calls []string
	fail  bool
}

func (g *cleanupGateway) ListProviders(_ context.Context, _ string, req *pb.ListProvidersRequest) (*pb.ListProvidersResponse, error) {
	g.calls = append(g.calls, fmt.Sprintf("list:%d", req.Offset))
	if req.Offset > 0 {
		return &pb.ListProvidersResponse{}, nil
	}
	result := &pb.ListProvidersResponse{}
	for i := 0; i < 100; i++ {
		session := "other"
		if i == 99 {
			session = "session"
		}
		result.Providers = append(result.Providers, &datapb.Provider{Metadata: &datapb.ObjectMeta{Name: fmt.Sprintf("provider-%d", i), Labels: map[string]string{managedProviderLabel: "true"}, Annotations: map[string]string{managedSessionAnnotation: session}}})
	}
	return result, nil
}
func (g *cleanupGateway) DeleteProvider(_ context.Context, _ string, name string) error {
	g.calls = append(g.calls, "delete:"+name)
	if g.fail {
		return fmt.Errorf("gateway unavailable")
	}
	return nil
}
func (g *cleanupGateway) ListProviderProfiles(context.Context, string, *pb.ListProviderProfilesRequest) (*pb.ListProviderProfilesResponse, error) {
	return &pb.ListProviderProfilesResponse{Profiles: []*pb.ProviderProfile{{Id: "owned", Scope: "workspace", Annotations: map[string]string{managedSessionAnnotation: "session"}}, {Id: "shared", Scope: "platform", Annotations: map[string]string{managedSessionAnnotation: "session"}}}}, nil
}
func (g *cleanupGateway) DeleteProviderProfile(_ context.Context, _ string, id string) error {
	g.calls = append(g.calls, "profile:"+id)
	return nil
}

func TestManagedCleanupPreservesUnownedProvidersAndReadsBeforeDelete(t *testing.T) {
	g := &cleanupGateway{}
	if err := cleanupManagedProviders(context.Background(), g, "target", "session"); err != nil {
		t.Fatal(err)
	}
	expected := []string{"list:0", "list:100", "delete:provider-99", "profile:owned"}
	if !reflect.DeepEqual(g.calls, expected) {
		t.Fatalf("cleanup calls=%v", g.calls)
	}
	g = &cleanupGateway{fail: true}
	if err := cleanupManagedProviders(context.Background(), g, "target", "session"); err == nil {
		t.Fatal("partial deletion failure was discarded")
	}
	if g.calls[len(g.calls)-1] != "delete:provider-99" {
		t.Fatal("deleted profile after provider failure")
	}
}
