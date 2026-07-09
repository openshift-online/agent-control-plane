package openshell

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/rs/zerolog"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

func insecureResolver(_ context.Context, _ string) (credentials.TransportCredentials, error) {
	return insecure.NewCredentials(), nil
}

func TestGatewayEndpoint(t *testing.T) {
	tests := []struct {
		service   string
		port      int
		namespace string
		want      string
	}{
		{"openshell-gateway", 8443, "tenant", "dns:///openshell-gateway.tenant.svc.cluster.local:8443"},
		{"gw", 9090, "prod-ns", "dns:///gw.prod-ns.svc.cluster.local:9090"},
	}
	for _, tt := range tests {
		g := NewGatewayClient(tt.service, tt.port, nil, "", zerolog.Nop())
		got := g.gatewayEndpoint(tt.namespace)
		if got != tt.want {
			t.Errorf("gatewayEndpoint(%q) = %q, want %q", tt.namespace, got, tt.want)
		}
	}
}

func TestShouldEvict(t *testing.T) {
	g := NewGatewayClient("gw", 8443, nil, "", zerolog.Nop())

	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"Unavailable triggers eviction", status.Error(codes.Unavailable, "connection refused"), true},
		{"NotFound does not evict", status.Error(codes.NotFound, "not found"), false},
		{"PermissionDenied does not evict", status.Error(codes.PermissionDenied, "denied"), false},
		{"Internal does not evict", status.Error(codes.Internal, "internal"), false},
		{"non-status error does not evict", fmt.Errorf("plain error"), false},
		{"nil error does not evict", nil, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := g.shouldEvict(tt.err)
			if got != tt.want {
				t.Errorf("shouldEvict() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestGetOrCreateConn_CacheHit(t *testing.T) {
	g := NewGatewayClient("gw", 8443, insecureResolver, "", zerolog.Nop())
	t.Cleanup(func() { g.Close() })

	ctx := context.Background()
	conn1, err := g.getOrCreateConn(ctx, "ns-a")
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	conn2, err := g.getOrCreateConn(ctx, "ns-a")
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if conn1 != conn2 {
		t.Error("expected same *grpc.ClientConn on cache hit, got different pointers")
	}

	conn3, err := g.getOrCreateConn(ctx, "ns-b")
	if err != nil {
		t.Fatalf("different namespace: %v", err)
	}
	if conn3 == conn1 {
		t.Error("different namespaces should return different connections")
	}
}

func TestGetOrCreateConn_CredResolverError(t *testing.T) {
	resolveErr := fmt.Errorf("vault is sealed")
	g := NewGatewayClient("gw", 8443, func(_ context.Context, _ string) (credentials.TransportCredentials, error) {
		return nil, resolveErr
	}, "", zerolog.Nop())

	_, err := g.getOrCreateConn(context.Background(), "ns-a")
	if err == nil {
		t.Fatal("expected error from credential resolver, got nil")
	}
}

func TestEvictConn(t *testing.T) {
	g := NewGatewayClient("gw", 8443, insecureResolver, "", zerolog.Nop())
	t.Cleanup(func() { g.Close() })

	ctx := context.Background()
	_, err := g.getOrCreateConn(ctx, "ns-a")
	if err != nil {
		t.Fatalf("setup: %v", err)
	}

	g.mu.RLock()
	_, exists := g.conns["ns-a"]
	g.mu.RUnlock()
	if !exists {
		t.Fatal("conn should exist before eviction")
	}

	g.evictConn("ns-a")

	g.mu.RLock()
	_, exists = g.conns["ns-a"]
	g.mu.RUnlock()
	if exists {
		t.Error("conn should be removed after eviction")
	}
}

func TestEvictConn_Noop(t *testing.T) {
	g := NewGatewayClient("gw", 8443, nil, "", zerolog.Nop())
	g.evictConn("nonexistent")
}

func TestGetOrCreateConn_ConcurrentSameNamespace(t *testing.T) {
	var calls int
	var mu sync.Mutex
	g := NewGatewayClient("gw", 8443, func(_ context.Context, _ string) (credentials.TransportCredentials, error) {
		mu.Lock()
		calls++
		mu.Unlock()
		return insecure.NewCredentials(), nil
	}, "", zerolog.Nop())
	t.Cleanup(func() { g.Close() })

	ctx := context.Background()
	const goroutines = 20
	errs := make(chan error, goroutines)

	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			_, err := g.getOrCreateConn(ctx, "ns-race")
			if err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		t.Fatalf("goroutine error: %v", err)
	}

	mu.Lock()
	c := calls
	mu.Unlock()
	if c != 1 {
		t.Errorf("credential resolver called %d times, want 1 (double-check lock should coalesce)", c)
	}
}

func TestSandboxName(t *testing.T) {
	tests := []struct {
		sessionID string
		want      string
	}{
		{"abc123", "session-abc123"},
		{"ABC-DEF", "session-abc-def"},
		{"MiXeD-CaSe-123", "session-mixed-case-123"},
		{
			"aaaaabbbbbcccccdddddeeeeefffffggggghhhhh-extra-chars-beyond-40",
			"session-aaaaabbbbbcccccdddddeeeeefffffggggghhhhh",
		},
		{"", "session-"},
	}
	for _, tt := range tests {
		t.Run(tt.sessionID, func(t *testing.T) {
			got := SandboxName(tt.sessionID)
			if got != tt.want {
				t.Errorf("SandboxName(%q) = %q, want %q", tt.sessionID, got, tt.want)
			}
		})
	}
}

func TestClose(t *testing.T) {
	g := NewGatewayClient("gw", 8443, insecureResolver, "", zerolog.Nop())

	ctx := context.Background()
	for _, ns := range []string{"a", "b", "c"} {
		if _, err := g.getOrCreateConn(ctx, ns); err != nil {
			t.Fatalf("setup conn %s: %v", ns, err)
		}
	}

	if err := g.Close(); err != nil {
		t.Errorf("Close() returned error: %v", err)
	}

	g.mu.RLock()
	remaining := len(g.conns)
	g.mu.RUnlock()
	if remaining != 0 {
		t.Errorf("after Close(), %d connections remain, want 0", remaining)
	}
}

func TestAuthContext_NoPath(t *testing.T) {
	g := NewGatewayClient("gw", 8443, nil, "", zerolog.Nop())
	ctx := g.authContext(context.Background())
	md, ok := metadata.FromOutgoingContext(ctx)
	if ok && len(md.Get("authorization")) > 0 {
		t.Error("expected no authorization metadata when saTokenPath is empty")
	}
}

func TestAuthContext_ValidToken(t *testing.T) {
	dir := t.TempDir()
	tokenFile := filepath.Join(dir, "token")
	if err := os.WriteFile(tokenFile, []byte("test-sa-token\n"), 0600); err != nil {
		t.Fatal(err)
	}
	g := NewGatewayClient("gw", 8443, nil, tokenFile, zerolog.Nop())
	ctx := g.authContext(context.Background())
	md, ok := metadata.FromOutgoingContext(ctx)
	if !ok {
		t.Fatal("expected outgoing metadata")
	}
	vals := md.Get("authorization")
	if len(vals) != 1 || vals[0] != "Bearer test-sa-token" {
		t.Errorf("authorization = %v, want [Bearer test-sa-token]", vals)
	}
}

func TestAuthContext_MissingFile(t *testing.T) {
	g := NewGatewayClient("gw", 8443, nil, "/nonexistent/path/token", zerolog.Nop())
	ctx := g.authContext(context.Background())
	md, ok := metadata.FromOutgoingContext(ctx)
	if ok && len(md.Get("authorization")) > 0 {
		t.Error("expected no authorization metadata when token file is missing")
	}
}
