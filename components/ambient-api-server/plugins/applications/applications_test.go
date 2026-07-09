package applications

import (
	"context"
	"testing"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/api/openapi"
)

func TestConvertApplication_RequiredFields(t *testing.T) {
	input := openapi.Application{
		Name:               "fleet-prod",
		SourceRepoUrl:      "https://github.com/org/repo",
		SourcePath:         "agents/",
		DestinationProject: "prod",
	}

	result := ConvertApplication(input)

	if result.Name != "fleet-prod" {
		t.Errorf("Name = %q, want %q", result.Name, "fleet-prod")
	}
	if result.SourceRepoUrl != "https://github.com/org/repo" {
		t.Errorf("SourceRepoUrl = %q, want %q", result.SourceRepoUrl, "https://github.com/org/repo")
	}
	if result.SourcePath != "agents/" {
		t.Errorf("SourcePath = %q, want %q", result.SourcePath, "agents/")
	}
	if result.DestinationProject != "prod" {
		t.Errorf("DestinationProject = %q, want %q", result.DestinationProject, "prod")
	}
}

func TestConvertApplication_OptionalFields(t *testing.T) {
	revision := "main"
	ambientURL := "https://ambient.example.com"
	credID := "cred-123"
	autoSync := true
	autoPrune := false
	selfHeal := true
	retryLimit := int32(3)
	labels := `{"env":"prod"}`
	annotations := `{"note":"test"}`

	input := openapi.Application{
		Name:                  "fleet-prod",
		SourceRepoUrl:         "https://github.com/org/repo",
		SourcePath:            "agents/",
		DestinationProject:    "prod",
		SourceTargetRevision:  &revision,
		DestinationAmbientUrl: &ambientURL,
		CredentialId:          &credID,
		AutoSync:              &autoSync,
		AutoPrune:             &autoPrune,
		SelfHeal:              &selfHeal,
		RetryLimit:            &retryLimit,
		Labels:                &labels,
		Annotations:           &annotations,
	}

	result := ConvertApplication(input)

	if result.SourceTargetRevision == nil || *result.SourceTargetRevision != "main" {
		t.Errorf("SourceTargetRevision = %v, want %q", result.SourceTargetRevision, "main")
	}
	if result.DestinationAmbientUrl == nil || *result.DestinationAmbientUrl != ambientURL {
		t.Errorf("DestinationAmbientUrl = %v, want %q", result.DestinationAmbientUrl, ambientURL)
	}
	if result.CredentialId == nil || *result.CredentialId != "cred-123" {
		t.Errorf("CredentialId = %v, want %q", result.CredentialId, "cred-123")
	}
	if result.AutoSync == nil || *result.AutoSync != true {
		t.Errorf("AutoSync = %v, want true", result.AutoSync)
	}
	if result.AutoPrune == nil || *result.AutoPrune != false {
		t.Errorf("AutoPrune = %v, want false", result.AutoPrune)
	}
	if result.SelfHeal == nil || *result.SelfHeal != true {
		t.Errorf("SelfHeal = %v, want true", result.SelfHeal)
	}
	if result.RetryLimit == nil || *result.RetryLimit != 3 {
		t.Errorf("RetryLimit = %v, want 3", result.RetryLimit)
	}
}

func TestPresentApplication_Fields(t *testing.T) {
	syncStatus := "Synced"
	healthStatus := "Healthy"
	opPhase := "Succeeded"
	opMessage := "sync completed"

	app := &Application{
		Name:               "fleet-prod",
		SourceRepoUrl:      "https://github.com/org/repo",
		SourcePath:         "agents/",
		DestinationProject: "prod",
		SyncStatus:         &syncStatus,
		HealthStatus:       &healthStatus,
		OperationPhase:     &opPhase,
		OperationMessage:   &opMessage,
	}
	app.ID = "app-123"

	result := PresentApplication(app)

	if result.Name != "fleet-prod" {
		t.Errorf("Name = %q, want %q", result.Name, "fleet-prod")
	}
	if result.SourceRepoUrl != "https://github.com/org/repo" {
		t.Errorf("SourceRepoUrl = %q, want %q", result.SourceRepoUrl, "https://github.com/org/repo")
	}
	if result.SyncStatus == nil || *result.SyncStatus != "Synced" {
		t.Errorf("SyncStatus = %v, want Synced", result.SyncStatus)
	}
	if result.HealthStatus == nil || *result.HealthStatus != "Healthy" {
		t.Errorf("HealthStatus = %v, want Healthy", result.HealthStatus)
	}
	if result.OperationPhase == nil || *result.OperationPhase != "Succeeded" {
		t.Errorf("OperationPhase = %v, want Succeeded", result.OperationPhase)
	}
}

func TestPresentApplication_Roundtrip(t *testing.T) {
	revision := "v1.0"
	input := openapi.Application{
		Name:                 "test-app",
		SourceRepoUrl:        "https://github.com/test/repo",
		SourcePath:           "path/",
		DestinationProject:   "default",
		SourceTargetRevision: &revision,
	}

	model := ConvertApplication(input)
	model.ID = "roundtrip-id"
	output := PresentApplication(model)

	if output.Name != input.Name {
		t.Errorf("roundtrip Name: got %q, want %q", output.Name, input.Name)
	}
	if output.SourceRepoUrl != input.SourceRepoUrl {
		t.Errorf("roundtrip SourceRepoUrl: got %q, want %q", output.SourceRepoUrl, input.SourceRepoUrl)
	}
	if output.SourcePath != input.SourcePath {
		t.Errorf("roundtrip SourcePath: got %q, want %q", output.SourcePath, input.SourcePath)
	}
	if output.DestinationProject != input.DestinationProject {
		t.Errorf("roundtrip DestinationProject: got %q, want %q", output.DestinationProject, input.DestinationProject)
	}
	if output.SourceTargetRevision == nil || *output.SourceTargetRevision != revision {
		t.Errorf("roundtrip SourceTargetRevision: got %v, want %q", output.SourceTargetRevision, revision)
	}
}

func TestMockDao_CreateAndGet(t *testing.T) {
	dao := NewMockApplicationDao()

	app := &Application{
		Name:               "test-app",
		SourceRepoUrl:      "https://github.com/test/repo",
		SourcePath:         "agents/",
		DestinationProject: "default",
	}

	created, err := dao.Create(context.Background(), app)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if created.ID == "" {
		t.Fatal("expected ID to be assigned")
	}

	found, err := dao.Get(context.Background(), created.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if found.Name != "test-app" {
		t.Errorf("Name = %q, want %q", found.Name, "test-app")
	}
}

func TestMockDao_GetNotFound(t *testing.T) {
	dao := NewMockApplicationDao()

	_, err := dao.Get(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent ID")
	}
}

func TestMockDao_All(t *testing.T) {
	dao := NewMockApplicationDao()

	app1 := &Application{Name: "app-1", SourceRepoUrl: "https://github.com/a", SourcePath: "a/", DestinationProject: "default"}
	app2 := &Application{Name: "app-2", SourceRepoUrl: "https://github.com/b", SourcePath: "b/", DestinationProject: "default"}

	_, _ = dao.Create(context.Background(), app1)
	_, _ = dao.Create(context.Background(), app2)

	all, err := dao.All(context.Background())
	if err != nil {
		t.Fatalf("All: %v", err)
	}
	if len(all) != 2 {
		t.Errorf("expected 2 applications, got %d", len(all))
	}
}

func TestBeforeCreate_AssignsID(t *testing.T) {
	app := &Application{
		Name:               "test-app",
		SourceRepoUrl:      "https://github.com/test/repo",
		SourcePath:         "agents/",
		DestinationProject: "default",
	}

	if err := app.BeforeCreate(nil); err != nil {
		t.Fatalf("BeforeCreate: %v", err)
	}
	if app.ID == "" {
		t.Fatal("expected ID to be assigned")
	}
}
