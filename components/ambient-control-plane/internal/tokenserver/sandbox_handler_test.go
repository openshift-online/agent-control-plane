package tokenserver

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	dmv1 "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/datamodel/v1"
	sbv1 "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/sandbox/v1"
	pb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	"github.com/rs/zerolog"
	"google.golang.org/grpc"
)

type mockSandboxGateway struct {
	getSandboxFn   func(ctx context.Context, namespace, name string) (*pb.SandboxResponse, error)
	watchSandboxFn func(ctx context.Context, namespace string, req *pb.WatchSandboxRequest) (pb.OpenShell_WatchSandboxClient, error)
}

func (m *mockSandboxGateway) GetSandbox(ctx context.Context, namespace, name string) (*pb.SandboxResponse, error) {
	return m.getSandboxFn(ctx, namespace, name)
}

func (m *mockSandboxGateway) WatchSandbox(ctx context.Context, namespace string, req *pb.WatchSandboxRequest) (pb.OpenShell_WatchSandboxClient, error) {
	return m.watchSandboxFn(ctx, namespace, req)
}

type mockWatchStream struct {
	grpc.ClientStream
	events []*pb.SandboxStreamEvent
	index  int
}

func (m *mockWatchStream) Recv() (*pb.SandboxStreamEvent, error) {
	if m.index >= len(m.events) {
		return nil, io.EOF
	}
	e := m.events[m.index]
	m.index++
	return e, nil
}

func newTestSandboxHandler(gw SandboxGateway) *sandboxHandler {
	return &sandboxHandler{
		gateway: gw,
		logger:  zerolog.Nop(),
	}
}

func makeSandboxResponse(id, name string) *pb.SandboxResponse {
	return &pb.SandboxResponse{
		Sandbox: &pb.Sandbox{
			Metadata: &dmv1.ObjectMeta{
				Id:   id,
				Name: name,
			},
			Spec:   &pb.SandboxSpec{Policy: &sbv1.SandboxPolicy{Version: 1}},
			Status: &pb.SandboxStatus{Phase: pb.SandboxPhase_SANDBOX_PHASE_READY},
		},
	}
}

func TestHandleLogs_ResolvesNameToUUID(t *testing.T) {
	const sandboxName = "session-abc123"
	const sandboxUUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

	var capturedReq *pb.WatchSandboxRequest
	gw := &mockSandboxGateway{
		getSandboxFn: func(_ context.Context, _, name string) (*pb.SandboxResponse, error) {
			if name != sandboxName {
				t.Errorf("GetSandbox called with name %q, want %q", name, sandboxName)
			}
			return makeSandboxResponse(sandboxUUID, sandboxName), nil
		},
		watchSandboxFn: func(_ context.Context, _ string, req *pb.WatchSandboxRequest) (pb.OpenShell_WatchSandboxClient, error) {
			capturedReq = req
			return &mockWatchStream{events: []*pb.SandboxStreamEvent{
				{Payload: &pb.SandboxStreamEvent_Log{Log: &pb.SandboxLogLine{
					TimestampMs: 1000, Source: "gateway", Level: "INFO", Message: "test log",
				}}},
			}}, nil
		},
	}

	h := newTestSandboxHandler(gw)
	req := httptest.NewRequest(http.MethodGet, "/sandbox/"+sandboxName+"/logs?namespace=tenant-a", nil)
	rr := httptest.NewRecorder()

	h.handleLogs(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: got %d, want %d — body: %s", rr.Code, http.StatusOK, rr.Body.String())
	}

	if capturedReq == nil {
		t.Fatal("WatchSandbox was never called")
	}
	if capturedReq.Id != sandboxUUID {
		t.Errorf("WatchSandbox called with Id %q, want UUID %q", capturedReq.Id, sandboxUUID)
	}
	if !capturedReq.FollowLogs {
		t.Error("WatchSandbox: FollowLogs should be true")
	}
	if !capturedReq.FollowEvents {
		t.Error("WatchSandbox: FollowEvents should be true")
	}
	if capturedReq.LogTailLines == 0 {
		t.Error("WatchSandbox: LogTailLines should be > 0")
	}
}

func TestHandleLogs_SSEFormat(t *testing.T) {
	gw := &mockSandboxGateway{
		getSandboxFn: func(context.Context, string, string) (*pb.SandboxResponse, error) {
			return makeSandboxResponse("uuid-1", "session-test"), nil
		},
		watchSandboxFn: func(context.Context, string, *pb.WatchSandboxRequest) (pb.OpenShell_WatchSandboxClient, error) {
			return &mockWatchStream{events: []*pb.SandboxStreamEvent{
				{Payload: &pb.SandboxStreamEvent_Log{Log: &pb.SandboxLogLine{
					TimestampMs: 1000, Source: "sandbox", Level: "INFO", Message: "hello",
				}}},
				{Payload: &pb.SandboxStreamEvent_Sandbox{Sandbox: &pb.Sandbox{
					Status: &pb.SandboxStatus{Phase: pb.SandboxPhase_SANDBOX_PHASE_READY, SandboxName: "session-test"},
				}}},
				{Payload: &pb.SandboxStreamEvent_Event{Event: &pb.PlatformEvent{
					TimestampMs: 2000, Source: "k8s", Type: "Normal", Reason: "Scheduled", Message: "pod scheduled",
				}}},
				{Payload: &pb.SandboxStreamEvent_Warning{Warning: &pb.SandboxStreamWarning{
					Message: "disk pressure",
				}}},
			}}, nil
		},
	}

	h := newTestSandboxHandler(gw)
	req := httptest.NewRequest(http.MethodGet, "/sandbox/session-test/logs?namespace=ns", nil)
	rr := httptest.NewRecorder()

	h.handleLogs(rr, req)

	body := rr.Body.String()

	expectedEvents := []struct {
		eventType string
		field     string
	}{
		{"log", "message"},
		{"status", "phase"},
		{"platform_event", "reason"},
		{"warning", "message"},
	}

	for _, exp := range expectedEvents {
		marker := fmt.Sprintf("event: %s\n", exp.eventType)
		if !strings.Contains(body, marker) {
			t.Errorf("response missing %q event", exp.eventType)
			continue
		}
		idx := strings.Index(body, marker)
		rest := body[idx+len(marker):]
		dataLine := strings.SplitN(rest, "\n", 2)[0]
		if !strings.HasPrefix(dataLine, "data: ") {
			t.Errorf("event %q: expected data line after event, got %q", exp.eventType, dataLine)
			continue
		}
		jsonStr := strings.TrimPrefix(dataLine, "data: ")
		var parsed map[string]interface{}
		if err := json.Unmarshal([]byte(jsonStr), &parsed); err != nil {
			t.Errorf("event %q: invalid JSON: %v", exp.eventType, err)
			continue
		}
		if _, ok := parsed[exp.field]; !ok {
			t.Errorf("event %q: JSON missing field %q: %s", exp.eventType, exp.field, jsonStr)
		}
	}

	if ct := rr.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Content-Type: got %q, want %q", ct, "text/event-stream")
	}
}

func TestHandleLogs_GetSandboxNotFound(t *testing.T) {
	gw := &mockSandboxGateway{
		getSandboxFn: func(context.Context, string, string) (*pb.SandboxResponse, error) {
			return &pb.SandboxResponse{Sandbox: nil}, nil
		},
		watchSandboxFn: func(context.Context, string, *pb.WatchSandboxRequest) (pb.OpenShell_WatchSandboxClient, error) {
			t.Fatal("WatchSandbox should not be called when GetSandbox returns nil")
			return nil, nil
		},
	}

	h := newTestSandboxHandler(gw)
	req := httptest.NewRequest(http.MethodGet, "/sandbox/nonexistent/logs?namespace=ns", nil)
	rr := httptest.NewRecorder()

	h.handleLogs(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Errorf("status: got %d, want %d", rr.Code, http.StatusNotFound)
	}
}

func TestHandleLogs_GetSandboxError(t *testing.T) {
	gw := &mockSandboxGateway{
		getSandboxFn: func(context.Context, string, string) (*pb.SandboxResponse, error) {
			return nil, fmt.Errorf("gateway unreachable")
		},
		watchSandboxFn: func(context.Context, string, *pb.WatchSandboxRequest) (pb.OpenShell_WatchSandboxClient, error) {
			t.Fatal("WatchSandbox should not be called when GetSandbox fails")
			return nil, nil
		},
	}

	h := newTestSandboxHandler(gw)
	req := httptest.NewRequest(http.MethodGet, "/sandbox/session-x/logs?namespace=ns", nil)
	rr := httptest.NewRecorder()

	h.handleLogs(rr, req)

	if rr.Code != http.StatusBadGateway {
		t.Errorf("status: got %d, want %d", rr.Code, http.StatusBadGateway)
	}
}

func TestHandleLogs_MissingNamespace(t *testing.T) {
	h := newTestSandboxHandler(&mockSandboxGateway{})
	req := httptest.NewRequest(http.MethodGet, "/sandbox/session-x/logs", nil)
	rr := httptest.NewRecorder()

	h.handleLogs(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("status: got %d, want %d", rr.Code, http.StatusBadRequest)
	}
}

func TestHandleLogs_MethodNotAllowed(t *testing.T) {
	h := newTestSandboxHandler(&mockSandboxGateway{})
	req := httptest.NewRequest(http.MethodPost, "/sandbox/session-x/logs?namespace=ns", nil)
	rr := httptest.NewRecorder()

	h.handleLogs(rr, req)

	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("status: got %d, want %d", rr.Code, http.StatusMethodNotAllowed)
	}
}

func TestHandlePolicy_Success(t *testing.T) {
	gw := &mockSandboxGateway{
		getSandboxFn: func(context.Context, string, string) (*pb.SandboxResponse, error) {
			return makeSandboxResponse("uuid-1", "session-pol"), nil
		},
	}

	h := newTestSandboxHandler(gw)
	req := httptest.NewRequest(http.MethodGet, "/sandbox/session-pol/policy?namespace=ns", nil)
	rr := httptest.NewRecorder()

	h.handlePolicy(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: got %d, want %d — body: %s", rr.Code, http.StatusOK, rr.Body.String())
	}

	var result map[string]interface{}
	if err := json.Unmarshal(rr.Body.Bytes(), &result); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}

	for _, field := range []string{"version", "status", "source", "policy", "config_revision"} {
		if _, ok := result[field]; !ok {
			t.Errorf("response missing field %q", field)
		}
	}

	if result["status"] != "active" {
		t.Errorf("status: got %q, want %q", result["status"], "active")
	}
}

func TestParseSandboxPath(t *testing.T) {
	cases := []struct {
		path      string
		suffix    string
		wantName  string
		wantEmpty bool
	}{
		{"/sandbox/session-abc123/logs", "logs", "session-abc123", false},
		{"/sandbox/session-abc123/policy", "policy", "session-abc123", false},
		{"/sandbox//logs", "logs", "", true},
		{"/sandbox/a/b/logs", "logs", "", true},
	}
	for _, tc := range cases {
		name, _ := parseSandboxPath(tc.path, tc.suffix)
		if tc.wantEmpty && name != "" {
			t.Errorf("parseSandboxPath(%q, %q) = %q, want empty", tc.path, tc.suffix, name)
		}
		if !tc.wantEmpty && name != tc.wantName {
			t.Errorf("parseSandboxPath(%q, %q) = %q, want %q", tc.path, tc.suffix, name, tc.wantName)
		}
	}
}
