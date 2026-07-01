package openshell

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	inferencepb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/inference/v1"
	pb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
	"github.com/rs/zerolog"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type CredentialResolver func(ctx context.Context, namespace string) (credentials.TransportCredentials, error)

type GatewayClient struct {
	mu          sync.RWMutex
	conns       map[string]*grpc.ClientConn
	serviceName string
	grpcPort    int
	resolveCred CredentialResolver
	saTokenPath string
	logger      zerolog.Logger
}

func NewGatewayClient(serviceName string, grpcPort int, resolveCred CredentialResolver, saTokenPath string, logger zerolog.Logger) *GatewayClient {
	return &GatewayClient{
		conns:       make(map[string]*grpc.ClientConn),
		serviceName: serviceName,
		grpcPort:    grpcPort,
		resolveCred: resolveCred,
		saTokenPath: saTokenPath,
		logger:      logger.With().Str("component", "openshell-gateway").Logger(),
	}
}

func (g *GatewayClient) authContext(ctx context.Context) context.Context {
	if g.saTokenPath == "" {
		return ctx
	}
	raw, err := os.ReadFile(g.saTokenPath)
	if err != nil {
		g.logger.Warn().Err(err).Str("path", g.saTokenPath).Msg("failed to read SA token file")
		return ctx
	}
	token := strings.TrimSpace(string(raw))
	if token == "" {
		return ctx
	}
	return metadata.NewOutgoingContext(ctx, metadata.Pairs("authorization", "Bearer "+token))
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
	ctx = g.authContext(ctx)
	client, err := g.clientForNamespace(ctx, namespace)
	if err != nil {
		return nil, err
	}
	resp, err := client.CreateSandbox(ctx, req)
	if err != nil && g.shouldEvict(err) {
		g.evictConn(namespace)
	}
	return resp, err
}

func (g *GatewayClient) GetSandbox(ctx context.Context, namespace string, name string) (*pb.SandboxResponse, error) {
	ctx = g.authContext(ctx)
	client, err := g.clientForNamespace(ctx, namespace)
	if err != nil {
		return nil, err
	}
	resp, err := client.GetSandbox(ctx, &pb.GetSandboxRequest{Name: name})
	if err != nil && g.shouldEvict(err) {
		g.evictConn(namespace)
	}
	return resp, err
}

func (g *GatewayClient) DeleteSandbox(ctx context.Context, namespace string, name string) error {
	ctx = g.authContext(ctx)
	client, err := g.clientForNamespace(ctx, namespace)
	if err != nil {
		return err
	}
	_, err = client.DeleteSandbox(ctx, &pb.DeleteSandboxRequest{Name: name})
	if err != nil && g.shouldEvict(err) {
		g.evictConn(namespace)
	}
	return err
}

func (g *GatewayClient) CreateProvider(ctx context.Context, namespace string, req *pb.CreateProviderRequest) (*pb.ProviderResponse, error) {
	ctx = g.authContext(ctx)
	client, err := g.clientForNamespace(ctx, namespace)
	if err != nil {
		return nil, err
	}
	resp, err := client.CreateProvider(ctx, req)
	if err != nil && g.shouldEvict(err) {
		g.evictConn(namespace)
	}
	return resp, err
}

func (g *GatewayClient) UpdateProvider(ctx context.Context, namespace string, req *pb.UpdateProviderRequest) (*pb.ProviderResponse, error) {
	ctx = g.authContext(ctx)
	client, err := g.clientForNamespace(ctx, namespace)
	if err != nil {
		return nil, err
	}
	resp, err := client.UpdateProvider(ctx, req)
	if err != nil && g.shouldEvict(err) {
		g.evictConn(namespace)
	}
	return resp, err
}

func (g *GatewayClient) GetProvider(ctx context.Context, namespace string, name string) (*pb.ProviderResponse, error) {
	ctx = g.authContext(ctx)
	client, err := g.clientForNamespace(ctx, namespace)
	if err != nil {
		return nil, err
	}
	resp, err := client.GetProvider(ctx, &pb.GetProviderRequest{Name: name})
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
	ctx = g.authContext(ctx)
	client, err := g.clientForNamespace(ctx, namespace)
	if err != nil {
		return nil, err
	}
	stream, err := client.ExecSandbox(ctx, req)
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

func (g *GatewayClient) SetClusterInference(ctx context.Context, namespace string, req *inferencepb.SetClusterInferenceRequest) (*inferencepb.SetClusterInferenceResponse, error) {
	ctx = g.authContext(ctx)
	client, err := g.inferenceClientForNamespace(ctx, namespace)
	if err != nil {
		return nil, err
	}
	resp, err := client.SetClusterInference(ctx, req)
	if err != nil && g.shouldEvict(err) {
		g.evictConn(namespace)
	}
	return resp, err
}

func (g *GatewayClient) ConfigureProviderRefresh(ctx context.Context, namespace string, req *pb.ConfigureProviderRefreshRequest) (*pb.ConfigureProviderRefreshResponse, error) {
	ctx = g.authContext(ctx)
	client, err := g.clientForNamespace(ctx, namespace)
	if err != nil {
		return nil, err
	}
	resp, err := client.ConfigureProviderRefresh(ctx, req)
	if err != nil && g.shouldEvict(err) {
		g.evictConn(namespace)
	}
	return resp, err
}

func (g *GatewayClient) RotateProviderCredential(ctx context.Context, namespace string, req *pb.RotateProviderCredentialRequest) (*pb.RotateProviderCredentialResponse, error) {
	ctx = g.authContext(ctx)
	client, err := g.clientForNamespace(ctx, namespace)
	if err != nil {
		return nil, err
	}
	resp, err := client.RotateProviderCredential(ctx, req)
	if err != nil && g.shouldEvict(err) {
		g.evictConn(namespace)
	}
	return resp, err
}

const maxLogChunkSize = 512

func (g *GatewayClient) ExecSandboxStreaming(ctx context.Context, namespace string, req *pb.ExecSandboxRequest) error {
	ctx = g.authContext(ctx)
	client, err := g.clientForNamespace(ctx, namespace)
	if err != nil {
		return err
	}
	stream, err := client.ExecSandbox(ctx, req)
	if err != nil {
		if g.shouldEvict(err) {
			g.evictConn(namespace)
		}
		return err
	}

	go func() {
		for {
			event, err := stream.Recv()
			if err == io.EOF {
				g.logger.Debug().Str("sandbox_id", req.SandboxId).Msg("exec stream ended")
				return
			}
			if err != nil {
				g.logger.Warn().Err(err).Str("sandbox_id", req.SandboxId).Msg("exec stream error")
				return
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
				return
			}
		}
	}()

	return nil
}

func (g *GatewayClient) UpdateConfig(ctx context.Context, namespace string, req *pb.UpdateConfigRequest) (*pb.UpdateConfigResponse, error) {
	ctx = g.authContext(ctx)
	client, err := g.clientForNamespace(ctx, namespace)
	if err != nil {
		return nil, err
	}
	resp, err := client.UpdateConfig(ctx, req)
	if err != nil && g.shouldEvict(err) {
		g.evictConn(namespace)
	}
	return resp, err
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

func SandboxName(sessionID string) string {
	name := sessionID
	if len(name) > 40 {
		name = name[:40]
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
