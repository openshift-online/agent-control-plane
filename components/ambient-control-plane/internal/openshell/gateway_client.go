package openshell

import (
	"context"
	"fmt"
	"io"
	"strings"
	"sync"

	inferencepb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/inference/v1"
	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	"github.com/rs/zerolog"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type CredentialResolver func(ctx context.Context, namespace string) (credentials.TransportCredentials, error)

type TokenProvider interface {
	Token(ctx context.Context) (string, error)
}

type GatewayClient struct {
	mu             sync.RWMutex
	conns          map[string]*grpc.ClientConn
	oidcNamespaces sync.Map // namespace → bool (true = OIDC enabled)
	serviceName    string
	grpcPort       int
	resolveCred    CredentialResolver
	saTokenPath    string
	tokenProvider  TokenProvider
	logger         zerolog.Logger
}

type GatewayClientOption func(*GatewayClient)

func WithTokenProvider(tp TokenProvider) GatewayClientOption {
	return func(g *GatewayClient) {
		g.tokenProvider = tp
	}
}

func NewGatewayClient(serviceName string, grpcPort int, resolveCred CredentialResolver, saTokenPath string, logger zerolog.Logger, opts ...GatewayClientOption) *GatewayClient {
	g := &GatewayClient{
		conns:       make(map[string]*grpc.ClientConn),
		serviceName: serviceName,
		grpcPort:    grpcPort,
		resolveCred: resolveCred,
		saTokenPath: saTokenPath,
		logger:      logger.With().Str("component", "openshell-gateway").Logger(),
	}
	for _, opt := range opts {
		opt(g)
	}
	return g
}

// SetNamespaceAuthMode records whether a namespace's gateway requires OIDC auth.
// Called by the gateway reconciler after it processes each gateway's config.
func (g *GatewayClient) SetNamespaceAuthMode(namespace string, hasOIDC bool) {
	g.oidcNamespaces.Store(namespace, hasOIDC)
	g.logger.Debug().Str("namespace", namespace).Bool("oidc", hasOIDC).Msg("gateway auth mode registered")
}

func (g *GatewayClient) authContext(ctx context.Context, namespace string) context.Context {
	if mode, ok := g.oidcNamespaces.Load(namespace); ok {
		if mode.(bool) {
			return g.oidcAuthContext(ctx)
		}
		return ctx
	}
	// Namespace not yet registered — optimistically try OIDC. If the
	// gateway rejects the token ("unknown signing key"), the caller
	// retries without auth and registers the namespace as non-OIDC.
	return g.oidcAuthContext(ctx)
}

func (g *GatewayClient) stripAuthContext(ctx context.Context) context.Context {
	return metadata.NewOutgoingContext(ctx, metadata.MD{})
}

func (g *GatewayClient) isUnauthSigningKeyErr(err error) bool {
	if err == nil {
		return false
	}
	st, ok := status.FromError(err)
	if !ok {
		return false
	}
	return st.Code() == codes.Unauthenticated && strings.Contains(st.Message(), "unknown signing key")
}

func (g *GatewayClient) oidcAuthContext(ctx context.Context) context.Context {
	if g.tokenProvider == nil {
		return ctx
	}
	token, err := g.tokenProvider.Token(ctx)
	if err != nil {
		g.logger.Warn().Err(err).Msg("failed to obtain OIDC token for gateway auth")
		return ctx
	}
	if token != "" {
		return metadata.NewOutgoingContext(ctx, metadata.Pairs("authorization", "Bearer "+token))
	}
	return ctx
}

func (g *GatewayClient) clientForNamespace(ctx context.Context, namespace string) (pb.OpenShellClient, error) {
	conn, err := g.getOrCreateConn(ctx, namespace)
	if err != nil {
		return nil, err
	}
	return pb.NewOpenShellClient(conn), nil
}

func (g *GatewayClient) getOrCreateConn(ctx context.Context, namespace string) (*grpc.ClientConn, error) {
	g.mu.RLock()
	conn, ok := g.conns[namespace]
	g.mu.RUnlock()
	if ok {
		return conn, nil
	}

	g.mu.Lock()
	defer g.mu.Unlock()

	if conn, ok := g.conns[namespace]; ok {
		return conn, nil
	}

	target := g.gatewayEndpoint(namespace)
	creds, err := g.resolveCred(ctx, namespace)
	if err != nil {
		return nil, fmt.Errorf("resolving TLS credentials for namespace %s: %w", namespace, err)
	}

	conn, err = grpc.NewClient(target, grpc.WithTransportCredentials(creds))
	if err != nil {
		return nil, fmt.Errorf("dialing gateway at %s: %w", target, err)
	}

	g.conns[namespace] = conn
	g.logger.Info().Str("namespace", namespace).Str("target", target).Msg("gateway connection created")
	return conn, nil
}

func (g *GatewayClient) evictConn(namespace string) {
	g.mu.Lock()
	defer g.mu.Unlock()

	conn, ok := g.conns[namespace]
	if !ok {
		return
	}
	delete(g.conns, namespace)
	if err := conn.Close(); err != nil {
		g.logger.Warn().Err(err).Str("namespace", namespace).Msg("closing evicted gateway connection")
	}
	g.logger.Info().Str("namespace", namespace).Msg("evicted stale gateway connection")
}

func (g *GatewayClient) shouldEvict(err error) bool {
	st, ok := status.FromError(err)
	if !ok {
		return false
	}
	return st.Code() == codes.Unavailable
}

func (g *GatewayClient) CreateSandbox(ctx context.Context, namespace string, req *pb.CreateSandboxRequest) (*pb.SandboxResponse, error) {
	authCtx := g.authContext(ctx, namespace)
	client, err := g.clientForNamespace(authCtx, namespace)
	if err != nil {
		return nil, err
	}
	resp, err := client.CreateSandbox(authCtx, req)
	if g.isUnauthSigningKeyErr(err) {
		g.logger.Info().Str("namespace", namespace).Msg("OIDC token rejected, retrying without auth")
		g.SetNamespaceAuthMode(namespace, false)
		noAuthCtx := g.stripAuthContext(ctx)
		resp, err = client.CreateSandbox(noAuthCtx, req)
	}
	if err != nil && g.shouldEvict(err) {
		g.evictConn(namespace)
	}
	return resp, err
}

func (g *GatewayClient) GetSandbox(ctx context.Context, namespace string, name string) (*pb.SandboxResponse, error) {
	authCtx := g.authContext(ctx, namespace)
	client, err := g.clientForNamespace(authCtx, namespace)
	if err != nil {
		return nil, err
	}
	resp, err := client.GetSandbox(authCtx, &pb.GetSandboxRequest{Name: name})
	if g.isUnauthSigningKeyErr(err) {
		g.logger.Info().Str("namespace", namespace).Msg("OIDC token rejected, retrying without auth")
		g.SetNamespaceAuthMode(namespace, false)
		noAuthCtx := g.stripAuthContext(ctx)
		resp, err = client.GetSandbox(noAuthCtx, &pb.GetSandboxRequest{Name: name})
	}
	if err != nil && g.shouldEvict(err) {
		g.evictConn(namespace)
	}
	return resp, err
}

func (g *GatewayClient) DeleteSandbox(ctx context.Context, namespace string, name string) error {
	authCtx := g.authContext(ctx, namespace)
	client, err := g.clientForNamespace(authCtx, namespace)
	if err != nil {
		return err
	}
	_, err = client.DeleteSandbox(authCtx, &pb.DeleteSandboxRequest{Name: name})
	if g.isUnauthSigningKeyErr(err) {
		g.logger.Info().Str("namespace", namespace).Msg("OIDC token rejected, retrying without auth")
		g.SetNamespaceAuthMode(namespace, false)
		noAuthCtx := g.stripAuthContext(ctx)
		_, err = client.DeleteSandbox(noAuthCtx, &pb.DeleteSandboxRequest{Name: name})
	}
	if err != nil && g.shouldEvict(err) {
		g.evictConn(namespace)
	}
	return err
}

func (g *GatewayClient) CreateProvider(ctx context.Context, namespace string, req *pb.CreateProviderRequest) (*pb.ProviderResponse, error) {
	authCtx := g.authContext(ctx, namespace)
	client, err := g.clientForNamespace(authCtx, namespace)
	if err != nil {
		return nil, err
	}
	resp, err := client.CreateProvider(authCtx, req)
	if g.isUnauthSigningKeyErr(err) {
		g.logger.Info().Str("namespace", namespace).Msg("OIDC token rejected, retrying without auth")
		g.SetNamespaceAuthMode(namespace, false)
		noAuthCtx := g.stripAuthContext(ctx)
		resp, err = client.CreateProvider(noAuthCtx, req)
	}
	if err != nil && g.shouldEvict(err) {
		g.evictConn(namespace)
	}
	return resp, err
}

func (g *GatewayClient) UpdateProvider(ctx context.Context, namespace string, req *pb.UpdateProviderRequest) (*pb.ProviderResponse, error) {
	authCtx := g.authContext(ctx, namespace)
	client, err := g.clientForNamespace(authCtx, namespace)
	if err != nil {
		return nil, err
	}
	resp, err := client.UpdateProvider(authCtx, req)
	if g.isUnauthSigningKeyErr(err) {
		g.logger.Info().Str("namespace", namespace).Msg("OIDC token rejected, retrying without auth")
		g.SetNamespaceAuthMode(namespace, false)
		noAuthCtx := g.stripAuthContext(ctx)
		resp, err = client.UpdateProvider(noAuthCtx, req)
	}
	if err != nil && g.shouldEvict(err) {
		g.evictConn(namespace)
	}
	return resp, err
}

func (g *GatewayClient) GetProvider(ctx context.Context, namespace string, name string) (*pb.ProviderResponse, error) {
	authCtx := g.authContext(ctx, namespace)
	client, err := g.clientForNamespace(authCtx, namespace)
	if err != nil {
		return nil, err
	}
	resp, err := client.GetProvider(authCtx, &pb.GetProviderRequest{Name: name})
	if g.isUnauthSigningKeyErr(err) {
		g.logger.Info().Str("namespace", namespace).Msg("OIDC token rejected, retrying without auth")
		g.SetNamespaceAuthMode(namespace, false)
		noAuthCtx := g.stripAuthContext(ctx)
		resp, err = client.GetProvider(noAuthCtx, &pb.GetProviderRequest{Name: name})
	}
	if err != nil && g.shouldEvict(err) {
		g.evictConn(namespace)
	}
	return resp, err
}

type ExecResult struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int32
}

func (g *GatewayClient) ExecSandbox(ctx context.Context, namespace string, req *pb.ExecSandboxRequest) (*ExecResult, error) {
	authCtx := g.authContext(ctx, namespace)
	client, err := g.clientForNamespace(authCtx, namespace)
	if err != nil {
		return nil, err
	}
	stream, err := client.ExecSandbox(authCtx, req)
	if g.isUnauthSigningKeyErr(err) {
		g.logger.Info().Str("namespace", namespace).Msg("OIDC token rejected, retrying without auth")
		g.SetNamespaceAuthMode(namespace, false)
		noAuthCtx := g.stripAuthContext(ctx)
		stream, err = client.ExecSandbox(noAuthCtx, req)
	}
	if err != nil {
		if g.shouldEvict(err) {
			g.evictConn(namespace)
		}
		return nil, err
	}

	result := &ExecResult{}
	for {
		event, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			return result, fmt.Errorf("exec stream: %w", err)
		}
		switch p := event.Payload.(type) {
		case *pb.ExecSandboxEvent_Stdout:
			result.Stdout = append(result.Stdout, p.Stdout.Data...)
		case *pb.ExecSandboxEvent_Stderr:
			result.Stderr = append(result.Stderr, p.Stderr.Data...)
		case *pb.ExecSandboxEvent_Exit:
			result.ExitCode = p.Exit.ExitCode
		}
	}
	return result, nil
}

func (g *GatewayClient) inferenceClientForNamespace(ctx context.Context, namespace string) (inferencepb.InferenceClient, error) {
	conn, err := g.getOrCreateConn(ctx, namespace)
	if err != nil {
		return nil, err
	}
	return inferencepb.NewInferenceClient(conn), nil
}

func (g *GatewayClient) SetInferenceRoute(ctx context.Context, namespace string, req *inferencepb.SetInferenceRouteRequest) (*inferencepb.SetInferenceRouteResponse, error) {
	authCtx := g.authContext(ctx, namespace)
	client, err := g.inferenceClientForNamespace(authCtx, namespace)
	if err != nil {
		return nil, err
	}
	resp, err := client.SetInferenceRoute(authCtx, req)
	if g.isUnauthSigningKeyErr(err) {
		g.logger.Info().Str("namespace", namespace).Msg("OIDC token rejected, retrying without auth")
		g.SetNamespaceAuthMode(namespace, false)
		noAuthCtx := g.stripAuthContext(ctx)
		resp, err = client.SetInferenceRoute(noAuthCtx, req)
	}
	if err != nil && g.shouldEvict(err) {
		g.evictConn(namespace)
	}
	return resp, err
}

func (g *GatewayClient) ConfigureProviderRefresh(ctx context.Context, namespace string, req *pb.ConfigureProviderRefreshRequest) (*pb.ConfigureProviderRefreshResponse, error) {
	authCtx := g.authContext(ctx, namespace)
	client, err := g.clientForNamespace(authCtx, namespace)
	if err != nil {
		return nil, err
	}
	resp, err := client.ConfigureProviderRefresh(authCtx, req)
	if g.isUnauthSigningKeyErr(err) {
		g.logger.Info().Str("namespace", namespace).Msg("OIDC token rejected, retrying without auth")
		g.SetNamespaceAuthMode(namespace, false)
		noAuthCtx := g.stripAuthContext(ctx)
		resp, err = client.ConfigureProviderRefresh(noAuthCtx, req)
	}
	if err != nil && g.shouldEvict(err) {
		g.evictConn(namespace)
	}
	return resp, err
}

func (g *GatewayClient) RotateProviderCredential(ctx context.Context, namespace string, req *pb.RotateProviderCredentialRequest) (*pb.RotateProviderCredentialResponse, error) {
	authCtx := g.authContext(ctx, namespace)
	client, err := g.clientForNamespace(authCtx, namespace)
	if err != nil {
		return nil, err
	}
	resp, err := client.RotateProviderCredential(authCtx, req)
	if g.isUnauthSigningKeyErr(err) {
		g.logger.Info().Str("namespace", namespace).Msg("OIDC token rejected, retrying without auth")
		g.SetNamespaceAuthMode(namespace, false)
		noAuthCtx := g.stripAuthContext(ctx)
		resp, err = client.RotateProviderCredential(noAuthCtx, req)
	}
	if err != nil && g.shouldEvict(err) {
		g.evictConn(namespace)
	}
	return resp, err
}

type ExecExitError struct {
	Code int32
}

func (e *ExecExitError) Error() string {
	return fmt.Sprintf("exec process exited with code %d", e.Code)
}

const maxLogChunkSize = 512

func (g *GatewayClient) ExecSandboxStreaming(ctx context.Context, namespace string, req *pb.ExecSandboxRequest) error {
	authCtx := g.authContext(ctx, namespace)
	client, err := g.clientForNamespace(authCtx, namespace)
	if err != nil {
		return err
	}
	stream, err := client.ExecSandbox(authCtx, req)
	if g.isUnauthSigningKeyErr(err) {
		g.logger.Info().Str("namespace", namespace).Msg("OIDC token rejected, retrying without auth")
		g.SetNamespaceAuthMode(namespace, false)
		noAuthCtx := g.stripAuthContext(ctx)
		stream, err = client.ExecSandbox(noAuthCtx, req)
	}
	if err != nil {
		if g.shouldEvict(err) {
			g.evictConn(namespace)
		}
		return err
	}

	for {
		event, err := stream.Recv()
		if err == io.EOF {
			g.logger.Debug().Str("sandbox_id", req.SandboxId).Msg("exec stream ended")
			return nil
		}
		if err != nil {
			g.logger.Warn().Err(err).Str("sandbox_id", req.SandboxId).Msg("exec stream error")
			return err
		}
		switch p := event.Payload.(type) {
		case *pb.ExecSandboxEvent_Stdout:
			chunk := p.Stdout.Data
			if len(chunk) > maxLogChunkSize {
				chunk = chunk[:maxLogChunkSize]
			}
			g.logger.Debug().Str("sandbox_id", req.SandboxId).Str("stdout", string(chunk)).Msg("exec stdout")
		case *pb.ExecSandboxEvent_Stderr:
			chunk := p.Stderr.Data
			if len(chunk) > maxLogChunkSize {
				chunk = chunk[:maxLogChunkSize]
			}
			g.logger.Debug().Str("sandbox_id", req.SandboxId).Str("stderr", string(chunk)).Msg("exec stderr")
		case *pb.ExecSandboxEvent_Exit:
			g.logger.Info().Str("sandbox_id", req.SandboxId).Int32("exit_code", p.Exit.ExitCode).Msg("exec process exited")
			if p.Exit.ExitCode != 0 {
				return &ExecExitError{Code: p.Exit.ExitCode}
			}
			return nil
		}
	}
}

func (g *GatewayClient) UpdateConfig(ctx context.Context, namespace string, req *pb.UpdateConfigRequest) (*pb.UpdateConfigResponse, error) {
	authCtx := g.authContext(ctx, namespace)
	client, err := g.clientForNamespace(authCtx, namespace)
	if err != nil {
		return nil, err
	}
	resp, err := client.UpdateConfig(authCtx, req)
	if g.isUnauthSigningKeyErr(err) {
		g.logger.Info().Str("namespace", namespace).Msg("OIDC token rejected, retrying without auth")
		g.SetNamespaceAuthMode(namespace, false)
		noAuthCtx := g.stripAuthContext(ctx)
		resp, err = client.UpdateConfig(noAuthCtx, req)
	}
	if err != nil && g.shouldEvict(err) {
		g.evictConn(namespace)
	}
	return resp, err
}

func (g *GatewayClient) WatchSandbox(ctx context.Context, namespace string, req *pb.WatchSandboxRequest) (pb.OpenShell_WatchSandboxClient, error) {
	authCtx := g.authContext(ctx, namespace)
	client, err := g.clientForNamespace(authCtx, namespace)
	if err != nil {
		return nil, err
	}
	stream, err := client.WatchSandbox(authCtx, req)
	if g.isUnauthSigningKeyErr(err) {
		g.logger.Info().Str("namespace", namespace).Msg("OIDC token rejected, retrying without auth")
		g.SetNamespaceAuthMode(namespace, false)
		noAuthCtx := g.stripAuthContext(ctx)
		stream, err = client.WatchSandbox(noAuthCtx, req)
	}
	if err != nil {
		if g.shouldEvict(err) {
			g.evictConn(namespace)
		}
		return nil, err
	}
	return stream, nil
}

func (g *GatewayClient) Close() error {
	g.mu.Lock()
	defer g.mu.Unlock()

	var firstErr error
	for ns, conn := range g.conns {
		if err := conn.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
		g.logger.Debug().Str("namespace", ns).Msg("gateway connection closed")
	}
	g.conns = make(map[string]*grpc.ClientConn)
	return firstErr
}

func (g *GatewayClient) gatewayEndpoint(namespace string) string {
	return fmt.Sprintf("dns:///%s.%s.svc.cluster.local:%d", g.serviceName, namespace, g.grpcPort)
}

func SandboxCRName(sandboxName string) string {
	return "default--" + sandboxName
}

func SandboxName(sessionID string) string {
	name := sessionID
	if len(name) > 11 {
		name = name[:11]
	}
	result := make([]byte, len(name))
	for i := 0; i < len(name); i++ {
		c := name[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		result[i] = c
	}
	return "session-" + string(result)
}
