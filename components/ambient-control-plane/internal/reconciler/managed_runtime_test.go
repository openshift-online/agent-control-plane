package reconciler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/auth"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/config"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/hypershell"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell"
	datapb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/datamodel/v1"
	sandboxpb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/sandbox/v1"
	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/runnerauth"
	sdkclient "github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/client"
	"github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/types"
	"github.com/rs/zerolog"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

func TestManagedSessionBindingUsesRoutableNamesBeforeGatewayRequest(t *testing.T) {
	seen := map[string]string{}
	validName := regexp.MustCompile(`^[a-z][a-z0-9-]{0,17}[a-z0-9]$`)
	for _, id := range []string{"3J6CUL5MoYr2eykRRkgSktf4IYE", "3J6CUSoEhn9Zj2akpxAHEwkcWmk", strings.Repeat("long-session-", 40), "session/with spaces"} {
		t.Run(id, func(t *testing.T) {
			var patch map[string]interface{}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if req.Method != http.MethodPatch {
					t.Errorf("unexpected method %s", req.Method)
				}
				if err := json.NewDecoder(req.Body).Decode(&patch); err != nil {
					t.Error(err)
				}
				if err := json.NewEncoder(w).Encode(types.Session{ObjectReference: types.ObjectReference{ID: id}}); err != nil {
					t.Error(err)
				}
			}))
			defer server.Close()
			sdk, err := sdkclient.NewServiceClient(server.URL, "test-service-identity-value")
			if err != nil {
				t.Fatal(err)
			}
			r := &ManagedReconciler{sessions: map[string]types.Session{}}
			project := types.Project{GatewayID: "gateway", GatewayStatus: "Ready"}
			for range 2 {
				// The gateway is nil: persist both names before any remote request.
				if err := r.reconcileManagedSession(context.Background(), sdk, project, types.Session{ObjectReference: types.ObjectReference{ID: id}}); err != nil {
					t.Fatal(err)
				}
				for _, field := range []string{"gateway_workspace", "sandbox_name"} {
					name, ok := patch[field].(string)
					if !ok || len(name) > 19 || !validName.MatchString(name) || strings.Contains(name, "--") {
						t.Fatalf("invalid routable %s: %v", field, patch[field])
					}
					if owner, exists := seen[name]; exists && owner != id+field {
						t.Fatalf("name collision for %s", field)
					}
					seen[name] = id + field
				}
			}
			workspace, sandbox := managedSessionResourceNames(id)
			if patch["gateway_workspace"] != workspace || patch["sandbox_name"] != sandbox {
				t.Fatal("resource names changed across reconciliation")
			}
		})
	}
}

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
	// The image policy already declares uvicorn. Native policy merges require
	// its explicit declaration when the callback authorization changes.
	paths := map[string]bool{}
	for _, binary := range rule.Binaries {
		paths[binary.Path] = true
	}
	for _, path := range []string{managedPython, "/sandbox/.venv/bin/python3", "/sandbox/.venv/bin/uvicorn", "/sandbox/.uv/python/cpython-*/bin/python*"} {
		if !paths[path] {
			t.Errorf("callback policy omits runner binary %s", path)
		}
	}
}

func TestManagedCallbacksPassTLSOnlyToConfiguredEndpoints(t *testing.T) {
	for _, tc := range []struct {
		name, tokenURL, grpcAddress, tokenHost, grpcHost string
		tokenPort, grpcPort                              uint32
	}{
		{"default HTTPS port", "https://cp.example/token", "runner.example:443", "cp.example", "runner.example", 443, 443},
		{"custom ports", "https://cp.example:8443/token", "runner.example:9443", "cp.example", "runner.example", 8443, 9443},
		{"IPv6", "https://[2001:db8::1]:8443/token", "[2001:db8::2]:9443", "2001:db8::1", "2001:db8::2", 8443, 9443},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &ManagedReconciler{cfg: &config.HypershellConfig{RunnerTokenURL: tc.tokenURL, RunnerGRPCAddress: tc.grpcAddress}}
			rule, err := r.managedNetworkRule()
			if err != nil {
				t.Fatal(err)
			}
			if rule.Name != "acp-session-callbacks" || len(rule.Endpoints) != 2 {
				t.Fatal("callback rule must contain only its two configured endpoints")
			}
			if rule.Endpoints[0].Host != tc.tokenHost || rule.Endpoints[0].Port != tc.tokenPort || rule.Endpoints[1].Host != tc.grpcHost || rule.Endpoints[1].Port != tc.grpcPort {
				t.Fatal("callback destination changed")
			}
			for _, endpoint := range rule.Endpoints {
				if endpoint.Tls != "skip" || endpoint.Protocol != "" {
					t.Fatal("callback TLS must pass through a layer-4 endpoint")
				}
			}
			paths := map[string]bool{
				"/sandbox/.venv/bin/python":                 true,
				"/sandbox/.venv/bin/python3":                true,
				"/sandbox/.venv/bin/uvicorn":                true,
				"/sandbox/.uv/python/cpython-*/bin/python*": true,
			}
			if len(rule.Binaries) != len(paths) {
				t.Fatal("callback binary scope changed")
			}
			for _, binary := range rule.Binaries {
				if !paths[binary.Path] {
					t.Fatalf("unexpected or duplicate callback binary %s", binary.Path)
				}
				delete(paths, binary.Path)
			}
		})
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

// This fake models the native authored-policy endpoint and object-version CAS.
// Its sandbox spec deliberately contains a provider-composed rule that must
// never be copied into an authored update.
type callbackPolicyGateway struct {
	version  uint64
	authored *sandboxpb.SandboxPolicy
	writes   int
	conflict bool
	readErr  error
}

func (g *callbackPolicyGateway) GetSandbox(context.Context, string, string) (*pb.SandboxResponse, error) {
	return &pb.SandboxResponse{Sandbox: &pb.Sandbox{Metadata: &datapb.ObjectMeta{ResourceVersion: g.version}, Spec: &pb.SandboxSpec{Policy: &sandboxpb.SandboxPolicy{NetworkPolicies: map[string]*sandboxpb.NetworkPolicyRule{"_provider_composed": {Name: "must-not-be-authored"}}}}}}, nil
}
func (g *callbackPolicyGateway) GetSandboxPolicyStatus(context.Context, string, string) (*pb.GetSandboxPolicyStatusResponse, error) {
	if g.readErr != nil {
		return nil, g.readErr
	}
	return &pb.GetSandboxPolicyStatusResponse{Revision: &pb.SandboxPolicyRevision{Policy: g.authored, Provenance: map[string]string{"owner": "test"}}}, nil
}
func (g *callbackPolicyGateway) UpdateConfig(_ context.Context, _ string, request *pb.UpdateConfigRequest) (*pb.UpdateConfigResponse, error) {
	if request.Policy == nil || len(request.MergeOperations) != 0 || request.Name != "sandbox" || request.Annotations["owner"] != "test" {
		return nil, errors.New("expected authored policy replacement with retained provenance")
	}
	if g.conflict {
		g.conflict = false
		g.version++
		g.authored.NetworkPolicies["concurrent-user-rule"] = &sandboxpb.NetworkPolicyRule{Name: "concurrent-user-rule"}
	}
	if request.ExpectedResourceVersion != g.version {
		return nil, status.Error(codes.Aborted, "object version changed")
	}
	g.authored = request.Policy
	g.version++
	g.writes++
	return &pb.UpdateConfigResponse{}, nil
}

func TestManagedCallbackPolicyReplacesOnlyReservedAuthoredRule(t *testing.T) {
	r := &ManagedReconciler{cfg: &config.HypershellConfig{RunnerTokenURL: "https://new-token.example/token", RunnerGRPCAddress: "new-grpc.example:443"}}
	desired, err := r.managedNetworkRule()
	if err != nil {
		t.Fatal(err)
	}
	// This overlapping user rule would receive an AddRule fallback after a
	// RemoveRule operation. Exact replacement must leave it unchanged.
	userRule := &sandboxpb.NetworkPolicyRule{Name: "user-rule", Endpoints: []*sandboxpb.NetworkEndpoint{{Host: "new-token.example", Port: 443, Tls: "terminate"}}, Binaries: []*sandboxpb.NetworkBinary{{Path: "/usr/bin/curl"}}}
	oldRule := &sandboxpb.NetworkPolicyRule{Name: "old-callback", Endpoints: []*sandboxpb.NetworkEndpoint{{Host: "old-token.example", Port: 443, Tls: "terminate"}, {Host: "old-grpc.example", Port: 443, Tls: "auto"}}}
	original := &sandboxpb.SandboxPolicy{NetworkPolicies: map[string]*sandboxpb.NetworkPolicyRule{acpInternalPolicyKey: oldRule, "user-rule": userRule}}
	before := proto.Clone(original).(*sandboxpb.SandboxPolicy)
	gateway := &callbackPolicyGateway{version: 7, authored: original}
	if err := replaceManagedCallbackPolicy(context.Background(), gateway, "target", "sandbox", desired); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(original, before) {
		t.Fatal("authored response was mutated")
	}
	if len(gateway.authored.NetworkPolicies) != 2 || !proto.Equal(gateway.authored.NetworkPolicies["user-rule"], userRule) || !proto.Equal(gateway.authored.NetworkPolicies[acpInternalPolicyKey], desired) {
		t.Fatal("replacement retained old callback destinations or changed other rules")
	}
	if err := replaceManagedCallbackPolicy(context.Background(), gateway, "target", "sandbox", desired); err != nil {
		t.Fatal(err)
	}
	if gateway.writes != 1 {
		t.Fatalf("unchanged policy caused %d writes", gateway.writes)
	}
}

func TestManagedCallbackPolicyCASPreservesConcurrentChanges(t *testing.T) {
	desired := &sandboxpb.NetworkPolicyRule{Name: "callbacks"}
	gateway := &callbackPolicyGateway{version: 7, authored: &sandboxpb.SandboxPolicy{NetworkPolicies: map[string]*sandboxpb.NetworkPolicyRule{}}, conflict: true}
	err := replaceManagedCallbackPolicy(context.Background(), gateway, "target", "sandbox", desired)
	if status.Code(err) != codes.Aborted || gateway.writes != 0 {
		t.Fatalf("stale update was not rejected: %v", err)
	}
	if err := replaceManagedCallbackPolicy(context.Background(), gateway, "target", "sandbox", desired); err != nil {
		t.Fatal(err)
	}
	if gateway.authored.NetworkPolicies["concurrent-user-rule"] == nil || gateway.writes != 1 {
		t.Fatal("retry lost a concurrent policy edit")
	}
	gateway.readErr = errors.New("policy unavailable")
	if err := replaceManagedCallbackPolicy(context.Background(), gateway, "target", "sandbox", desired); !errors.Is(err, gateway.readErr) {
		t.Fatalf("policy read error = %v", err)
	}
	if gateway.writes != 1 {
		t.Fatal("policy read failure caused a write")
	}
}
