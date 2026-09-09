package openshell

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"math/big"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	datamodelpb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/datamodel/v1"
	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	"github.com/rs/zerolog"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// Fixed values used only by these tests.
const (
	testSSHIdentity         = "temporary-ssh-token"
	testGatewayPrefix       = "gateway-"
	testGlobalIdentity      = "must-not-use-global-token"
	testReplacementIdentity = "new-token"
)

type managedTestTokens struct {
	mu    sync.Mutex
	token string
	err   error
	calls int
}

func (t *managedTestTokens) Token(context.Context) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.calls++
	return t.token, t.err
}

type managedTestServer struct {
	pb.UnimplementedOpenShellServer
	mu         sync.Mutex
	calls      []string
	workspaces map[string]bool
	reject     bool
}

func (s *managedTestServer) record(ctx context.Context, operation, workspace string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	md, _ := metadata.FromIncomingContext(ctx)
	values := md.Get("authorization")
	if len(values) != 1 {
		return status.Error(codes.Unauthenticated, "expected one gateway credential")
	}
	s.calls = append(s.calls, operation+"|"+workspace+"|"+values[0])
	if s.reject {
		return status.Error(codes.Unauthenticated, "unknown signing key")
	}
	return nil
}
func (s *managedTestServer) GetSandbox(ctx context.Context, req *pb.GetSandboxRequest) (*pb.SandboxResponse, error) {
	if err := s.record(ctx, "get", req.Workspace); err != nil {
		return nil, err
	}
	return &pb.SandboxResponse{}, nil
}
func (s *managedTestServer) CreateSandbox(ctx context.Context, req *pb.CreateSandboxRequest) (*pb.SandboxResponse, error) {
	if err := s.record(ctx, "create", req.Workspace); err != nil {
		return nil, err
	}
	return &pb.SandboxResponse{}, nil
}
func (s *managedTestServer) CreateSshSession(ctx context.Context, _ *pb.CreateSshSessionRequest) (*pb.CreateSshSessionResponse, error) {
	if err := s.record(ctx, "ssh", ""); err != nil {
		return nil, err
	}
	return &pb.CreateSshSessionResponse{Token: testSSHIdentity}, nil
}
func (s *managedTestServer) ForwardTcp(stream grpc.BidiStreamingServer[pb.TcpForwardFrame, pb.TcpForwardFrame]) error {
	if err := s.record(stream.Context(), "forward", ""); err != nil {
		return err
	}
	if _, err := stream.Recv(); err != nil {
		return err
	}
	return status.Error(codes.PermissionDenied, "test relay rejects the SSH connection")
}
func (s *managedTestServer) GetWorkspace(ctx context.Context, req *pb.GetWorkspaceRequest) (*pb.GetWorkspaceResponse, error) {
	if err := s.record(ctx, "workspace-get", req.Name); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.workspaces[req.Name] {
		return nil, status.Error(codes.NotFound, "workspace is missing")
	}
	return &pb.GetWorkspaceResponse{Workspace: &datamodelpb.Workspace{Status: &datamodelpb.WorkspaceStatus{Phase: datamodelpb.WorkspacePhase_WORKSPACE_PHASE_ACTIVE}}}, nil
}
func (s *managedTestServer) CreateWorkspace(ctx context.Context, req *pb.CreateWorkspaceRequest) (*pb.CreateWorkspaceResponse, error) {
	if err := s.record(ctx, "workspace-create", req.Name); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.workspaces[req.Name] = true
	return &pb.CreateWorkspaceResponse{}, nil
}

func managedTestClient(t *testing.T) (*GatewayClient, *managedTestServer, map[string]GatewayTarget, *sync.Mutex) {
	t.Helper()
	server := &managedTestServer{workspaces: make(map[string]bool)}
	grpcServer := grpc.NewServer()
	pb.RegisterOpenShellServer(grpcServer, server)
	httpServer := httptest.NewUnstartedServer(grpcServer)
	httpServer.EnableHTTP2 = true
	httpServer.StartTLS()
	t.Cleanup(httpServer.Close)
	t.Cleanup(grpcServer.Stop)
	pool := x509.NewCertPool()
	pool.AddCert(httpServer.Certificate())
	targets := map[string]GatewayTarget{}
	for _, name := range []string{"a", "b"} {
		targets[TargetKey(testGatewayPrefix+name, "session-"+name)] = GatewayTarget{Endpoint: httpServer.URL, TLSConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}, TokenProvider: &managedTestTokens{token: testGatewayPrefix + name + "-token"}, Workspace: "session-" + name, Revision: "identity-" + name}
	}
	mu := &sync.Mutex{}
	client := NewGatewayClient("unused", 0, nil, "", zerolog.Nop(), WithTargetResolver(func(_ context.Context, key string) (GatewayTarget, error) {
		mu.Lock()
		defer mu.Unlock()
		target, ok := targets[key]
		if !ok {
			return GatewayTarget{}, errors.New("binding is missing")
		}
		return target, nil
	}), WithTokenProvider(&managedTestTokens{token: testGlobalIdentity}))
	t.Cleanup(func() { requireUploadNoError(t, client.Close()) })
	return client, server, targets, mu
}

func TestManagedTargetsUseDistinctCredentialsAndWorkspaces(t *testing.T) {
	client, server, _, _ := managedTestClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ctx = metadata.NewOutgoingContext(ctx, metadata.Pairs("authorization", "Bearer inherited-control-plane-token"))
	for _, name := range []string{"a", "b"} {
		if _, err := client.GetSandbox(ctx, TargetKey(testGatewayPrefix+name, "session-"+name), "same-name"); err != nil {
			t.Fatal(err)
		}
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	for i, expected := range []string{"get|session-a|Bearer gateway-a-token", "get|session-b|Bearer gateway-b-token"} {
		if server.calls[i] != expected {
			t.Fatalf("call %d = %q, want %q", i, server.calls[i], expected)
		}
	}
}

func TestManagedTargetsFailClosedOnTokenErrorAndRejectedToken(t *testing.T) {
	client, server, targets, mu := managedTestClient(t)
	key := TargetKey("gateway-a", "session-a")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	mu.Lock()
	tokens := targets[key].TokenProvider.(*managedTestTokens)
	mu.Unlock()
	tokens.mu.Lock()
	tokens.err = errors.New("token refresh failed with secret material")
	tokens.mu.Unlock()
	if _, err := client.GetSandbox(ctx, key, "sandbox"); err == nil || strings.Contains(err.Error(), "secret material") {
		t.Fatalf("token failure = %v", err)
	}
	server.mu.Lock()
	count := len(server.calls)
	server.mu.Unlock()
	if count != 0 {
		t.Fatal("RPC reached the server without a token")
	}
	tokens.mu.Lock()
	tokens.err = nil
	tokens.mu.Unlock()
	server.mu.Lock()
	server.reject = true
	server.mu.Unlock()
	if _, err := client.GetSandbox(ctx, key, "sandbox"); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("rejected token = %v", err)
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if len(server.calls) != 1 {
		t.Fatalf("rejected token caused %d calls", len(server.calls))
	}
	if _, downgraded := client.oidcNamespaces.Load(key); downgraded {
		t.Fatal("managed auth was downgraded")
	}
}

func TestManagedTargetRotationReplacesConnection(t *testing.T) {
	client, server, targets, mu := managedTestClient(t)
	key := TargetKey("gateway-a", "session-a")
	first, err := client.getOrCreateConn(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	same, err := client.getOrCreateConn(context.Background(), key)
	if err != nil || first != same {
		t.Fatal("unchanged target did not reuse connection")
	}
	mu.Lock()
	target := targets[key]
	target.Revision = "rotated-identity"
	target.TokenProvider = &managedTestTokens{token: testReplacementIdentity}
	targets[key] = target
	mu.Unlock()
	next, err := client.getOrCreateConn(context.Background(), key)
	if err != nil || first == next {
		t.Fatalf("credential rotation did not replace connection: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := client.GetSandbox(ctx, key, "sandbox"); err != nil {
		t.Fatal(err)
	}
	server.mu.Lock()
	lastCall := server.calls[len(server.calls)-1]
	server.mu.Unlock()
	if lastCall != "get|session-a|Bearer new-token" {
		t.Fatalf("rotated identity call = %q", lastCall)
	}
	mu.Lock()
	target.Endpoint = "https://different-gateway.example:443"
	targets[key] = target
	mu.Unlock()
	changedEndpoint, err := client.getOrCreateConn(context.Background(), key)
	if err != nil || next == changedEndpoint {
		t.Fatalf("endpoint change did not replace connection: %v", err)
	}
}

func TestManagedTargetRejectsUnverifiedTLSAndWorkspaceMismatch(t *testing.T) {
	client, _, targets, mu := managedTestClient(t)
	key := TargetKey("gateway-a", "session-a")
	mu.Lock()
	base := targets[key]
	mu.Unlock()
	cases := []struct {
		name   string
		change func(*GatewayTarget)
	}{
		{"missing TLS", func(t *GatewayTarget) { t.TLSConfig = nil }},
		{"insecure TLS", func(t *GatewayTarget) { t.TLSConfig = &tls.Config{InsecureSkipVerify: true} }},
		{"wrong TLS authority", func(t *GatewayTarget) { t.TLSConfig = &tls.Config{ServerName: "other.example"} }},
		{"HTTP endpoint", func(t *GatewayTarget) { t.Endpoint = "http://gateway.example:8080" }},
		{"missing identity", func(t *GatewayTarget) { t.Revision = "" }},
		{"missing token provider", func(t *GatewayTarget) { t.TokenProvider = nil }},
		{"wrong workspace", func(t *GatewayTarget) { t.Workspace = "other-session" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			target := base
			tc.change(&target)
			mu.Lock()
			targets[key] = target
			mu.Unlock()
			if _, err := client.getOrCreateConn(context.Background(), key); err == nil {
				t.Fatal("accepted invalid target")
			}
		})
	}
}

func TestManagedTargetVerifiesServerCertificate(t *testing.T) {
	client, server, targets, mu := managedTestClient(t)
	key := TargetKey("gateway-a", "session-a")
	mu.Lock()
	target := targets[key]
	target.TLSConfig = &tls.Config{RootCAs: x509.NewCertPool()}
	targets[key] = target
	mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := client.GetSandbox(ctx, key, "sandbox"); err == nil {
		t.Fatal("untrusted TLS server was accepted")
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if len(server.calls) != 0 {
		t.Fatal("credentials were sent to an untrusted server")
	}
}

func TestManagedWorkspaceInjectionDoesNotMutateRequest(t *testing.T) {
	client, server, _, _ := managedTestClient(t)
	key := TargetKey("gateway-a", "session-a")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req := &pb.CreateSandboxRequest{Name: "sandbox"}
	if _, err := client.CreateSandbox(ctx, key, req); err != nil {
		t.Fatal(err)
	}
	if req.Workspace != "" {
		t.Fatal("workspace injection mutated caller request")
	}
	req.Workspace = "session-b"
	if _, err := client.CreateSandbox(ctx, key, req); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("cross-workspace request = %v", err)
	}
	if err := client.EnsureWorkspace(ctx, key, "session-a"); err != nil {
		t.Fatal(err)
	}
	if err := client.EnsureWorkspace(ctx, key, "session-a"); err != nil {
		t.Fatal(err)
	}
	if err := client.EnsureWorkspace(ctx, key, "session-b"); err == nil {
		t.Fatal("created a workspace outside the target")
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	count := 0
	for _, call := range server.calls {
		if strings.HasPrefix(call, "workspace-create|") {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("workspace created %d times", count)
	}
}

func TestManagedUploadUsesTargetCredentialsForSSHAndForwarding(t *testing.T) {
	client, server, _, _ := managedTestClient(t)
	key := TargetKey("gateway-b", "session-b")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.UploadPayloads(ctx, key, "sandbox-id", nil); err == nil {
		t.Fatal("test relay should reject SSH")
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	expected := []string{"ssh||Bearer gateway-b-token", "forward||Bearer gateway-b-token"}
	if len(server.calls) != len(expected) {
		t.Fatalf("upload calls = %v", server.calls)
	}
	for i := range expected {
		if server.calls[i] != expected[i] {
			t.Fatalf("upload call = %q", server.calls[i])
		}
	}
}

func TestManagedEndpointAndTargetKey(t *testing.T) {
	for input, expected := range map[string]string{"https://gateway.example": "dns:///gateway.example:443", "gateway.example:8443": "dns:///gateway.example:8443", "https://gateway.example:8443/": "dns:///gateway.example:8443", "[::1]:443": "dns:///[::1]:443"} {
		got, err := normalizeGatewayEndpoint(input)
		if err != nil || got != expected {
			t.Errorf("endpoint %q = %q, %v", input, got, err)
		}
	}
	for _, invalid := range []string{"https://user:password@gateway.example", "https://gateway.example/path", "https://gateway.example?token=secret", "dns:///gateway.example", "gateway.example", "gateway.example:0"} {
		if _, err := normalizeGatewayEndpoint(invalid); err == nil {
			t.Errorf("accepted %q", invalid)
		}
	}
	key := TargetKey("gateway:one", "workspace:two")
	gateway, workspace, err := ParseTargetKey(key)
	if err != nil || gateway != "gateway:one" || workspace != "workspace:two" {
		t.Fatalf("key round trip = %s %s %v", gateway, workspace, err)
	}
	if TargetKey("a:b", "c") == TargetKey("a", "b:c") {
		t.Fatal("target keys collide")
	}
}

func TestManagedTargetRotatesCAWithSameSubject(t *testing.T) {
	client, _, targets, mu := managedTestClient(t)
	key := TargetKey("gateway-a", "session-a")
	newPool := func() *x509.CertPool {
		public, private, err := ed25519.GenerateKey(rand.Reader)
		requireUploadNoError(t, err)
		template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "same-ca-subject"}, IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
		der, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
		requireUploadNoError(t, err)
		cert, err := x509.ParseCertificate(der)
		requireUploadNoError(t, err)
		pool := x509.NewCertPool()
		pool.AddCert(cert)
		return pool
	}
	setPool := func(pool *x509.CertPool) {
		mu.Lock()
		defer mu.Unlock()
		target := targets[key]
		target.TLSConfig = target.TLSConfig.Clone()
		target.TLSConfig.RootCAs = pool
		targets[key] = target
	}
	pool := newPool()
	setPool(pool)
	first, err := client.managedConn(context.Background(), key)
	requireUploadNoError(t, err)
	setPool(pool.Clone())
	same, err := client.managedConn(context.Background(), key)
	requireUploadNoError(t, err)
	if same != first {
		t.Fatal("equivalent CA pools should reuse the connection")
	}
	setPool(newPool())
	rotated, err := client.managedConn(context.Background(), key)
	requireUploadNoError(t, err)
	if rotated == first {
		t.Fatal("a new CA key with the same subject must invalidate the connection")
	}
}
