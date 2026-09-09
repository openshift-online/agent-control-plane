package middleware

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/openshift-online/agent-control-plane/components/ambient-api-server/pkg/api/grpc/ambient/v1"
	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/pkg/runnerauth"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type runnerTestHandler struct {
	pb.UnimplementedSessionServiceServer
	calls int
}

func (h *runnerTestHandler) PushSessionMessage(ctx context.Context, r *pb.PushSessionMessageRequest) (*pb.SessionMessage, error) {
	h.calls++
	return &pb.SessionMessage{SessionId: r.SessionId}, nil
}
func (h *runnerTestHandler) WatchSessionMessages(r *pb.WatchSessionMessagesRequest, s grpc.ServerStreamingServer[pb.SessionMessage]) error {
	if err := s.Send(&pb.SessionMessage{SessionId: r.SessionId}); err != nil {
		return err
	}
	<-s.Context().Done()
	return nil
}

type runnerTestStream struct {
	grpc.ServerStream
	sessionID string
	sent      int
}

func (s *runnerTestStream) Context() context.Context { return context.Background() }
func (s *runnerTestStream) RecvMsg(m interface{}) error {
	m.(*pb.WatchSessionMessagesRequest).SessionId = s.sessionID
	return nil
}
func (s *runnerTestStream) SendMsg(m interface{}) error { s.sent++; return nil }

func TestRunnerDispatchRestrictsSessionAndMethods(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	claims := runnerauth.Claims{Purpose: "access", SessionID: "session-a", ProjectID: "project-a", SandboxName: "sandbox-a", Generation: "run-a", IssuedAt: time.Now().Unix(), ExpiresAt: time.Now().Add(time.Minute).Unix()}
	token, err := runnerauth.Sign(key, claims)
	if err != nil {
		t.Fatal(err)
	}
	handler := &runnerTestHandler{}
	revoked := false
	d := &RunnerDispatch{PublicKey: &key.PublicKey, Handler: handler, Validate: func(ctx context.Context, c runnerauth.Claims) error {
		if revoked {
			return fmt.Errorf("revoked")
		}
		return nil
	}}
	for _, tc := range []struct {
		name, method, session string
		want                  codes.Code
	}{
		{"own message", pb.SessionService_PushSessionMessage_FullMethodName, "session-a", codes.OK},
		{"other session", pb.SessionService_PushSessionMessage_FullMethodName, "session-b", codes.PermissionDenied},
		{"create session", pb.SessionService_CreateSession_FullMethodName, "session-a", codes.PermissionDenied},
		{"list sessions", pb.SessionService_ListSessions_FullMethodName, "session-a", codes.PermissionDenied},
		{"status mutation", pb.SessionService_UpdateSessionStatus_FullMethodName, "session-a", codes.PermissionDenied},
		{"credential", "/ambient.v1.CredentialService/GetCredential", "session-a", codes.PermissionDenied},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := d.Unary(context.Background(), token, &pb.PushSessionMessageRequest{SessionId: tc.session}, tc.method)
			if status.Code(err) != tc.want {
				t.Fatalf("got %v want %v", err, tc.want)
			}
		})
	}
	if handler.calls != 1 {
		t.Fatal("forbidden calls reached handler")
	}
	revoked = true
	if _, err := d.Unary(context.Background(), token, &pb.PushSessionMessageRequest{SessionId: "session-a"}, pb.SessionService_PushSessionMessage_FullMethodName); status.Code(err) != codes.PermissionDenied {
		t.Fatal("revoked token accepted")
	}
	claims.Purpose = "bootstrap"
	bootstrap, err := runnerauth.Sign(key, claims)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Unary(context.Background(), bootstrap, &pb.PushSessionMessageRequest{SessionId: "session-a"}, pb.SessionService_PushSessionMessage_FullMethodName); status.Code(err) != codes.Unauthenticated {
		t.Fatal("bootstrap accepted for API")
	}
}

func TestRunnerStreamRevocation(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	claims := runnerauth.Claims{Purpose: "access", SessionID: "session-a", ProjectID: "project-a", SandboxName: "sandbox-a", Generation: "run-a", IssuedAt: time.Now().Unix(), ExpiresAt: time.Now().Add(time.Minute).Unix()}
	token, err := runnerauth.Sign(key, claims)
	if err != nil {
		t.Fatal(err)
	}
	var validations atomic.Int32
	d := &RunnerDispatch{PublicKey: &key.PublicKey, Handler: &runnerTestHandler{}, Validate: func(ctx context.Context, c runnerauth.Claims) error {
		if validations.Add(1) > 2 {
			return fmt.Errorf("revoked")
		}
		return nil
	}}
	if err := d.Stream(token, &runnerTestStream{sessionID: "session-b"}, pb.SessionService_WatchSessionMessages_FullMethodName); status.Code(err) != codes.PermissionDenied {
		t.Fatal("other session stream allowed")
	}
	validations.Store(0)
	done := make(chan error, 1)
	stream := &runnerTestStream{sessionID: "session-a"}
	go func() { done <- d.Stream(token, stream, pb.SessionService_WatchSessionMessages_FullMethodName) }()
	select {
	case err := <-done:
		if status.Code(err) != codes.Unauthenticated {
			t.Fatalf("revocation: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("quiet revoked stream did not close")
	}
	if stream.sent != 1 {
		t.Fatalf("sent %d messages", stream.sent)
	}
}

func TestRunnerHTTPDenied(t *testing.T) {
	handler := RejectRunnerHTTP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Fatal("runner reached HTTP handler") }))
	for _, header := range []string{"Authorization", "X-Forwarded-Access-Token"} {
		req := httptest.NewRequest(http.MethodGet, "/api/ambient/v1/credentials", nil)
		value := runnerauth.Prefix + "test"
		if header == "Authorization" {
			value = "Bearer " + value
		}
		req.Header.Set(header, value)
		out := httptest.NewRecorder()
		handler.ServeHTTP(out, req)
		if out.Code != http.StatusForbidden {
			t.Fatal("runner HTTP access allowed")
		}
	}
}
