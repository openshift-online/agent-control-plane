package openshell

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// GatewayTarget contains one managed gateway identity and workspace. Revision
// must change when its client identity, CA trust, or token provider changes.
// Callers must not mutate TLSConfig after the resolver returns it.
type GatewayTarget struct {
	Endpoint      string
	TLSConfig     *tls.Config
	TokenProvider TokenProvider
	Workspace     string
	Revision      string
}

type TargetResolver func(ctx context.Context, key string) (GatewayTarget, error)

func WithTargetResolver(resolver TargetResolver) GatewayClientOption {
	return func(g *GatewayClient) { g.targetResolver = resolver }
}

// TargetKey separates the immutable gateway ID and workspace without ambiguity.
func TargetKey(gatewayID, workspace string) string {
	return "managed:" + base64.RawURLEncoding.EncodeToString([]byte(gatewayID)) + ":" + base64.RawURLEncoding.EncodeToString([]byte(workspace))
}

func ParseTargetKey(key string) (gatewayID, workspace string, err error) {
	parts := strings.Split(key, ":")
	if len(parts) != 3 || parts[0] != "managed" {
		return "", "", fmt.Errorf("invalid managed gateway key")
	}
	id, idErr := base64.RawURLEncoding.DecodeString(parts[1])
	ws, wsErr := base64.RawURLEncoding.DecodeString(parts[2])
	if idErr != nil || wsErr != nil || len(id) == 0 || len(ws) == 0 {
		return "", "", fmt.Errorf("managed gateway key requires a gateway ID and workspace")
	}
	return string(id), string(ws), nil
}

func normalizeGatewayEndpoint(endpoint string) (string, error) {
	if strings.TrimSpace(endpoint) != endpoint || endpoint == "" {
		return "", fmt.Errorf("managed gateway endpoint is empty or has surrounding whitespace")
	}
	authority := endpoint
	if strings.Contains(endpoint, "://") {
		parsed, err := url.Parse(endpoint)
		if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "grpcs") || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || strings.Contains(endpoint, "#") || (parsed.Path != "" && parsed.Path != "/") || parsed.RawPath != "" || strings.HasSuffix(parsed.Host, ":") {
			return "", fmt.Errorf("managed gateway endpoint must use HTTPS, GRPCS, or host:port without a path, query, fragment, or credentials")
		}
		authority = parsed.Host
		if parsed.Port() == "" {
			authority = net.JoinHostPort(parsed.Hostname(), "443")
		}
	}
	host, port, err := net.SplitHostPort(authority)
	if err != nil || host == "" || strings.ContainsAny(host, "/?#@ \t\r\n") {
		return "", fmt.Errorf("managed gateway endpoint requires a valid host and port")
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return "", fmt.Errorf("managed gateway endpoint has an invalid port")
	}
	return "dns:///" + net.JoinHostPort(host, strconv.Itoa(n)), nil
}

func (g *GatewayClient) managedConn(ctx context.Context, key string) (*grpc.ClientConn, error) {
	_, workspace, err := ParseTargetKey(key)
	if err != nil {
		return nil, err
	}
	target, err := g.targetResolver(ctx, key)
	if err != nil {
		return nil, fmt.Errorf("resolve managed gateway target: %w", err)
	}
	endpoint, err := normalizeGatewayEndpoint(target.Endpoint)
	if err != nil {
		return nil, err
	}
	if target.Workspace == "" || target.Workspace != workspace {
		return nil, fmt.Errorf("managed gateway workspace does not match its target key")
	}
	if target.Revision == "" {
		return nil, fmt.Errorf("managed gateway credential revision is required")
	}
	if target.TokenProvider == nil {
		return nil, fmt.Errorf("managed gateway token provider is required")
	}
	if target.TLSConfig == nil || target.TLSConfig.InsecureSkipVerify {
		return nil, fmt.Errorf("managed gateway requires verified TLS")
	}
	tlsConfig := target.TLSConfig.Clone()
	if tlsConfig.RootCAs != nil {
		tlsConfig.RootCAs = tlsConfig.RootCAs.Clone()
	}
	if tlsConfig.MinVersion < tls.VersionTLS12 {
		tlsConfig.MinVersion = tls.VersionTLS12
	}
	if tlsConfig.MaxVersion != 0 && tlsConfig.MaxVersion < tls.VersionTLS12 {
		return nil, fmt.Errorf("managed gateway requires TLS 1.2 or later")
	}
	// Explicit server-name overrides could validate a different host from the
	// binding. The endpoint is the authority for server identity.
	if tlsConfig.ServerName != "" {
		authority := strings.TrimPrefix(endpoint, "dns:///")
		hostname, _, _ := net.SplitHostPort(authority)
		if tlsConfig.ServerName != hostname {
			return nil, fmt.Errorf("managed gateway TLS server name does not match its endpoint")
		}
	}
	fingerprint, err := targetFingerprint(endpoint, target, tlsConfig)
	if err != nil {
		return nil, err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if conn, found := g.conns[key]; found && g.targetRevisions[key] == fingerprint && equalRootCAs(g.targetRootCAs[key], tlsConfig.RootCAs) {
		return conn, nil
	}
	conn, err := grpc.NewClient(endpoint,
		grpc.WithTransportCredentials(credentials.NewTLS(tlsConfig)),
		grpc.WithPerRPCCredentials(managedBearer{provider: target.TokenProvider}),
		grpc.WithUnaryInterceptor(workspaceUnaryInterceptor(workspace)),
		grpc.WithStreamInterceptor(workspaceStreamInterceptor(workspace)),
	)
	if err != nil {
		return nil, fmt.Errorf("create managed gateway connection: %w", err)
	}
	if old := g.conns[key]; old != nil {
		if err := old.Close(); err != nil {
			return nil, fmt.Errorf("close previous managed gateway connection: %w", errors.Join(err, conn.Close()))
		}
	}
	g.conns[key] = conn
	g.targetRevisions[key] = fingerprint
	g.targetRootCAs[key] = tlsConfig.RootCAs
	return conn, nil
}

// Compare complete pools: two CA certificates can have the same subject but
// different keys. A nil pool uses system roots and is distinct from an empty pool.
func equalRootCAs(a, b *x509.CertPool) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Equal(b)
}

func targetFingerprint(endpoint string, target GatewayTarget, config *tls.Config) (string, error) {
	material := struct {
		Endpoint, Workspace, Revision, ServerName string
		MinVersion, MaxVersion                    uint16
		Certificates                              [][][]byte
	}{Endpoint: endpoint, Workspace: target.Workspace, Revision: target.Revision, ServerName: config.ServerName, MinVersion: config.MinVersion, MaxVersion: config.MaxVersion}
	for _, certificate := range config.Certificates {
		material.Certificates = append(material.Certificates, certificate.Certificate)
	}
	data, err := json.Marshal(material)
	if err != nil {
		return "", fmt.Errorf("encode managed gateway identity: %w", err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

type managedBearer struct{ provider TokenProvider }

func (b managedBearer) RequireTransportSecurity() bool { return true }
func (b managedBearer) GetRequestMetadata(ctx context.Context, _ ...string) (map[string]string, error) {
	token, err := b.provider.Token(ctx)
	if err != nil {
		return nil, status.Error(codes.Unauthenticated, "cannot obtain managed gateway token")
	}
	if token == "" || strings.ContainsAny(token, " \t\r\n") {
		return nil, status.Error(codes.Unauthenticated, "managed gateway token is empty or invalid")
	}
	return map[string]string{"authorization": "Bearer " + token}, nil
}

func managedAuthContext(ctx context.Context) context.Context {
	md, _ := metadata.FromOutgoingContext(ctx)
	md = md.Copy()
	md.Delete("authorization")
	return metadata.NewOutgoingContext(ctx, md)
}

func scopeWorkspaceMessage(message interface{}, workspace string) (interface{}, error) {
	original, ok := message.(proto.Message)
	if !ok || original == nil || !original.ProtoReflect().IsValid() {
		return nil, status.Error(codes.Internal, "gateway request is not a protobuf message")
	}
	cloned := proto.Clone(original)
	fields := cloned.ProtoReflect().Descriptor().Fields()
	if field := fields.ByName("workspace"); field != nil && field.Kind() == protoreflect.StringKind {
		value := cloned.ProtoReflect().Get(field).String()
		if value != "" && value != workspace {
			return nil, status.Error(codes.InvalidArgument, "request workspace does not match the gateway target")
		}
		cloned.ProtoReflect().Set(field, protoreflect.ValueOfString(workspace))
	}
	if field := fields.ByName("all_workspaces"); field != nil && cloned.ProtoReflect().Get(field).Bool() {
		return nil, status.Error(codes.InvalidArgument, "managed gateway calls cannot span all workspaces")
	}
	// Interactive exec carries its workspace-scoped request in the first frame.
	if field := fields.ByName("start"); field != nil && field.Kind() == protoreflect.MessageKind && cloned.ProtoReflect().Has(field) {
		nested, err := scopeWorkspaceMessage(cloned.ProtoReflect().Get(field).Message().Interface(), workspace)
		if err != nil {
			return nil, err
		}
		cloned.ProtoReflect().Set(field, protoreflect.ValueOfMessage(nested.(proto.Message).ProtoReflect()))
	}
	return cloned, nil
}

func workspaceUnaryInterceptor(workspace string) grpc.UnaryClientInterceptor {
	return func(ctx context.Context, method string, req, reply interface{}, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
		scoped, err := scopeWorkspaceMessage(req, workspace)
		if err != nil {
			return err
		}
		return invoker(managedAuthContext(ctx), method, scoped, reply, cc, opts...)
	}
}

func workspaceStreamInterceptor(workspace string) grpc.StreamClientInterceptor {
	return func(ctx context.Context, desc *grpc.StreamDesc, cc *grpc.ClientConn, method string, streamer grpc.Streamer, opts ...grpc.CallOption) (grpc.ClientStream, error) {
		stream, err := streamer(managedAuthContext(ctx), desc, cc, method, opts...)
		if err != nil {
			return nil, err
		}
		return &workspaceClientStream{ClientStream: stream, workspace: workspace}, nil
	}
}

type workspaceClientStream struct {
	grpc.ClientStream
	workspace string
}

func (s *workspaceClientStream) SendMsg(message interface{}) error {
	scoped, err := scopeWorkspaceMessage(message, s.workspace)
	if err != nil {
		return err
	}
	return s.ClientStream.SendMsg(scoped)
}
