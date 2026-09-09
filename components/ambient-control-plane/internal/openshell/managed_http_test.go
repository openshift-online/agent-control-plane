package openshell

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net/http/httptest"
	"testing"
	"time"

	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	"github.com/rs/zerolog"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type runnerRelayServer struct {
	pb.UnimplementedOpenShellServer
	t      *testing.T
	opened chan struct{}
	closed chan struct{}
}

func (s *runnerRelayServer) auth(ctx context.Context) error {
	md, _ := metadata.FromIncomingContext(ctx)
	values := md.Get("authorization")
	if len(values) != 1 || values[0] != "Bearer gateway-b-token" {
		return status.Error(codes.Unauthenticated, "wrong gateway account")
	}
	return nil
}
func (s *runnerRelayServer) CreateSshSession(ctx context.Context, r *pb.CreateSshSessionRequest) (*pb.CreateSshSessionResponse, error) {
	if err := s.auth(ctx); err != nil {
		return nil, err
	}
	if r.SandboxId != "sandbox-b" {
		return nil, status.Error(codes.PermissionDenied, "wrong sandbox")
	}
	return &pb.CreateSshSessionResponse{Token: "test-relay-token"}, nil
}
func (s *runnerRelayServer) ForwardTcp(stream grpc.BidiStreamingServer[pb.TcpForwardFrame, pb.TcpForwardFrame]) error {
	if err := s.auth(stream.Context()); err != nil {
		return err
	}
	frame, err := stream.Recv()
	if err != nil {
		return err
	}
	init := frame.GetInit()
	if init.GetSandboxId() != "sandbox-b" || init.GetTcp().GetHost() != "127.0.0.1" || init.GetTcp().GetPort() != 8001 || init.GetAuthorizationToken() != "test-relay-token" {
		s.t.Error("invalid runner relay destination or capability")
		return status.Error(codes.PermissionDenied, "invalid relay")
	}
	frame, err = stream.Recv()
	if err != nil {
		return err
	}
	if string(frame.GetData()) != "request" {
		s.t.Error("request data changed")
	}
	if err := stream.Send(&pb.TcpForwardFrame{Payload: &pb.TcpForwardFrame_Data{Data: []byte("response")}}); err != nil {
		return err
	}
	close(s.opened)
	<-stream.Context().Done()
	close(s.closed)
	return stream.Context().Err()
}
func TestManagedRunnerRelayUsesScopedAuthAndClosesStream(t *testing.T) {
	server := &runnerRelayServer{t: t, opened: make(chan struct{}), closed: make(chan struct{})}
	grpcServer := grpc.NewServer()
	pb.RegisterOpenShellServer(grpcServer, server)
	endpoint := httptest.NewUnstartedServer(grpcServer)
	endpoint.EnableHTTP2 = true
	endpoint.StartTLS()
	defer endpoint.Close()
	defer grpcServer.Stop()
	roots := x509.NewCertPool()
	roots.AddCert(endpoint.Certificate())
	client := NewGatewayClient("unused", 0, nil, "", zerolog.Nop(), WithTargetResolver(func(_ context.Context, key string) (GatewayTarget, error) {
		if key != TargetKey("gateway-b", "workspace-b") {
			t.Error("wrong target")
		}
		return GatewayTarget{Endpoint: endpoint.URL, TLSConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}, TokenProvider: &managedTestTokens{token: "gateway-b-token"}, Workspace: "workspace-b", Revision: "test"}, nil
	}))
	defer func() {
		if err := client.Close(); err != nil {
			t.Error(err)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ctx = metadata.NewOutgoingContext(ctx, metadata.Pairs("authorization", "Bearer user-token"))
	conn, err := client.DialRunner(ctx, TargetKey("gateway-b", "workspace-b"), "sandbox-b")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Write([]byte("request")); err != nil {
		t.Fatal(err)
	}
	data := make([]byte, 8)
	if _, err := io.ReadFull(conn, data); err != nil {
		t.Fatal(err)
	}
	if string(data) != "response" {
		t.Fatal("response changed")
	}
	<-server.opened
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-server.closed:
	case <-ctx.Done():
		t.Fatal("runner relay did not close after request ended")
	}
}
