package clusters

import (
	"testing"
	"time"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/api/openapi"
)

func TestConvertCluster(t *testing.T) {
	desc := "test cluster"
	credID := "cred-123"
	c := openapi.Cluster{
		Name:         "my-cluster",
		Description:  &desc,
		ApiServerUrl: "https://k8s.example.com:6443",
		CredentialId: &credID,
		Role:         "hybrid",
	}

	result := ConvertCluster(c)
	if result.Name != "my-cluster" {
		t.Errorf("expected name my-cluster, got %s", result.Name)
	}
	if result.ApiServerUrl != "https://k8s.example.com:6443" {
		t.Errorf("expected api_server_url, got %s", result.ApiServerUrl)
	}
	if *result.Description != "test cluster" {
		t.Errorf("expected description, got %v", result.Description)
	}
	if *result.CredentialId != "cred-123" {
		t.Errorf("expected credential_id, got %v", result.CredentialId)
	}
	if result.Role != "hybrid" {
		t.Errorf("expected role hybrid, got %s", result.Role)
	}
}

func TestPresentCluster(t *testing.T) {
	desc := "prod gateway"
	now := time.Now()
	c := &Cluster{
		Name:            "gw-cluster",
		Description:     &desc,
		ApiServerUrl:    "https://gw.example.com:6443",
		Role:            "gateway",
		Status:          "Ready",
		LastHeartbeatAt: &now,
	}
	c.ID = "cluster-123"
	c.CreatedAt = now
	c.UpdatedAt = now

	result := PresentCluster(c)
	if *result.Id != "cluster-123" {
		t.Errorf("expected id cluster-123, got %v", result.Id)
	}
	if result.Name != "gw-cluster" {
		t.Errorf("expected name gw-cluster, got %s", result.Name)
	}
	if *result.Status != "Ready" {
		t.Errorf("expected status Ready, got %v", result.Status)
	}
	if result.LastHeartbeatAt == nil {
		t.Error("expected last_heartbeat_at to be set")
	}
}

func TestPresentClusterStatus(t *testing.T) {
	msg := "all systems operational"
	cap := `{"cpu":"64","memory":"256Gi"}`
	now := time.Now()
	c := &Cluster{
		Status:          "Ready",
		StatusMessage:   &msg,
		Capacity:        &cap,
		LastHeartbeatAt: &now,
	}
	c.ID = "cluster-456"

	result := PresentClusterStatus(c)
	if *result.Id != "cluster-456" {
		t.Errorf("expected id, got %v", result.Id)
	}
	if *result.Status != "Ready" {
		t.Errorf("expected Ready, got %v", result.Status)
	}
	if *result.StatusMessage != msg {
		t.Errorf("expected status_message, got %v", result.StatusMessage)
	}
	if *result.Capacity != cap {
		t.Errorf("expected capacity, got %v", result.Capacity)
	}
}
