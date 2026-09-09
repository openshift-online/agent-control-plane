package reconciler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/auth"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/config"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/runnerauth"
	sdkclient "github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/client"
	"github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/types"
	"github.com/rs/zerolog"
)

func TestManagedBindingIsPersistedBeforeGatewayRequest(t *testing.T) {
	var patch map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != "PATCH" || req.URL.Path != "/api/ambient/v1/runtime/projects/workspace" {
			t.Errorf("unexpected request %s %s", req.Method, req.URL.Path)
		}
		if err := json.NewDecoder(req.Body).Decode(&patch); err != nil {
			t.Error(err)
		}
		fmt.Fprint(w, `{"id":"workspace","runtime_backend":"hypershell","runtime_version":1}`)
	}))
	defer server.Close()
	sdk, _ := sdkclient.NewServiceClient(server.URL, "test-service-identity-value")
	r := &ManagedReconciler{cfg: &config.HypershellConfig{InstanceID: "instance-one"}, projects: map[string]types.Project{}}
	now := time.Now()
	project := types.Project{ObjectReference: types.ObjectReference{ID: "workspace", CreatedAt: &now}, Name: "workspace"}
	// hs is nil: the first step must commit its durable identity before any call.
	if err := r.reconcileProject(context.Background(), sdk, project); err != nil {
		t.Fatal(err)
	}
	if patch["runtime_backend"] != ManagedBackend || patch["gateway_instance_id"] != "instance-one" || patch["gateway_external_reference"] == "" {
		t.Fatalf("incomplete binding: %#v", patch)
	}
	project.GatewayInstanceID = "other-instance"
	if err := r.reconcileProject(context.Background(), sdk, project); err == nil {
		t.Fatal("adopted another instance's workspace")
	}
}

func TestManagedRunnerAuthorizationChecksCurrentGenerationAndPhase(t *testing.T) {
	session := types.Session{ObjectReference: types.ObjectReference{ID: "session-one"}, ProjectID: "workspace", RuntimeBackend: ManagedBackend, GatewayID: "gateway", GatewayWorkspace: "session-space", SandboxName: "sandbox", RunnerGeneration: "generation-one", Phase: PhaseRunning}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "Bearer test-user-identity-value" && req.Header.Get("Authorization") != "Bearer test-service-identity-value" {
			t.Error("unexpected identity")
		}
		json.NewEncoder(w).Encode(session)
	}))
	defer server.Close()
	r := &ManagedReconciler{factory: NewSDKClientFactory(server.URL, auth.NewStaticTokenProvider("test-service-identity-value"), zerolog.Nop())}
	claims := runnerauth.Claims{SessionID: session.ID, ProjectID: session.ProjectID, SandboxName: session.SandboxName, Generation: session.RunnerGeneration}
	if err := r.ValidateRunner(context.Background(), claims); err != nil {
		t.Fatal(err)
	}
	claims.Generation = "old-generation"
	if err := r.ValidateRunner(context.Background(), claims); err == nil {
		t.Fatal("stale generation accepted")
	}
	claims.Generation = session.RunnerGeneration
	session.Phase = PhaseStopping
	if err := r.ValidateRunner(context.Background(), claims); err == nil {
		t.Fatal("stopping session accepted")
	}
	key, err := r.AuthorizeSandbox(context.Background(), "test-user-identity-value", session.ID, session.SandboxName)
	if err != nil || key != openshell.TargetKey("gateway", "session-space") {
		t.Fatalf("authorized target: %s %v", key, err)
	}
	if _, err := r.AuthorizeSandbox(context.Background(), "test-user-identity-value", session.ID, "other-sandbox"); err == nil {
		t.Fatal("other sandbox accepted")
	}
}

func TestManagedWorkspaceDeletionWaitsForSessionCleanup(t *testing.T) {
	r := &ManagedReconciler{}
	p := types.Project{ObjectReference: types.ObjectReference{ID: "workspace"}, GatewayID: "gateway"}
	sessions := map[string]types.Session{"session": {ProjectID: "workspace", GatewayID: "gateway", RuntimeStatus: "Deleting"}}
	// No clients are needed until all owned sandboxes have completed cleanup.
	if err := r.deleteManagedProject(context.Background(), nil, p, sessions); err != nil {
		t.Fatal(err)
	}
}

func TestManagedEnvironmentProtectsIdentityAndUsesExternalEndpoints(t *testing.T) {
	r := &ManagedReconciler{cfg: &config.HypershellConfig{RunnerGRPCAddress: "runner.example:443", RunnerTokenURL: "https://cp.example/token"}}
	s := types.Session{ObjectReference: types.ObjectReference{ID: "session"}, ProjectID: "workspace"}
	agent := &types.Agent{Environment: map[string]string{"SESSION_ID": "other", "AMBIENT_GRPC_USE_TLS": "false", "AMBIENT_ALLOW_INSECURE_RUNNER_TRANSPORT": "true", "CLAUDE_CODE_USE_VERTEX": "1", "GOOGLE_APPLICATION_CREDENTIALS": "/private/key"}}
	env := r.managedEnvironment(s, agent, &ManagedProviderPlan{Environment: map[string]string{}, InferenceProvider: "inference"})
	if env["SESSION_ID"] != "session" || env["AMBIENT_GRPC_USE_TLS"] != "true" || env["AMBIENT_ALLOW_INSECURE_RUNNER_TRANSPORT"] != "" || env["GOOGLE_APPLICATION_CREDENTIALS"] != "" || env["CLAUDE_CODE_USE_VERTEX"] != "" {
		t.Fatal("agent environment replaced platform identity or inference routing")
	}
	rule, err := r.managedNetworkRule()
	if err != nil {
		t.Fatal(err)
	}
	if len(rule.Endpoints) != 2 || rule.Endpoints[0].Host != "cp.example" || rule.Endpoints[1].Host != "runner.example" {
		t.Fatal("policy did not use external callback hosts")
	}
}
