package middleware

import (
	"context"
	"crypto/rsa"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	pb "github.com/openshift-online/agent-control-plane/components/ambient-api-server/pkg/api/grpc/ambient/v1"
	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/pkg/runnerauth"
	pkgserver "github.com/openshift-online/rh-trex-ai/pkg/server"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// RunnerDispatch is a separate authentication path. It calls only three session
// methods after signature and database scope checks. Runner credentials never
// enter the user OIDC path or receive platform service account rights.
type RunnerDispatch struct {
	PublicKey *rsa.PublicKey
	Handler   pb.SessionServiceServer
	Validate  func(context.Context, runnerauth.Claims) error
}

var runnerDispatch struct {
	sync.RWMutex
	value *RunnerDispatch
}

func ConfigureRunnerDispatch(h pb.SessionServiceServer, validate func(context.Context, runnerauth.Claims) error) error {
	path := os.Getenv("AMBIENT_RUNNER_PUBLIC_KEY_FILE")
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read runner public key: %w", err)
	}
	key, err := runnerauth.ParsePublicKey(data)
	if err != nil {
		return err
	}
	runnerDispatch.Lock()
	defer runnerDispatch.Unlock()
	runnerDispatch.value = &RunnerDispatch{PublicKey: key, Handler: h, Validate: validate}
	return nil
}

func init() {
	pkgserver.RegisterPreAuthGRPCUnaryInterceptor(func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, next grpc.UnaryHandler) (interface{}, error) {
		token := runnerBearer(ctx)
		if !strings.HasPrefix(token, runnerauth.Prefix) {
			return next(ctx, req)
		}
		runnerDispatch.RLock()
		d := runnerDispatch.value
		runnerDispatch.RUnlock()
		return d.Unary(ctx, token, req, info.FullMethod)
	})
	pkgserver.RegisterPreAuthGRPCStreamInterceptor(func(srv interface{}, ss grpc.ServerStream, info *grpc.StreamServerInfo, next grpc.StreamHandler) error {
		token := runnerBearer(ss.Context())
		if !strings.HasPrefix(token, runnerauth.Prefix) {
			return next(srv, ss)
		}
		runnerDispatch.RLock()
		d := runnerDispatch.value
		runnerDispatch.RUnlock()
		return d.Stream(token, ss, info.FullMethod)
	})
}

func runnerBearer(ctx context.Context) string {
	md, _ := metadata.FromIncomingContext(ctx)
	values := md.Get("authorization")
	if len(values) != 1 {
		for _, value := range values {
			token, _ := extractBearerToken(value)
			if strings.HasPrefix(token, runnerauth.Prefix) {
				return runnerauth.Prefix + "invalid"
			}
		}
		return ""
	}
	token, _ := extractBearerToken(values[0])
	return token
}

// RejectRunnerHTTP must run before headers are sanitized and user JWT auth.
func RejectRunnerHTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, _ := extractBearerToken(r.Header.Get("Authorization"))
		if strings.HasPrefix(token, runnerauth.Prefix) || strings.HasPrefix(r.Header.Get(forwardedAccessTokenHeader), runnerauth.Prefix) {
			http.Error(w, "runner token cannot access HTTP API", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (d *RunnerDispatch) claims(ctx context.Context, token string) (runnerauth.Claims, error) {
	if d == nil || d.Handler == nil || d.Validate == nil {
		return runnerauth.Claims{}, status.Error(codes.Unauthenticated, "runner authentication is not configured")
	}
	c, err := runnerauth.Verify(d.PublicKey, token, "access", time.Now())
	if err != nil {
		return c, status.Error(codes.Unauthenticated, "invalid runner token")
	}
	if err := d.Validate(ctx, c); err != nil {
		return c, status.Error(codes.PermissionDenied, "runner access revoked")
	}
	return c, nil
}

func (d *RunnerDispatch) Unary(ctx context.Context, token string, req interface{}, method string) (interface{}, error) {
	c, err := d.claims(ctx, token)
	if err != nil {
		return nil, err
	}
	// This marker is used only within the fixed dispatch below. The caller cannot
	// reach a general service handler with it.
	ctx = WithCallerType(ctx, CallerTypeService)
	switch method {
	case pb.SessionService_PushSessionMessage_FullMethodName:
		r, ok := req.(*pb.PushSessionMessageRequest)
		if !ok || r.GetSessionId() != c.SessionID {
			return nil, status.Error(codes.PermissionDenied, "runner session mismatch")
		}
		return d.Handler.PushSessionMessage(ctx, r)
	case pb.SessionService_PushSessionEvent_FullMethodName:
		r, ok := req.(*pb.PushSessionEventRequest)
		if !ok || r.GetSessionId() != c.SessionID {
			return nil, status.Error(codes.PermissionDenied, "runner session mismatch")
		}
		return d.Handler.PushSessionEvent(ctx, r)
	default:
		return nil, status.Error(codes.PermissionDenied, "method not permitted for runners")
	}
}

func (d *RunnerDispatch) Stream(token string, ss grpc.ServerStream, method string) error {
	c, err := d.claims(ss.Context(), token)
	if err != nil {
		return err
	}
	if method != pb.SessionService_WatchSessionMessages_FullMethodName {
		return status.Error(codes.PermissionDenied, "method not permitted for runners")
	}
	var req pb.WatchSessionMessagesRequest
	if err := ss.RecvMsg(&req); err != nil {
		return err
	}
	if req.GetSessionId() != c.SessionID {
		return status.Error(codes.PermissionDenied, "runner session mismatch")
	}
	ctx, cancel := context.WithDeadline(WithCallerType(ss.Context(), CallerTypeService), time.Unix(c.ExpiresAt, 0))
	defer cancel()
	// Recheck a quiet stream so deletion, stop, and restart revoke a connection.
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := d.Validate(ctx, c); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	wrapped := &runnerStream{ServerStream: ss, ctx: ctx, validate: func() error {
		if err := c.Validate("access", time.Now()); err != nil {
			return status.Error(codes.Unauthenticated, "runner token expired")
		}
		if err := d.Validate(ctx, c); err != nil {
			return status.Error(codes.PermissionDenied, "runner access revoked")
		}
		return nil
	}}
	err = d.Handler.WatchSessionMessages(&req, &grpc.GenericServerStream[pb.WatchSessionMessagesRequest, pb.SessionMessage]{ServerStream: wrapped})
	if ctx.Err() != nil {
		return status.Error(codes.Unauthenticated, "runner stream authorization ended")
	}
	return err
}

type runnerStream struct {
	grpc.ServerStream
	ctx      context.Context
	validate func() error
}

func (s *runnerStream) Context() context.Context { return s.ctx }
func (s *runnerStream) SendMsg(m interface{}) error {
	if err := s.validate(); err != nil {
		return err
	}
	return s.ServerStream.SendMsg(m)
}
