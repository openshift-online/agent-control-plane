package clusters

import (
	"context"
	"testing"
	"time"

	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/errors"
)

type mockEvents struct{}

func (m *mockEvents) Create(_ context.Context, event *api.Event) (*api.Event, *errors.ServiceError) {
	event.ID = api.NewID()
	return event, nil
}
func (m *mockEvents) Replace(_ context.Context, event *api.Event) (*api.Event, *errors.ServiceError) {
	return event, nil
}
func (m *mockEvents) Delete(_ context.Context, _ string) *errors.ServiceError { return nil }
func (m *mockEvents) All(_ context.Context) (api.EventList, *errors.ServiceError) {
	return api.EventList{}, nil
}
func (m *mockEvents) Get(_ context.Context, _ string) (*api.Event, *errors.ServiceError) {
	return &api.Event{}, nil
}
func (m *mockEvents) FindByIDs(_ context.Context, _ []string) (api.EventList, *errors.ServiceError) {
	return api.EventList{}, nil
}
func (m *mockEvents) FindUnreconciled(_ context.Context, _ time.Duration) (api.EventList, *errors.ServiceError) {
	return api.EventList{}, nil
}
func (m *mockEvents) FindBySourceAndType(_ context.Context, _ string, _ api.EventType) (api.EventList, *errors.ServiceError) {
	return api.EventList{}, nil
}

type mockSessionCounter struct {
	count int64
	err   error
}

func (m *mockSessionCounter) CountActiveSessionsOnCluster(ctx context.Context, clusterID string) (int64, error) {
	return m.count, m.err
}

func newTestService(counter *mockSessionCounter) (ClusterService, *clusterDaoMock) {
	dao := NewMockClusterDao()
	if counter == nil {
		counter = &mockSessionCounter{count: 0}
	}
	svc := NewClusterService(nil, dao, &mockEvents{}, counter)
	svc.(*sqlClusterService).lockFactory = nil
	DisableAdvisoryLock = true
	return svc, dao
}

func TestCreateCluster(t *testing.T) {
	svc, _ := newTestService(nil)

	c, err := svc.Create(context.Background(), &Cluster{
		Name:         "test-cluster",
		ApiServerUrl: "https://k8s.example.com:6443",
		Role:         "hybrid",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.ID == "" {
		t.Error("expected ID to be set")
	}
	if c.Status != "Unknown" {
		t.Errorf("expected status Unknown, got %s", c.Status)
	}
	if c.Role != "hybrid" {
		t.Errorf("expected role hybrid, got %s", c.Role)
	}
}

func TestCreateClusterInvalidRole(t *testing.T) {
	svc, _ := newTestService(nil)

	_, err := svc.Create(context.Background(), &Cluster{
		Name:         "bad-cluster",
		ApiServerUrl: "https://k8s.example.com:6443",
		Role:         "invalid",
	})
	if err == nil {
		t.Fatal("expected validation error for invalid role")
	}
}

func TestGetCluster(t *testing.T) {
	svc, _ := newTestService(nil)

	created, _ := svc.Create(context.Background(), &Cluster{
		Name:         "get-test",
		ApiServerUrl: "https://k8s.example.com:6443",
		Role:         "gateway",
	})

	found, err := svc.Get(context.Background(), created.ID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if found.Name != "get-test" {
		t.Errorf("expected name get-test, got %s", found.Name)
	}
}

func TestGetClusterNotFound(t *testing.T) {
	svc, _ := newTestService(nil)

	_, err := svc.Get(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent cluster")
	}
}

func TestDeleteCluster(t *testing.T) {
	svc, _ := newTestService(nil)

	created, _ := svc.Create(context.Background(), &Cluster{
		Name:         "delete-test",
		ApiServerUrl: "https://k8s.example.com:6443",
		Role:         "workload",
	})

	err := svc.Delete(context.Background(), created.ID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	_, getErr := svc.Get(context.Background(), created.ID)
	if getErr == nil {
		t.Fatal("expected error after delete")
	}
}

func TestDeleteClusterBlockedByActiveSessions(t *testing.T) {
	counter := &mockSessionCounter{count: 3}
	svc, _ := newTestService(counter)

	created, _ := svc.Create(context.Background(), &Cluster{
		Name:         "busy-cluster",
		ApiServerUrl: "https://k8s.example.com:6443",
		Role:         "hybrid",
	})

	err := svc.Delete(context.Background(), created.ID)
	if err == nil {
		t.Fatal("expected conflict error when active sessions exist")
		return
	}
	if err.HttpCode != 409 {
		t.Errorf("expected 409 conflict, got %d", err.HttpCode)
	}
}

func TestReplaceCluster(t *testing.T) {
	svc, _ := newTestService(nil)

	created, _ := svc.Create(context.Background(), &Cluster{
		Name:         "update-test",
		ApiServerUrl: "https://k8s.example.com:6443",
		Role:         "hybrid",
	})

	created.Role = "gateway"
	updated, err := svc.Replace(context.Background(), created)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Role != "gateway" {
		t.Errorf("expected role gateway, got %s", updated.Role)
	}
}

func TestAllClusters(t *testing.T) {
	svc, _ := newTestService(nil)

	if _, err := svc.Create(context.Background(), &Cluster{
		Name: "c1", ApiServerUrl: "https://a:6443", Role: "hybrid",
	}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, err := svc.Create(context.Background(), &Cluster{
		Name: "c2", ApiServerUrl: "https://b:6443", Role: "gateway",
	}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	all, err := svc.All(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(all) != 2 {
		t.Errorf("expected 2 clusters, got %d", len(all))
	}
}
