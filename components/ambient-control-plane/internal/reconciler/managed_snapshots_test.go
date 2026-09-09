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
	calls                []string
	session              types.Session
}

func (s *managedSnapshotServer) GetSandbox(context.Context, *pb.GetSandboxRequest) (*pb.SandboxResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return &pb.SandboxResponse{Sandbox: s.sandbox}, nil
}
func (s *managedSnapshotServer) WatchSandbox(req *pb.WatchSandboxRequest, stream grpc.ServerStreamingServer[pb.SandboxStreamEvent]) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, "logs")
	if req.Id != "sandbox-id" || req.FollowLogs || req.LogTailLines != openshell.LogTailLines {
		return status.Error(codes.InvalidArgument, "incorrect snapshot request")
	}
	if err := stream.Send(&pb.SandboxStreamEvent{Payload: &pb.SandboxStreamEvent_Log{Log: &pb.SandboxLogLine{TimestampMs: 42, Source: "sandbox", Level: "INFO", Target: "network", Message: "provider request allowed", Fields: map[string]string{"provider": "session-provider", "action": "allow", "dst_host": "model.example"}}}}); err != nil {
		return err
	}
	if s.logError {
		return status.Error(codes.Unavailable, "log collection failed after partial result")
	}
	return nil
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
