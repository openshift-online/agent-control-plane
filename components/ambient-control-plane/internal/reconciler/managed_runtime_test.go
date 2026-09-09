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
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/hypershell"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell"
	datapb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/datamodel/v1"
	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
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
		if _, err := fmt.Fprint(w, `{"id":"workspace","runtime_backend":"hypershell","runtime_version":1}`); err != nil {
			t.Error(err)
		}
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
		if err := json.NewEncoder(w).Encode(session); err != nil {
			t.Error(err)
		}
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
	env, err := r.managedEnvironment(s, agent, &ManagedProviderPlan{Environment: map[string]string{}, InferenceProvider: "inference"})
	if err != nil {
		t.Fatal(err)
	}
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

func TestManagedSessionEnvironmentValidatesInputAndKeepsLimits(t *testing.T) {
	r := &ManagedReconciler{cfg: &config.HypershellConfig{}}
	s := types.Session{ObjectReference: types.ObjectReference{ID: "session"}, ProjectID: "project", EnvironmentVariables: `{"AMBIENT_PROJECT_ID":"other","USER_OPTION":"set"}`, Timeout: 90, LlmMaxTokens: 400, LlmTemperature: 0.2}
	env, err := r.managedEnvironment(s, nil, &ManagedProviderPlan{})
	if err != nil {
		t.Fatal(err)
	}
	if env["AMBIENT_PROJECT_ID"] != "project" || env["USER_OPTION"] != "set" || env["TIMEOUT"] != "90" || env["LLM_MAX_TOKENS"] != "400" || env["LLM_TEMPERATURE"] != "0.2" {
		t.Fatal("session settings or identity were lost")
	}
	s.EnvironmentVariables = `{"option":42}`
	if _, err := r.managedEnvironment(s, nil, &ManagedProviderPlan{}); err == nil {
		t.Fatal("invalid session environment accepted")
	}
}

func TestManagedDeletionRecoversGatewayAfterLostCreateResponse(t *testing.T) {
	for _, deleted := range []bool{false, true} {
		t.Run(fmt.Sprintf("already-deleted=%t", deleted), func(t *testing.T) {
			creates := 0
			hsServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if req.URL.Path == "/api/hypershell/v1/gateways/deletion" {
					if !deleted {
						w.WriteHeader(http.StatusNotFound)
						return
					}
					if _, err := fmt.Fprint(w, `{"gateway_id":"gateway","external_reference":"instance/reference","state":"pending"}`); err != nil {
						t.Error(err)
					}
					return
				}
				if req.Method != http.MethodPost || req.URL.Path != "/api/hypershell/v1/gateways" {
					t.Errorf("unexpected HS operation %s %s", req.Method, req.URL.Path)
					w.WriteHeader(500)
					return
				}
				creates++
				var body map[string]interface{}
				if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if body["external_reference"] != "instance/reference" {
					t.Error("durable create key was not replayed")
				}
				w.WriteHeader(http.StatusCreated)
				if _, err := fmt.Fprint(w, `{"id":"gateway","external_reference":"instance/reference"}`); err != nil {
					t.Error(err)
				}
			}))
			defer hsServer.Close()
			hs, err := hypershell.NewClient(hsServer.URL, auth.NewStaticTokenProvider("test-service-identity-value"), hsServer.Client())
			if err != nil {
				t.Fatal(err)
			}
			var patch map[string]interface{}
			apiServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if err := json.NewDecoder(req.Body).Decode(&patch); err != nil {
					t.Error(err)
				}
				if _, err := fmt.Fprint(w, `{"id":"project","gateway_id":"gateway","runtime_version":1}`); err != nil {
					t.Error(err)
				}
			}))
			defer apiServer.Close()
			sdk, _ := sdkclient.NewServiceClient(apiServer.URL, "test-service-identity-value")
			r := &ManagedReconciler{hs: hs, cfg: &config.HypershellConfig{InstanceID: "instance"}, projects: map[string]types.Project{}}
			p := types.Project{ObjectReference: types.ObjectReference{ID: "project"}, RuntimeDeleted: true, GatewayInstanceID: "instance", GatewayExternalReference: "instance/reference"}
			if err := r.deleteManagedProject(context.Background(), sdk, p, nil); err != nil {
				t.Fatal(err)
			}
			if patch["gateway_id"] != "gateway" || patch["gateway_status"] == "Deleted" {
				t.Fatalf("cleanup identity was lost: %v", patch)
			}
			if deleted && creates != 0 {
				t.Fatal("recreated a gateway with a deletion record")
			}
			if !deleted && creates != 1 {
				t.Fatal("did not recover in-flight creation")
			}
		})
	}
}

func TestManagedSandboxOwnershipRequiresLabelsAndStoredIdentity(t *testing.T) {
	s := types.Session{ObjectReference: types.ObjectReference{ID: "session"}, ProjectID: "project", SandboxID: "sandbox"}
	response := &pb.SandboxResponse{Sandbox: &pb.Sandbox{Metadata: &datapb.ObjectMeta{Id: "sandbox", Labels: map[string]string{"ambient-code.io/session-id": "session", LabelProjectID: "project"}}}}
	if err := validateManagedSandbox(s, response); err != nil {
		t.Fatal(err)
	}
	response.Sandbox.Metadata.Id = "replacement"
	if err := validateManagedSandbox(s, response); err == nil {
		t.Fatal("accepted replacement sandbox")
	}
	response.Sandbox.Metadata.Id = "sandbox"
	response.Sandbox.Metadata.Labels[LabelProjectID] = "other"
	if err := validateManagedSandbox(s, response); err == nil {
		t.Fatal("accepted other workspace")
	}
	if err := validateManagedSandbox(s, nil); err == nil {
		t.Fatal("accepted missing sandbox")
	}
}

func TestManagedStopRecordsCleanupBeforeGatewayCall(t *testing.T) {
	for _, phase := range []string{PhaseCompleted, PhaseFailed, PhaseStopping} {
		t.Run(phase, func(t *testing.T) {
			var patch map[string]interface{}
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if err := json.NewDecoder(req.Body).Decode(&patch); err != nil {
					t.Error(err)
				}
				if _, err := fmt.Fprint(w, `{"id":"session","runtime_status":"Stopping","runtime_version":1}`); err != nil {
					t.Error(err)
				}
			}))
			defer api.Close()
			sdk, _ := sdkclient.NewServiceClient(api.URL, "test-service-identity-value")
			r := &ManagedReconciler{sessions: map[string]types.Session{}}
			s := types.Session{ObjectReference: types.ObjectReference{ID: "session"}, Phase: phase, RuntimeStatus: "Running", RunnerGeneration: "old"}
			// A nil gateway proves cleanup state is saved before external operations.
			if err := r.stopManagedSession(context.Background(), sdk, s, "target"); err != nil {
				t.Fatal(err)
			}
			if patch["runtime_status"] != "Stopping" || patch["runner_generation"] != "" {
				t.Fatal("cleanup state was not persisted")
			}
		})
	}
}
