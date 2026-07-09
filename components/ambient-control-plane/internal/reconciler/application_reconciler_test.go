package reconciler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	sdkclient "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/client"
	"github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
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

type mockGitFetcher struct {
	declarations []gitAgentDeclaration
	revision     string
	err          error
}

func (m *mockGitFetcher) FetchDeclarations(repoURL, path, targetRevision string) ([]gitAgentDeclaration, string, error) {
	if m.err != nil {
		return nil, "", m.err
	}
	return m.declarations, m.revision, nil
}

type appMockAPIServer struct {
	mu            sync.Mutex
	agents        map[string]types.Agent
	applications  []types.Application
	patchedApps   map[string]map[string]interface{}
	createdAgents []types.Agent
	updatedAgents map[string]map[string]interface{}
	deletedAgents []string
	nextAgentID   int
}

func newAppMockAPIServer() *appMockAPIServer {
	return &appMockAPIServer{
		agents:        make(map[string]types.Agent),
		patchedApps:   make(map[string]map[string]interface{}),
		updatedAgents: make(map[string]map[string]interface{}),
		nextAgentID:   1,
	}
}

func (m *appMockAPIServer) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		m.mu.Lock()
		defer m.mu.Unlock()

		if r.URL.Path == "/api/ambient/v1/applications" && r.Method == http.MethodGet {
			m.handleListApplications(w, r)
			return
		}

		if strings.HasPrefix(r.URL.Path, "/api/ambient/v1/applications/") && r.Method == http.MethodPatch {
			m.handlePatchApplication(w, r)
			return
		}

		if strings.HasPrefix(r.URL.Path, "/api/ambient/v1/projects/") {
			parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/ambient/v1/projects/"), "/")
			if len(parts) >= 2 && parts[1] == "agents" {
				switch {
				case r.Method == http.MethodGet && len(parts) == 2:
					m.handleListAgents(w, r)
					return
				case r.Method == http.MethodPost && len(parts) == 2:
					m.handleCreateAgent(w, r)
					return
				case r.Method == http.MethodPatch && len(parts) == 3:
					m.handlePatchAgent(w, r, parts[2])
					return
				case r.Method == http.MethodDelete && len(parts) == 3:
					m.handleDeleteAgent(w, r, parts[2])
					return
				}
			}
		}

		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "not found", "path": r.URL.Path, "method": r.Method})
	})
}

func (m *appMockAPIServer) handleListApplications(w http.ResponseWriter, r *http.Request) {
	page := r.URL.Query().Get("page")
	items := m.applications
	if page != "" && page != "1" {
		items = nil
	}
	resp := map[string]interface{}{
		"kind":  "ApplicationList",
		"page":  1,
		"size":  len(items),
		"total": len(m.applications),
		"items": items,
	}
	json.NewEncoder(w).Encode(resp)
}

func (m *appMockAPIServer) handlePatchApplication(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(r.URL.Path, "/")
	appID := parts[len(parts)-1]
	var patch map[string]interface{}
	json.NewDecoder(r.Body).Decode(&patch)
	m.patchedApps[appID] = patch
	resp := map[string]interface{}{"id": appID, "kind": "Application"}
	json.NewEncoder(w).Encode(resp)
}

func (m *appMockAPIServer) handleListAgents(w http.ResponseWriter, _ *http.Request) {
	var items []types.Agent
	for _, a := range m.agents {
		items = append(items, a)
	}
	resp := map[string]interface{}{
		"kind":  "AgentList",
		"page":  1,
		"size":  len(items),
		"total": len(items),
		"items": items,
	}
	json.NewEncoder(w).Encode(resp)
}

func (m *appMockAPIServer) handleCreateAgent(w http.ResponseWriter, r *http.Request) {
	var agent types.Agent
	json.NewDecoder(r.Body).Decode(&agent)
	agent.ID = fmt.Sprintf("agent-%d", m.nextAgentID)
	m.nextAgentID++
	now := time.Now()
	agent.CreatedAt = &now
	m.agents[agent.ID] = agent
	m.createdAgents = append(m.createdAgents, agent)
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(agent)
}

func (m *appMockAPIServer) handlePatchAgent(w http.ResponseWriter, r *http.Request, agentID string) {
	var patch map[string]interface{}
	json.NewDecoder(r.Body).Decode(&patch)
	m.updatedAgents[agentID] = patch
	agent, exists := m.agents[agentID]
	if !exists {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if name, ok := patch["description"].(string); ok {
		agent.Description = name
	}
	m.agents[agentID] = agent
	json.NewEncoder(w).Encode(agent)
}

func (m *appMockAPIServer) handleDeleteAgent(w http.ResponseWriter, _ *http.Request, agentID string) {
	if _, exists := m.agents[agentID]; !exists {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	delete(m.agents, agentID)
	m.deletedAgents = append(m.deletedAgents, agentID)
	w.WriteHeader(http.StatusNoContent)
}

func newAppSDKClient(t *testing.T, serverURL, project string) *sdkclient.Client {
	t.Helper()
	c, err := sdkclient.NewClient(serverURL, "test-token-must-be-at-least-20-chars-long", project)
	if err != nil {
		t.Fatalf("failed to create SDK client: %v", err)
	}
	return c
}

func newTestAppReconciler(t *testing.T, serverURL string, fetcher GitFetcher) *ApplicationReconciler {
	t.Helper()
	logger := zerolog.New(zerolog.NewTestWriter(t))
	factory := newTestSDKClientFactory(serverURL)
	rec := NewApplicationReconciler(factory, logger)
	rec.gitFetcher = fetcher
	return rec
}

func newTestSDKClientFactory(serverURL string) *SDKClientFactory {
	return NewSDKClientFactory(
		serverURL,
		&staticTestTokenProvider{},
		zerolog.Nop(),
	)
}

type staticTestTokenProvider struct{}

func (s *staticTestTokenProvider) Token(_ context.Context) (string, error) {
	return "test-token-must-be-at-least-20-chars-long", nil
}

// --- fetchDeclarations tests ---

func TestFetchDeclarations_ReturnsMockDeclarations(t *testing.T) {
	fetcher := &mockGitFetcher{
		declarations: []gitAgentDeclaration{
			{Name: "agent-alpha", Prompt: "do alpha things", LlmModel: "claude-sonnet-4-20250514"},
			{Name: "agent-beta", Description: "beta agent"},
		},
		revision: "abc123",
	}

	mock := newAppMockAPIServer()
	server := httptest.NewServer(mock.handler())
	defer server.Close()

	rec := newTestAppReconciler(t, server.URL, fetcher)

	app := &types.Application{
		ObjectReference:      types.ObjectReference{ID: "app-1"},
		Name:                 "test-app",
		SourceRepoURL:        "https://github.com/org/repo.git",
		SourcePath:           "agents/",
		SourceTargetRevision: "main",
	}

	declarations, revision, err := rec.fetchDeclarations(app)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if revision != "abc123" {
		t.Errorf("expected revision abc123, got %s", revision)
	}
	if len(declarations) != 2 {
		t.Fatalf("expected 2 declarations, got %d", len(declarations))
	}
	if declarations[0].Name != "agent-alpha" {
		t.Errorf("expected agent-alpha, got %s", declarations[0].Name)
	}
	if declarations[1].Name != "agent-beta" {
		t.Errorf("expected agent-beta, got %s", declarations[1].Name)
	}
}

func TestFetchDeclarations_PropagatesFetcherError(t *testing.T) {
	fetcher := &mockGitFetcher{
		err: fmt.Errorf("git clone failed: repository not found"),
	}

	mock := newAppMockAPIServer()
	server := httptest.NewServer(mock.handler())
	defer server.Close()

	rec := newTestAppReconciler(t, server.URL, fetcher)

	app := &types.Application{
		ObjectReference: types.ObjectReference{ID: "app-err"},
		SourceRepoURL:   "https://github.com/org/missing.git",
		SourcePath:      "agents/",
	}

	_, _, err := rec.fetchDeclarations(app)
	if err == nil {
		t.Fatal("expected error from fetcher, got nil")
	}
	if !strings.Contains(err.Error(), "repository not found") {
		t.Errorf("expected error to contain 'repository not found', got: %v", err)
	}
}

func TestFetchDeclarations_EmptyDeclarationsIsValid(t *testing.T) {
	fetcher := &mockGitFetcher{
		declarations: nil,
		revision:     "def456",
	}

	mock := newAppMockAPIServer()
	server := httptest.NewServer(mock.handler())
	defer server.Close()

	rec := newTestAppReconciler(t, server.URL, fetcher)

	app := &types.Application{
		ObjectReference: types.ObjectReference{ID: "app-empty"},
		SourceRepoURL:   "https://github.com/org/empty.git",
		SourcePath:      "agents/",
	}

	declarations, revision, err := rec.fetchDeclarations(app)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if revision != "def456" {
		t.Errorf("expected revision def456, got %s", revision)
	}
	if len(declarations) != 0 {
		t.Errorf("expected 0 declarations, got %d", len(declarations))
	}
}

// --- applyDeclarations tests ---

func TestApplyDeclarations_CreatesNewAgents(t *testing.T) {
	mock := newAppMockAPIServer()
	server := httptest.NewServer(mock.handler())
	defer server.Close()

	rec := newTestAppReconciler(t, server.URL, &mockGitFetcher{})

	app := &types.Application{
		ObjectReference:    types.ObjectReference{ID: "app-create"},
		Name:               "create-test",
		DestinationProject: "test-project",
	}

	declarations := []gitAgentDeclaration{
		{Name: "new-agent-1", Prompt: "do stuff", LlmModel: "claude-sonnet-4-20250514"},
		{Name: "new-agent-2", Description: "second agent"},
	}

	err := rec.applyDeclarations(context.Background(), app, declarations)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	mock.mu.Lock()
	defer mock.mu.Unlock()

	if len(mock.createdAgents) != 2 {
		t.Fatalf("expected 2 created agents, got %d", len(mock.createdAgents))
	}
	if mock.createdAgents[0].Name != "new-agent-1" {
		t.Errorf("expected new-agent-1, got %s", mock.createdAgents[0].Name)
	}
	if mock.createdAgents[1].Name != "new-agent-2" {
		t.Errorf("expected new-agent-2, got %s", mock.createdAgents[1].Name)
	}
}

func TestApplyDeclarations_UpdatesChangedAgents(t *testing.T) {
	mock := newAppMockAPIServer()

	existingAnnotations, _ := json.Marshal(map[string]string{
		annotationSource:      "application",
		annotationContentHash: appContentHash(gitAgentDeclaration{Name: "existing-agent", Prompt: "old prompt"}),
	})
	mock.agents["agent-existing"] = types.Agent{
		ObjectReference: types.ObjectReference{ID: "agent-existing"},
		Name:            "existing-agent",
		ProjectID:       "test-project",
		Prompt:          "old prompt",
		Annotations:     string(existingAnnotations),
	}

	server := httptest.NewServer(mock.handler())
	defer server.Close()

	rec := newTestAppReconciler(t, server.URL, &mockGitFetcher{})

	app := &types.Application{
		ObjectReference:    types.ObjectReference{ID: "app-update"},
		Name:               "update-test",
		DestinationProject: "test-project",
	}

	declarations := []gitAgentDeclaration{
		{Name: "existing-agent", Prompt: "new prompt"},
	}

	err := rec.applyDeclarations(context.Background(), app, declarations)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	mock.mu.Lock()
	defer mock.mu.Unlock()

	if len(mock.createdAgents) != 0 {
		t.Errorf("expected 0 created agents (should update), got %d", len(mock.createdAgents))
	}
	if len(mock.updatedAgents) != 1 {
		t.Fatalf("expected 1 updated agent, got %d", len(mock.updatedAgents))
	}
	if _, ok := mock.updatedAgents["agent-existing"]; !ok {
		t.Error("expected agent-existing to be updated")
	}
}

func TestApplyDeclarations_SkipsUnchangedAgents(t *testing.T) {
	mock := newAppMockAPIServer()

	decl := gitAgentDeclaration{Name: "unchanged-agent", Prompt: "same prompt"}
	existingAnnotations, _ := json.Marshal(map[string]string{
		annotationSource:      "application",
		annotationContentHash: appContentHash(decl),
	})
	mock.agents["agent-unchanged"] = types.Agent{
		ObjectReference: types.ObjectReference{ID: "agent-unchanged"},
		Name:            "unchanged-agent",
		ProjectID:       "test-project",
		Prompt:          "same prompt",
		Annotations:     string(existingAnnotations),
	}

	server := httptest.NewServer(mock.handler())
	defer server.Close()

	rec := newTestAppReconciler(t, server.URL, &mockGitFetcher{})

	app := &types.Application{
		ObjectReference:    types.ObjectReference{ID: "app-skip"},
		Name:               "skip-test",
		DestinationProject: "test-project",
	}

	err := rec.applyDeclarations(context.Background(), app, []gitAgentDeclaration{decl})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	mock.mu.Lock()
	defer mock.mu.Unlock()

	if len(mock.createdAgents) != 0 {
		t.Errorf("expected 0 created agents, got %d", len(mock.createdAgents))
	}
	if len(mock.updatedAgents) != 0 {
		t.Errorf("expected 0 updated agents (unchanged), got %d", len(mock.updatedAgents))
	}
}

func TestApplyDeclarations_PrunesRemovedAgents(t *testing.T) {
	mock := newAppMockAPIServer()

	pruneAnnotations, _ := json.Marshal(map[string]string{
		annotationSource: "application",
	})
	mock.agents["agent-stale"] = types.Agent{
		ObjectReference: types.ObjectReference{ID: "agent-stale"},
		Name:            "stale-agent",
		ProjectID:       "test-project",
		Annotations:     string(pruneAnnotations),
	}

	server := httptest.NewServer(mock.handler())
	defer server.Close()

	rec := newTestAppReconciler(t, server.URL, &mockGitFetcher{})

	app := &types.Application{
		ObjectReference:    types.ObjectReference{ID: "app-prune"},
		Name:               "prune-test",
		DestinationProject: "test-project",
		AutoPrune:          true,
	}

	err := rec.applyDeclarations(context.Background(), app, []gitAgentDeclaration{
		{Name: "kept-agent", Prompt: "keep me"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	mock.mu.Lock()
	defer mock.mu.Unlock()

	if len(mock.deletedAgents) != 1 {
		t.Fatalf("expected 1 deleted agent, got %d", len(mock.deletedAgents))
	}
	if mock.deletedAgents[0] != "agent-stale" {
		t.Errorf("expected agent-stale to be deleted, got %s", mock.deletedAgents[0])
	}
}

func TestApplyDeclarations_NoPruneWhenAutoFalse(t *testing.T) {
	mock := newAppMockAPIServer()

	pruneAnnotations, _ := json.Marshal(map[string]string{
		annotationSource: "application",
	})
	mock.agents["agent-stale"] = types.Agent{
		ObjectReference: types.ObjectReference{ID: "agent-stale"},
		Name:            "stale-agent",
		ProjectID:       "test-project",
		Annotations:     string(pruneAnnotations),
	}

	server := httptest.NewServer(mock.handler())
	defer server.Close()

	rec := newTestAppReconciler(t, server.URL, &mockGitFetcher{})

	app := &types.Application{
		ObjectReference:    types.ObjectReference{ID: "app-no-prune"},
		Name:               "no-prune-test",
		DestinationProject: "test-project",
		AutoPrune:          false,
	}

	err := rec.applyDeclarations(context.Background(), app, []gitAgentDeclaration{
		{Name: "kept-agent", Prompt: "keep me"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	mock.mu.Lock()
	defer mock.mu.Unlock()

	if len(mock.deletedAgents) != 0 {
		t.Errorf("expected 0 deleted agents when AutoPrune=false, got %d", len(mock.deletedAgents))
	}
}

func TestApplyDeclarations_EmptyDeclarationsNoOp(t *testing.T) {
	mock := newAppMockAPIServer()
	server := httptest.NewServer(mock.handler())
	defer server.Close()

	rec := newTestAppReconciler(t, server.URL, &mockGitFetcher{})

	app := &types.Application{
		ObjectReference:    types.ObjectReference{ID: "app-noop"},
		DestinationProject: "test-project",
	}

	err := rec.applyDeclarations(context.Background(), app, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	mock.mu.Lock()
	defer mock.mu.Unlock()

	if len(mock.createdAgents) != 0 || len(mock.updatedAgents) != 0 || len(mock.deletedAgents) != 0 {
		t.Error("expected no API calls for empty declarations")
	}
}

func TestApplyDeclarations_MixedCreateUpdateSkip(t *testing.T) {
	mock := newAppMockAPIServer()

	unchangedDecl := gitAgentDeclaration{Name: "unchanged", Prompt: "same"}
	unchangedAnnotations, _ := json.Marshal(map[string]string{
		annotationSource:      "application",
		annotationContentHash: appContentHash(unchangedDecl),
	})
	mock.agents["agent-unchanged"] = types.Agent{
		ObjectReference: types.ObjectReference{ID: "agent-unchanged"},
		Name:            "unchanged",
		ProjectID:       "dest-project",
		Annotations:     string(unchangedAnnotations),
	}

	changedAnnotations, _ := json.Marshal(map[string]string{
		annotationSource:      "application",
		annotationContentHash: appContentHash(gitAgentDeclaration{Name: "changed", Prompt: "old"}),
	})
	mock.agents["agent-changed"] = types.Agent{
		ObjectReference: types.ObjectReference{ID: "agent-changed"},
		Name:            "changed",
		ProjectID:       "dest-project",
		Annotations:     string(changedAnnotations),
	}

	server := httptest.NewServer(mock.handler())
	defer server.Close()

	rec := newTestAppReconciler(t, server.URL, &mockGitFetcher{})

	app := &types.Application{
		ObjectReference:    types.ObjectReference{ID: "app-mixed"},
		DestinationProject: "dest-project",
	}

	declarations := []gitAgentDeclaration{
		unchangedDecl,
		{Name: "changed", Prompt: "new"},
		{Name: "brand-new", Description: "totally new"},
	}

	err := rec.applyDeclarations(context.Background(), app, declarations)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	mock.mu.Lock()
	defer mock.mu.Unlock()

	if len(mock.createdAgents) != 1 {
		t.Errorf("expected 1 created agent, got %d", len(mock.createdAgents))
	}
	if len(mock.updatedAgents) != 1 {
		t.Errorf("expected 1 updated agent, got %d", len(mock.updatedAgents))
	}
}

// --- reconcileApplication full cycle tests ---

func TestReconcileApplication_SkipsNonRunningPhase(t *testing.T) {
	mock := newAppMockAPIServer()
	server := httptest.NewServer(mock.handler())
	defer server.Close()

	rec := newTestAppReconciler(t, server.URL, &mockGitFetcher{
		declarations: []gitAgentDeclaration{{Name: "should-not-run"}},
		revision:     "abc",
	})

	platformClient := newAppSDKClient(t, server.URL, platformProject)

	for _, phase := range []string{"Succeeded", "Failed", "Pending", ""} {
		app := &types.Application{
			ObjectReference: types.ObjectReference{ID: "app-skip-" + phase},
			Name:            "skip-" + phase,
			OperationPhase:  phase,
		}
		err := rec.reconcileApplication(context.Background(), platformClient, app)
		if err != nil {
			t.Errorf("expected nil error for phase %q, got %v", phase, err)
		}
	}

	mock.mu.Lock()
	defer mock.mu.Unlock()

	if len(mock.createdAgents) != 0 {
		t.Errorf("expected no agents created for non-Running phases, got %d", len(mock.createdAgents))
	}
}

func TestReconcileApplication_SuccessfulSync(t *testing.T) {
	mock := newAppMockAPIServer()
	mock.applications = []types.Application{
		{
			ObjectReference:    types.ObjectReference{ID: "app-sync"},
			Name:               "sync-app",
			OperationPhase:     opPhaseRunning,
			SourceRepoURL:      "https://github.com/org/repo.git",
			SourcePath:         "agents/",
			DestinationProject: "dest-proj",
		},
	}

	server := httptest.NewServer(mock.handler())
	defer server.Close()

	fetcher := &mockGitFetcher{
		declarations: []gitAgentDeclaration{
			{Name: "synced-agent", Prompt: "hello", LlmModel: "claude-sonnet-4-20250514"},
		},
		revision: "abc123def",
	}

	rec := newTestAppReconciler(t, server.URL, fetcher)
	platformClient := newAppSDKClient(t, server.URL, platformProject)

	app := &mock.applications[0]
	err := rec.reconcileApplication(context.Background(), platformClient, app)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	mock.mu.Lock()
	defer mock.mu.Unlock()

	if len(mock.createdAgents) != 1 {
		t.Fatalf("expected 1 created agent, got %d", len(mock.createdAgents))
	}

	patch, ok := mock.patchedApps["app-sync"]
	if !ok {
		t.Fatal("expected application status update for app-sync")
	}
	if patch["sync_status"] != syncStatusSynced {
		t.Errorf("expected sync_status=%s, got %v", syncStatusSynced, patch["sync_status"])
	}
	if patch["health_status"] != healthStatusHealthy {
		t.Errorf("expected health_status=%s, got %v", healthStatusHealthy, patch["health_status"])
	}
	if patch["operation_phase"] != opPhaseSucceeded {
		t.Errorf("expected operation_phase=%s, got %v", opPhaseSucceeded, patch["operation_phase"])
	}
	if patch["sync_revision"] != "abc123def" {
		t.Errorf("expected sync_revision=abc123def, got %v", patch["sync_revision"])
	}
}

func TestReconcileApplication_FetchFailureSetsFailedStatus(t *testing.T) {
	mock := newAppMockAPIServer()
	server := httptest.NewServer(mock.handler())
	defer server.Close()

	fetcher := &mockGitFetcher{
		err: fmt.Errorf("authentication required"),
	}

	rec := newTestAppReconciler(t, server.URL, fetcher)
	platformClient := newAppSDKClient(t, server.URL, platformProject)

	app := &types.Application{
		ObjectReference:    types.ObjectReference{ID: "app-fetch-fail"},
		Name:               "fetch-fail-app",
		OperationPhase:     opPhaseRunning,
		SourceRepoURL:      "https://github.com/private/repo.git",
		DestinationProject: "dest-proj",
	}

	err := rec.reconcileApplication(context.Background(), platformClient, app)
	if err != nil {
		t.Fatalf("unexpected error (should update status, not return error): %v", err)
	}

	mock.mu.Lock()
	defer mock.mu.Unlock()

	patch, ok := mock.patchedApps["app-fetch-fail"]
	if !ok {
		t.Fatal("expected application status update for app-fetch-fail")
	}
	if patch["sync_status"] != syncStatusOutOfSync {
		t.Errorf("expected sync_status=%s, got %v", syncStatusOutOfSync, patch["sync_status"])
	}
	if patch["operation_phase"] != opPhaseFailed {
		t.Errorf("expected operation_phase=%s, got %v", opPhaseFailed, patch["operation_phase"])
	}
	msg, _ := patch["operation_message"].(string)
	if !strings.Contains(msg, "authentication required") {
		t.Errorf("expected operation_message to contain error detail, got %q", msg)
	}
}

func TestReconcileApplication_ApplyFailureSetsFailedStatus(t *testing.T) {
	failServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if r.URL.Path == "/api/ambient/v1/applications" && r.Method == http.MethodGet {
			json.NewEncoder(w).Encode(map[string]interface{}{
				"kind": "ApplicationList", "page": 1, "size": 0, "total": 0, "items": []interface{}{},
			})
			return
		}

		if strings.HasPrefix(r.URL.Path, "/api/ambient/v1/applications/") && r.Method == http.MethodPatch {
			parts := strings.Split(r.URL.Path, "/")
			appID := parts[len(parts)-1]
			json.NewEncoder(w).Encode(map[string]interface{}{"id": appID})
			return
		}

		if strings.Contains(r.URL.Path, "/agents") {
			if r.Method == http.MethodGet {
				json.NewEncoder(w).Encode(map[string]interface{}{
					"kind": "AgentList", "page": 1, "size": 0, "total": 0, "items": []interface{}{},
				})
				return
			}
			if r.Method == http.MethodPost {
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(map[string]string{"code": "INTERNAL_ERROR", "reason": "database unavailable"})
				return
			}
		}

		w.WriteHeader(http.StatusNotFound)
	}))
	defer failServer.Close()

	fetcher := &mockGitFetcher{
		declarations: []gitAgentDeclaration{
			{Name: "will-fail", Prompt: "test"},
		},
		revision: "rev1",
	}

	rec := newTestAppReconciler(t, failServer.URL, fetcher)
	platformClient := newAppSDKClient(t, failServer.URL, platformProject)

	app := &types.Application{
		ObjectReference:    types.ObjectReference{ID: "app-apply-fail"},
		Name:               "apply-fail-app",
		OperationPhase:     opPhaseRunning,
		SourceRepoURL:      "https://github.com/org/repo.git",
		DestinationProject: "dest-proj",
	}

	err := rec.reconcileApplication(context.Background(), platformClient, app)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// --- reconcileOnce tests ---

func TestReconcileOnce_ProcessesOnlyRunningApplications(t *testing.T) {
	mock := newAppMockAPIServer()
	mock.applications = []types.Application{
		{
			ObjectReference:    types.ObjectReference{ID: "app-running"},
			Name:               "running-app",
			OperationPhase:     opPhaseRunning,
			SourceRepoURL:      "https://github.com/org/repo.git",
			SourcePath:         "agents/",
			DestinationProject: "proj-a",
		},
		{
			ObjectReference: types.ObjectReference{ID: "app-succeeded"},
			Name:            "succeeded-app",
			OperationPhase:  opPhaseSucceeded,
		},
		{
			ObjectReference: types.ObjectReference{ID: "app-failed"},
			Name:            "failed-app",
			OperationPhase:  opPhaseFailed,
		},
	}

	server := httptest.NewServer(mock.handler())
	defer server.Close()

	fetcher := &mockGitFetcher{
		declarations: []gitAgentDeclaration{
			{Name: "from-running", Prompt: "test"},
		},
		revision: "rev1",
	}

	rec := newTestAppReconciler(t, server.URL, fetcher)
	rec.reconcileOnce(context.Background())

	mock.mu.Lock()
	defer mock.mu.Unlock()

	if len(mock.createdAgents) != 1 {
		t.Fatalf("expected 1 created agent (only from running app), got %d", len(mock.createdAgents))
	}
	if mock.createdAgents[0].Name != "from-running" {
		t.Errorf("expected from-running, got %s", mock.createdAgents[0].Name)
	}

	if _, ok := mock.patchedApps["app-running"]; !ok {
		t.Error("expected status update for running app")
	}
	if _, ok := mock.patchedApps["app-succeeded"]; ok {
		t.Error("should NOT update status for succeeded app")
	}
	if _, ok := mock.patchedApps["app-failed"]; ok {
		t.Error("should NOT update status for failed app")
	}
}

func TestReconcileOnce_HandlesEmptyApplicationList(t *testing.T) {
	mock := newAppMockAPIServer()
	server := httptest.NewServer(mock.handler())
	defer server.Close()

	rec := newTestAppReconciler(t, server.URL, &mockGitFetcher{})
	rec.reconcileOnce(context.Background())

	mock.mu.Lock()
	defer mock.mu.Unlock()

	if len(mock.createdAgents) != 0 || len(mock.patchedApps) != 0 {
		t.Error("expected no API calls for empty application list")
	}
}

// --- Agent declaration field mapping tests ---

func TestApplyDeclarations_MapsAllFieldsToAgent(t *testing.T) {
	mock := newAppMockAPIServer()
	server := httptest.NewServer(mock.handler())
	defer server.Close()

	rec := newTestAppReconciler(t, server.URL, &mockGitFetcher{})

	app := &types.Application{
		ObjectReference:    types.ObjectReference{ID: "app-fields"},
		DestinationProject: "field-project",
	}

	declarations := []gitAgentDeclaration{
		{
			Name:        "full-agent",
			DisplayName: "Full Agent",
			Description: "an agent with all fields",
			Prompt:      "do everything",
			Entrypoint:  "/start.sh",
			Providers:   []string{"github", "jira"},
			Environment: map[string]string{"KEY": "value"},
			RepoURL:     "https://github.com/org/repo.git",
			LlmModel:    "claude-sonnet-4-20250514",
			Labels:      map[string]string{"team": "alpha"},
			Annotations: map[string]string{"note": "test"},
		},
	}

	err := rec.applyDeclarations(context.Background(), app, declarations)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	mock.mu.Lock()
	defer mock.mu.Unlock()

	if len(mock.createdAgents) != 1 {
		t.Fatalf("expected 1 created agent, got %d", len(mock.createdAgents))
	}

	created := mock.createdAgents[0]
	if created.Name != "full-agent" {
		t.Errorf("Name: expected full-agent, got %s", created.Name)
	}
	if created.DisplayName != "Full Agent" {
		t.Errorf("DisplayName: expected Full Agent, got %s", created.DisplayName)
	}
	if created.Description != "an agent with all fields" {
		t.Errorf("Description: expected 'an agent with all fields', got %s", created.Description)
	}
	if created.Prompt != "do everything" {
		t.Errorf("Prompt: expected 'do everything', got %s", created.Prompt)
	}
	if created.Entrypoint != "/start.sh" {
		t.Errorf("Entrypoint: expected /start.sh, got %s", created.Entrypoint)
	}
	if created.RepoURL != "https://github.com/org/repo.git" {
		t.Errorf("RepoURL: expected https://github.com/org/repo.git, got %s", created.RepoURL)
	}
	if created.LlmModel != "claude-sonnet-4-20250514" {
		t.Errorf("LlmModel: expected claude-sonnet-4-20250514, got %s", created.LlmModel)
	}
	if created.ProjectID != "field-project" {
		t.Errorf("ProjectID: expected field-project, got %s", created.ProjectID)
	}
}

func TestApplyDeclarations_DoesNotPruneNonApplicationAgents(t *testing.T) {
	mock := newAppMockAPIServer()

	mock.agents["agent-manual"] = types.Agent{
		ObjectReference: types.ObjectReference{ID: "agent-manual"},
		Name:            "manually-created",
		ProjectID:       "test-project",
		Annotations:     "",
	}

	nonAppAnnotations, _ := json.Marshal(map[string]string{
		annotationSource: "configmap",
	})
	mock.agents["agent-cm"] = types.Agent{
		ObjectReference: types.ObjectReference{ID: "agent-cm"},
		Name:            "configmap-agent",
		ProjectID:       "test-project",
		Annotations:     string(nonAppAnnotations),
	}

	server := httptest.NewServer(mock.handler())
	defer server.Close()

	rec := newTestAppReconciler(t, server.URL, &mockGitFetcher{})

	app := &types.Application{
		ObjectReference:    types.ObjectReference{ID: "app-no-prune-manual"},
		DestinationProject: "test-project",
		AutoPrune:          true,
	}

	err := rec.applyDeclarations(context.Background(), app, []gitAgentDeclaration{
		{Name: "declared-agent", Prompt: "test"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	mock.mu.Lock()
	defer mock.mu.Unlock()

	if len(mock.deletedAgents) != 0 {
		t.Errorf("expected 0 deleted agents (manual/configmap agents should not be pruned), got %d: %v",
			len(mock.deletedAgents), mock.deletedAgents)
	}
}
