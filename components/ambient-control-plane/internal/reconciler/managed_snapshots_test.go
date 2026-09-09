package reconciler

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/auth"
	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell"
	datapb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/datamodel/v1"
	policypb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/sandbox/v1"
	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	sdkclient "github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/client"
	"github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/types"
	"github.com/rs/zerolog"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type managedSnapshotServer struct {
	pb.UnimplementedOpenShellServer
	mu                   sync.Mutex
	sandbox              *pb.Sandbox
	logError, patchError bool
	emptyLogs            bool
	policyError          bool
	currentPolicy        *policypb.SandboxPolicy
	logs                 []*pb.SandboxLogLine
	patchAttempts        int
	calls                []string
	session              types.Session
}

func (s *managedSnapshotServer) GetSandbox(context.Context, *pb.GetSandboxRequest) (*pb.SandboxResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sandbox == nil {
		return nil, status.Error(codes.NotFound, "sandbox not found")
	}
	return &pb.SandboxResponse{Sandbox: s.sandbox}, nil
}
func (s *managedSnapshotServer) GetSandboxPolicyStatus(_ context.Context, req *pb.GetSandboxPolicyStatusRequest) (*pb.GetSandboxPolicyStatusResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if req.Name != "sandbox" || req.Workspace != "workspace" {
		return nil, status.Error(codes.InvalidArgument, "wrong policy binding")
	}
	if s.policyError {
		return nil, status.Error(codes.Unavailable, "policy unavailable")
	}
	policy := s.currentPolicy
	if policy == nil {
		policy = s.sandbox.GetSpec().GetPolicy()
	}
	return &pb.GetSandboxPolicyStatusResponse{Revision: &pb.SandboxPolicyRevision{Policy: policy}}, nil
}
func (s *managedSnapshotServer) GetSandboxLogs(_ context.Context, req *pb.GetSandboxLogsRequest) (*pb.GetSandboxLogsResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, "logs")
	if req.SandboxId != "sandbox-id" || req.Lines != openshell.LogTailLines || req.Workspace != "workspace" {
		return nil, status.Error(codes.InvalidArgument, "incorrect snapshot request")
	}
	if s.logError {
		return nil, status.Error(codes.Unavailable, "log collection failed")
	}
	if s.emptyLogs {
		return &pb.GetSandboxLogsResponse{}, nil
	}
	if s.logs != nil {
		return &pb.GetSandboxLogsResponse{Logs: s.logs}, nil
	}
	return &pb.GetSandboxLogsResponse{Logs: []*pb.SandboxLogLine{{TimestampMs: 42, Source: "sandbox", Level: "INFO", Target: "network", Message: "provider request allowed", Fields: map[string]string{"provider": "session-provider", "action": "allow", "dst_host": "model.example"}}}}, nil
}
func (s *managedSnapshotServer) StopSandbox(context.Context, *pb.StopSandboxRequest) (*pb.SandboxResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, "stop")
	s.sandbox.Status.Phase = pb.SandboxPhase_SANDBOX_PHASE_STOPPED
	return &pb.SandboxResponse{Sandbox: s.sandbox}, nil
}
func (s *managedSnapshotServer) DeleteSandbox(context.Context, *pb.DeleteSandboxRequest) (*pb.DeleteSandboxResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, "delete")
	return &pb.DeleteSandboxResponse{}, nil
}

func newManagedSnapshotTest(t *testing.T) (*ManagedReconciler, *sdkclient.Client, *managedSnapshotServer, string) {
	t.Helper()
	session := types.Session{ObjectReference: types.ObjectReference{ID: "session"}, ProjectID: "project", GatewayID: "gateway", GatewayWorkspace: "workspace", SandboxID: "sandbox-id", SandboxName: "sandbox", Phase: PhaseCompleted, RuntimeStatus: "Stopping", RuntimeVersion: 3}
	server := &managedSnapshotServer{session: session, sandbox: &pb.Sandbox{Metadata: &datapb.ObjectMeta{Id: "sandbox-id", Name: "sandbox", Labels: map[string]string{"ambient-code.io/session-id": "session", LabelProjectID: "project"}}, Spec: &pb.SandboxSpec{Environment: map[string]string{"SECRET_VALUE": "must-not-copy-environment"}, Providers: []string{"session-provider"}, Policy: &policypb.SandboxPolicy{Version: 4}}, Status: &pb.SandboxStatus{Phase: pb.SandboxPhase_SANDBOX_PHASE_READY, CurrentPolicyVersion: 4}}}
	grpcServer := grpc.NewServer()
	pb.RegisterOpenShellServer(grpcServer, server)
	httpServer := httptest.NewUnstartedServer(grpcServer)
	httpServer.EnableHTTP2 = true
	httpServer.StartTLS()
	t.Cleanup(httpServer.Close)
	t.Cleanup(grpcServer.Stop)
	pool := x509.NewCertPool()
	pool.AddCert(httpServer.Certificate())
	target := openshell.TargetKey("gateway", "workspace")
	gateway := openshell.NewGatewayClient("", 0, nil, "", zerolog.Nop(), openshell.WithTargetResolver(func(_ context.Context, key string) (openshell.GatewayTarget, error) {
		if key != target {
			return openshell.GatewayTarget{}, fmt.Errorf("wrong recorded target")
		}
		return openshell.GatewayTarget{Endpoint: httpServer.URL, TLSConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}, TokenProvider: auth.NewStaticTokenProvider("test-gateway-identity-value"), Workspace: "workspace", Revision: "one"}, nil
	}))
	t.Cleanup(func() {
		if err := gateway.Close(); err != nil {
			t.Error(err)
		}
	})
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		server.mu.Lock()
		defer server.mu.Unlock()
		if req.Method != "PATCH" || req.URL.Path != "/api/ambient/v1/runtime/sessions/session" {
			t.Errorf("unexpected API request: %s %s", req.Method, req.URL.Path)
			w.WriteHeader(500)
			return
		}
		var patch map[string]interface{}
		if err := json.NewDecoder(req.Body).Decode(&patch); err != nil {
			t.Error(err)
			w.WriteHeader(500)
			return
		}
		server.patchAttempts++
		version, ok := patch["runtime_version"].(float64)
		if !ok || int(version) != server.session.RuntimeVersion || server.patchError {
			w.WriteHeader(http.StatusConflict)
			return
		}
		if phase, ok := patch["expected_phase"]; ok && phase != server.session.Phase {
			w.WriteHeader(http.StatusConflict)
			return
		}
		server.calls = append(server.calls, "persist")
		if value, ok := patch["sandbox_logs_snapshot"].(string); ok {
			server.session.SandboxLogsSnapshot = value
		}
		if value, ok := patch["sandbox_policy_snapshot"].(string); ok {
			server.session.SandboxPolicySnapshot = value
		}
		if value, ok := patch["phase"].(string); ok {
			server.session.Phase = value
		}
		if value, ok := patch["runtime_status"].(string); ok {
			server.session.RuntimeStatus = value
		}
		server.session.RuntimeVersion++
		if err := json.NewEncoder(w).Encode(server.session); err != nil {
			t.Error(err)
		}
	}))
	t.Cleanup(api.Close)
	sdk, err := sdkclient.NewServiceClient(api.URL, "test-service-identity-value")
	if err != nil {
		t.Fatal(err)
	}
	return &ManagedReconciler{gateway: gateway, sessions: map[string]types.Session{"session": session}}, sdk, server, target
}

func TestManagedSnapshotPrecedesStopAndSurvivesStoppedRuntime(t *testing.T) {
	r, sdk, server, target := newManagedSnapshotTest(t)
	if err := r.stopManagedSession(context.Background(), sdk, server.session, target); err != nil {
		t.Fatal(err)
	}
	server.mu.Lock()
	calls := strings.Join(server.calls, ",")
	saved := server.session
	server.logError = true
	server.mu.Unlock()
	if calls != "logs,persist,stop" {
		t.Fatalf("operation order: %s", calls)
	}
	if saved.SandboxLogsSnapshot == "" || saved.SandboxPolicySnapshot == "" || strings.Contains(saved.SandboxPolicySnapshot, "must-not-copy-environment") {
		t.Fatal("snapshot missing or environment copied")
	}
	var logs []map[string]interface{}
	if err := json.Unmarshal([]byte(saved.SandboxLogsSnapshot), &logs); err != nil {
		t.Fatal(err)
	}
	if len(logs) != 1 || logs[0]["message"] != "provider request allowed" {
		t.Fatal("provider/network log was lost")
	}
	if err := r.stopManagedSession(context.Background(), sdk, saved, target); err != nil {
		t.Fatal(err)
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if server.session.Phase != PhaseCompleted || server.session.RuntimeStatus != "Stopped" {
		t.Fatal("whole-process completion was not preserved")
	}
	if server.session.SandboxLogsSnapshot != saved.SandboxLogsSnapshot {
		t.Fatal("stopped sandbox erased final logs")
	}
	if strings.Join(server.calls, ",") != "logs,persist,stop,persist" {
		t.Fatal("logs fetched again after stop")
	}
}
func TestManagedSnapshotFailurePreventsStopAndDelete(t *testing.T) {
	for _, action := range []string{"stop", "delete"} {
		for _, failure := range []string{"logs", "CAS"} {
			t.Run(action+failure, func(t *testing.T) {
				r, sdk, server, target := newManagedSnapshotTest(t)
				server.logError = failure == "logs"
				server.patchError = failure == "CAS"
				var err error
				if action == "stop" {
					err = r.stopManagedSession(context.Background(), sdk, server.session, target)
				} else {
					err = r.deleteManagedSession(context.Background(), sdk, server.session)
				}
				if err == nil {
					t.Fatal("snapshot failure ignored")
				}
				server.mu.Lock()
				defer server.mu.Unlock()
				for _, call := range server.calls {
					if call == "stop" || call == "delete" || call == "persist" {
						t.Fatalf("operation after failed capture: %s", call)
					}
				}
			})
		}
	}
}
func TestManagedSnapshotDeleteUsesUpdatedCASVersion(t *testing.T) {
	r, sdk, server, _ := newManagedSnapshotTest(t)
	if err := r.deleteManagedSession(context.Background(), sdk, server.session); err != nil {
		t.Fatal(err)
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if strings.Join(server.calls, ",") != "logs,persist,delete,persist" {
		t.Fatalf("operation order: %v", server.calls)
	}
	if server.session.RuntimeStatus != "Deleting" || server.session.RuntimeVersion != 5 || server.session.SandboxLogsSnapshot == "" {
		t.Fatal("snapshot or post-delete CAS lost")
	}
}

func TestManagedSnapshotDeletePreservesStoppedCapture(t *testing.T) {
	r, sdk, server, _ := newManagedSnapshotTest(t)
	server.sandbox.Status.Phase = pb.SandboxPhase_SANDBOX_PHASE_STOPPED
	server.session.SandboxPolicySnapshot = `{"version":1}`
	server.session.SandboxLogsSnapshot = `[{"message":"final saved log"}]`
	server.logError = true
	saved := server.session
	if err := r.deleteManagedSession(context.Background(), sdk, saved); err != nil {
		t.Fatal(err)
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if strings.Join(server.calls, ",") != "delete,persist" {
		t.Fatalf("stopped capture was fetched again: %v", server.calls)
	}
	if server.session.SandboxLogsSnapshot != saved.SandboxLogsSnapshot || server.session.SandboxPolicySnapshot != saved.SandboxPolicySnapshot {
		t.Fatal("stopped capture changed during deletion")
	}
}

func TestManagedSnapshotEmptyLogsDoNotBlockCleanup(t *testing.T) {
	for _, phase := range []pb.SandboxPhase{pb.SandboxPhase_SANDBOX_PHASE_PROVISIONING, pb.SandboxPhase_SANDBOX_PHASE_ERROR, pb.SandboxPhase_SANDBOX_PHASE_STOPPED} {
		for _, action := range []string{"stop", "delete"} {
			t.Run(phase.String()+"/"+action, func(t *testing.T) {
				r, sdk, server, target := newManagedSnapshotTest(t)
				server.sandbox.Status.Phase = phase
				server.emptyLogs = true
				var err error
				if action == "stop" {
					err = r.stopManagedSession(context.Background(), sdk, server.session, target)
				} else {
					err = r.deleteManagedSession(context.Background(), sdk, server.session)
				}
				if err != nil {
					t.Fatal(err)
				}
				server.mu.Lock()
				defer server.mu.Unlock()
				if server.session.SandboxLogsSnapshot != "[]" || server.session.SandboxPolicySnapshot == "" {
					t.Fatal("empty log buffer did not produce a durable snapshot")
				}
				want := "logs,persist," + action
				if action == "delete" {
					want += ",persist"
				}
				if action == "stop" && phase == pb.SandboxPhase_SANDBOX_PHASE_STOPPED {
					want = "logs,persist,persist"
				}
				if got := strings.Join(server.calls, ","); got != want {
					t.Fatalf("operation order: %s, want %s", got, want)
				}
			})
		}
	}
}

func TestManagedSnapshotPhaseConflictPreventsRemoteMutation(t *testing.T) {
	for _, action := range []string{"stop", "delete"} {
		t.Run(action, func(t *testing.T) {
			r, sdk, server, target := newManagedSnapshotTest(t)
			stale := server.session
			server.session.Phase = PhasePending
			var err error
			if action == "stop" {
				err = r.stopManagedSession(context.Background(), sdk, stale, target)
			} else {
				err = r.deleteManagedSession(context.Background(), sdk, stale)
			}
			if err == nil {
				t.Fatal("phase conflict was ignored")
			}
			server.mu.Lock()
			defer server.mu.Unlock()
			if got := strings.Join(server.calls, ","); got != "logs" {
				t.Fatalf("mutation after phase conflict: %s", got)
			}
		})
	}
}

func TestManagedSnapshotAbsentSandboxDoesNotBlockStop(t *testing.T) {
	r, sdk, server, target := newManagedSnapshotTest(t)
	server.sandbox = nil
	if err := r.stopManagedSession(context.Background(), sdk, server.session, target); err != nil {
		t.Fatal(err)
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if server.session.RuntimeStatus != "Stopped" || strings.Join(server.calls, ",") != "persist" {
		t.Fatalf("absent runtime cleanup blocked: %v", server.calls)
	}
}

func TestManagedCleanupContinuesWithDegradedGateway(t *testing.T) {
	for _, phase := range []string{PhaseStopping, PhaseCompleted, PhaseFailed} {
		t.Run(phase, func(t *testing.T) {
			r, sdk, server, _ := newManagedSnapshotTest(t)
			server.session.Phase = phase
			project := types.Project{GatewayID: server.session.GatewayID, GatewayStatus: "Degraded"}
			if err := r.reconcileManagedSession(context.Background(), sdk, project, server.session); err != nil {
				t.Fatal(err)
			}
			server.mu.Lock()
			defer server.mu.Unlock()
			if got := strings.Join(server.calls, ","); got != "logs,persist,stop" {
				t.Fatalf("cleanup did not reach degraded gateway: %s", got)
			}
		})
	}
}

func TestManagedActiveSessionWaitsForReadyGateway(t *testing.T) {
	for _, phase := range []string{PhasePending, PhaseCreating, PhaseRunning} {
		t.Run(phase, func(t *testing.T) {
			r, sdk, server, _ := newManagedSnapshotTest(t)
			server.session.Phase = phase
			project := types.Project{GatewayID: server.session.GatewayID, GatewayStatus: "Degraded"}
			if err := r.reconcileManagedSession(context.Background(), sdk, project, server.session); err != nil {
				t.Fatal(err)
			}
			server.mu.Lock()
			defer server.mu.Unlock()
			if len(server.calls) != 0 {
				t.Fatalf("active session used degraded gateway: %v", server.calls)
			}
		})
	}
}

func TestManagedDegradedCleanupChecksBindingAndRefreshesConnection(t *testing.T) {
	for _, mismatch := range []bool{true, false} {
		t.Run(fmt.Sprintf("mismatched-gateway=%t", mismatch), func(t *testing.T) {
			r, sdk, server, _ := newManagedSnapshotTest(t)
			project := types.Project{GatewayID: server.session.GatewayID, GatewayStatus: "Degraded", GatewayEndpoint: "https://updated.example", GatewayCredentialID: "new-credential"}
			if mismatch {
				project.GatewayID = "other-gateway"
			}
			err := r.reconcileManagedSession(context.Background(), sdk, project, server.session)
			if mismatch && err == nil {
				t.Fatal("gateway mismatch accepted")
			}
			if !mismatch && err != nil {
				t.Fatal(err)
			}
			server.mu.Lock()
			defer server.mu.Unlock()
			want := "persist"
			if mismatch {
				want = ""
			}
			if got := strings.Join(server.calls, ","); got != want {
				t.Fatalf("remote cleanup before binding validation or connection refresh: %s", got)
			}
		})
	}
}

func TestManagedLogSnapshotLimitPreservesNewestEscapedEntries(t *testing.T) {
	// This text is below 2 MiB, but JSON escaping expands it beyond the limit.
	text := strings.Repeat("<\"\n", 100000)
	logs := []map[string]interface{}{
		{"timestamp": 1, "message": text},
		{"timestamp": 2, "message": text},
		{"timestamp": 3, "message": text},
	}
	data, err := encodeManagedLogSnapshot(logs)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) > 2*1024*1024 {
		t.Fatalf("snapshot has %d encoded bytes", len(data))
	}
	var decoded []map[string]interface{}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded) != 3 || decoded[0]["level"] != "WARN" || decoded[1]["timestamp"] != float64(2) || decoded[2]["timestamp"] != float64(3) {
		t.Fatal("snapshot did not keep the newest two complete entries and omission warning")
	}
	if decoded[1]["message"] != text || decoded[2]["message"] != text || decoded[0]["fields"].(map[string]interface{})["omitted_entries"] != "1" {
		t.Fatal("retained entry text or omitted count changed")
	}
}

func TestManagedLogSnapshotOmitsOversizedEntryAndKeepsOtherLogs(t *testing.T) {
	logs := []map[string]interface{}{{"timestamp": 1, "message": "older small entry"}, {"timestamp": 2, "message": strings.Repeat("x", 2*1024*1024)}, {"timestamp": 3, "message": "newest entry"}}
	data, err := encodeManagedLogSnapshot(logs)
	if err != nil {
		t.Fatal(err)
	}
	var decoded []map[string]interface{}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(data) > 2*1024*1024 || len(decoded) != 3 || decoded[0]["level"] != "WARN" || decoded[1]["message"] != "older small entry" || decoded[2]["message"] != "newest entry" {
		t.Fatal("one oversized entry prevented other log capture")
	}
}

func TestManagedLogSnapshotNormalArrayUnchanged(t *testing.T) {
	logs := []map[string]interface{}{{"message": "ordinary log", "timestamp": 42}}
	want, err := json.Marshal(logs)
	if err != nil {
		t.Fatal(err)
	}
	got, err := encodeManagedLogSnapshot(logs)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatal("small snapshot contract changed")
	}
	got, err = encodeManagedLogSnapshot(nil)
	if err != nil || string(got) != "[]" {
		t.Fatal("empty snapshot contract changed")
	}
}

func TestManagedLargeSnapshotUsesOneCASBeforeStop(t *testing.T) {
	for _, conflict := range []bool{false, true} {
		t.Run(fmt.Sprintf("persist-conflict=%t", conflict), func(t *testing.T) {
			r, sdk, server, target := newManagedSnapshotTest(t)
			server.patchError = conflict
			for i := 0; i < 3; i++ {
				server.logs = append(server.logs, &pb.SandboxLogLine{TimestampMs: int64(i), Message: strings.Repeat("x", 800000)})
			}
			policy, err := openshell.BuildSnapshotPatch(server.sandbox)
			if err != nil {
				t.Fatal(err)
			}
			err = r.stopManagedSession(context.Background(), sdk, server.session, target)
			if (err != nil) != conflict {
				t.Fatalf("stop error=%v, conflict=%v", err, conflict)
			}
			server.mu.Lock()
			defer server.mu.Unlock()
			if server.patchAttempts != 1 {
				t.Fatalf("snapshot CAS attempts=%d, want 1", server.patchAttempts)
			}
			want := "logs,persist,stop"
			if conflict {
				want = "logs"
			}
			if strings.Join(server.calls, ",") != want {
				t.Fatalf("mutation order=%v", server.calls)
			}
			if !conflict {
				if len(server.session.SandboxLogsSnapshot) > 2*1024*1024 || !strings.Contains(server.session.SandboxLogsSnapshot, "omitted_entries") {
					t.Fatal("large snapshot was not bounded with a warning")
				}
				if server.session.SandboxPolicySnapshot != policy["sandbox_policy_snapshot"] {
					t.Fatal("log truncation changed policy snapshot")
				}
			}
		})
	}
}

func TestManagedLogSnapshotAcceptsExactAPILimit(t *testing.T) {
	entry := map[string]interface{}{"message": ""}
	base, err := json.Marshal([]map[string]interface{}{entry})
	if err != nil {
		t.Fatal(err)
	}
	entry["message"] = strings.Repeat("x", 2*1024*1024-len(base))
	data, err := encodeManagedLogSnapshot([]map[string]interface{}{entry})
	if err != nil {
		t.Fatal(err)
	}
	if len(data) != 2*1024*1024 || strings.Contains(string(data), "omitted_entries") {
		t.Fatal("snapshot at exact API byte limit was truncated")
	}
}

func TestManagedSnapshotUsesCurrentPolicyAndRetainsCreationPolicy(t *testing.T) {
	r, sdk, server, target := newManagedSnapshotTest(t)
	server.currentPolicy = &policypb.SandboxPolicy{Version: 9, NetworkPolicies: map[string]*policypb.NetworkPolicyRule{"changed": {Name: "current-rule"}}}
	response := &pb.SandboxResponse{Sandbox: server.sandbox}
	if _, err := r.saveManagedSnapshot(context.Background(), sdk, server.session, target, response); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(server.session.SandboxPolicySnapshot, "current-rule") {
		t.Fatal("snapshot kept the creation-time policy")
	}
	if response.Sandbox.Spec.Policy.Version != 4 {
		t.Fatal("snapshot changed the shared sandbox response")
	}
}

func TestManagedPolicySnapshotFailureKeepsCleanupPending(t *testing.T) {
	r, sdk, server, target := newManagedSnapshotTest(t)
	server.policyError = true
	if err := r.stopManagedSession(context.Background(), sdk, server.session, target); err == nil {
		t.Fatal("policy failure was ignored")
	}
	if len(server.calls) != 0 || server.patchAttempts != 0 {
		t.Fatalf("cleanup advanced after policy failure: %v", server.calls)
	}
}
