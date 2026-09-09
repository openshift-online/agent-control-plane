package tokenserver

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
)

type runnerProxyGateway struct {
	mockSandboxGateway
	dial func(context.Context, string, string) (net.Conn, error)
}

func (g *runnerProxyGateway) DialRunner(ctx context.Context, target, id string) (net.Conn, error) {
	return g.dial(ctx, target, id)
}

func TestRunnerProxyUsesAuthorizedBindingAndPreservesRequest(t *testing.T) {
	runner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		if r.Method != "POST" || r.URL.Path != "/content/write" || r.URL.RawQuery != "download=true" || string(body) != "proof-data" {
			t.Errorf("unexpected runner request: %s %s %q", r.Method, r.URL, body)
		}
		for _, key := range []string{"Authorization", "Cookie", "Proxy-Authorization"} {
			if r.Header.Get(key) != "" {
				t.Errorf("forwarded private header %s", key)
			}
		}
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("stored"))
	}))
	defer runner.Close()
	gw := &runnerProxyGateway{mockSandboxGateway: mockSandboxGateway{getSandboxFn: func(_ context.Context, target, name string) (*pb.SandboxResponse, error) {
		if target != "gateway-a/workspace-a" || name != "sandbox-a" {
			t.Fatal("request changed the authorized binding")
		}
		return makeSandboxResponse("sandbox-id-a", name), nil
	}}, dial: func(ctx context.Context, target, id string) (net.Conn, error) {
		if target != "gateway-a/workspace-a" || id != "sandbox-id-a" {
			t.Error("dial changed the authorized binding")
		}
		return (&net.Dialer{}).DialContext(ctx, "tcp", strings.TrimPrefix(runner.URL, "http://"))
	}}
	h := newTestSandboxHandler(gw)
	h.authorizeRunner = func(_ context.Context, bearer, session, name, method, action string) (string, error) {
		if bearer != "test-sandbox-token" || session != "session-a" || name != "sandbox-a" || method != http.MethodPut || action != "" {
			t.Fatal("wrong user authorization inputs")
		}
		return "gateway-a/workspace-a", nil
	}
	r := withTestAuth(httptest.NewRequest(http.MethodPost, "/sandbox/sandbox-a/runner/session-a/content/write?download=true", strings.NewReader("proof-data")))
	r.Header.Set("Cookie", "private-cookie")
	r.Header.Set("Proxy-Authorization", "private-proxy-token")
	w := httptest.NewRecorder()
	h.handleRunnerProxy(w, r)
	if w.Code != http.StatusCreated || w.Body.String() != "stored" {
		t.Fatalf("response = %d %q", w.Code, w.Body.String())
	}
}

func TestRunnerProxyRejectsBeforeDial(t *testing.T) {
	for _, tc := range []struct {
		name, path   string
		auth         bool
		authorizeErr error
		ready        bool
		status       int
	}{
		{name: "anonymous", path: "/sandbox/sandbox-a/runner/session-a/content/list", ready: true, status: 401},
		{name: "other session", path: "/sandbox/sandbox-a/runner/session-b/content/list", auth: true, authorizeErr: errors.New("denied"), ready: true, status: 403},
		{name: "stopped", path: "/sandbox/sandbox-a/runner/session-a/content/list", auth: true, status: 503},
		{name: "traversal", path: "/sandbox/sandbox-a/runner/session-a/workspace/../token", auth: true, ready: true, status: 404},
		{name: "unrelated path", path: "/sandbox/sandbox-a/runner/session-a/token", auth: true, ready: true, status: 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gw := &runnerProxyGateway{mockSandboxGateway: mockSandboxGateway{getSandboxFn: func(context.Context, string, string) (*pb.SandboxResponse, error) {
				r := makeSandboxResponse("sandbox-id", "sandbox-a")
				if !tc.ready {
					r.Sandbox.Status.Phase = pb.SandboxPhase_SANDBOX_PHASE_STOPPED
				}
				return r, nil
			}}, dial: func(context.Context, string, string) (net.Conn, error) {
				t.Error("denied request opened a runner connection")
				return nil, errors.New("unexpected dial")
			}}
			h := newTestSandboxHandler(gw)
			h.authorizeRunner = func(context.Context, string, string, string, string, string) (string, error) {
				return "gateway", tc.authorizeErr
			}
			r := httptest.NewRequest(http.MethodGet, tc.path, nil)
			if tc.auth {
				withTestAuth(r)
			}
			w := httptest.NewRecorder()
			h.handleRunnerProxy(w, r)
			if w.Code != tc.status {
				t.Fatalf("status=%d, want %d", w.Code, tc.status)
			}
		})
	}
}

func TestRunnerProxyConnectionFailureIsNotEmptySuccess(t *testing.T) {
	gw := &runnerProxyGateway{mockSandboxGateway: mockSandboxGateway{getSandboxFn: func(context.Context, string, string) (*pb.SandboxResponse, error) {
		return makeSandboxResponse("sandbox-id", "sandbox-a"), nil
	}}, dial: func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New("private upstream detail")
	}}
	h := newTestSandboxHandler(gw)
	h.authorizeRunner = func(context.Context, string, string, string, string, string) (string, error) { return "gateway", nil }
	w := httptest.NewRecorder()
	h.handleRunnerProxy(w, withTestAuth(httptest.NewRequest(http.MethodGet, "/sandbox/sandbox-a/runner/session-a/content/list", nil)))
	if w.Code != 502 || strings.Contains(w.Body.String(), "private") {
		t.Fatalf("response=%d %q", w.Code, w.Body.String())
	}
}

func TestRunnerProxyAcceptsNativeRunnerRoutes(t *testing.T) {
	for _, tc := range []struct{ method, route string }{
		{"POST", "/"}, {"POST", "/interrupt"}, {"POST", "/feedback"},
		{"GET", "/capabilities"}, {"GET", "/tasks"}, {"GET", "/tasks/task-a/output"},
		{"POST", "/tasks/task-a/stop"}, {"GET", "/events/session-a"},
		{"GET", "/content/list"}, {"GET", "/content/file"}, {"POST", "/content/write"},
		{"DELETE", "/content/delete"}, {"GET", "/content/git-status"},
		{"GET", "/content/git-list-branches"}, {"POST", "/content/git-configure-remote"},
		{"GET", "/mcp/status"}, {"GET", "/repos/status"},
	} {
		t.Run(tc.method+tc.route, func(t *testing.T) {
			_, _, got, ok := runnerProxyPath("/sandbox/sandbox-a/runner/session-a" + tc.route)
			_, _, allowed := runnerAccessOperation(tc.method, got)
			if !ok || got != tc.route || !allowed {
				t.Errorf("native route %s %q rejected", tc.method, tc.route)
			}
		})
	}
}

func TestRunnerProxyCreatorCannotInvokeUnsupportedRoutes(t *testing.T) {
	for _, tc := range []struct{ method, path string }{
		{"POST", "/repos/remove"}, {"POST", "/repos/add"}, {"DELETE", "/repos/remove"},
		{"POST", "/content/delete"}, {"GET", "/content/write"}, {"POST", "/content/list"},
		{"POST", "/tasks/task-a/output"}, {"POST", "/tasks/task-a/stop/private"},
		{"POST", "/tasks//stop"}, {"GET", "/events/session-a/wait"},
		{"POST", "/mcp/status"}, {"GET", "/content/file/private"},
		{"GET", "/content/workflow-metadata"}, {"POST", "/oauth/exchange"},
		{"POST", "/agui/run"}, {"PUT", "/workspace/proof.txt"},
		{"OPTIONS", "/content/file"}, {"HEAD", "/content/file"},
		{"GET", "/token"}, {"GET", "/env"}, {"POST", "/interrupt/private"},
		{"POST", "/feedback/private"}, {"GET", "/capabilities/private"},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			gw := &runnerProxyGateway{mockSandboxGateway: mockSandboxGateway{getSandboxFn: func(context.Context, string, string) (*pb.SandboxResponse, error) {
				t.Fatal("unsupported route reached native gateway")
				return nil, nil
			}}, dial: func(context.Context, string, string) (net.Conn, error) {
				t.Fatal("unsupported route opened runner connection")
				return nil, nil
			}}
			h := newTestSandboxHandler(gw)
			authorized := false
			h.authorizeRunner = func(_ context.Context, _, _, _, method, action string) (string, error) {
				authorized = true
				// This user can create sessions, but cannot update or delete them.
				if method == http.MethodPost && action == "" {
					return "gateway", nil
				}
				return "", errors.New("creator denied")
			}
			w := httptest.NewRecorder()
			h.handleRunnerProxy(w, withTestAuth(httptest.NewRequest(tc.method, "/sandbox/sandbox-a/runner/session-a"+tc.path, nil)))
			if w.Code != http.StatusNotFound || authorized {
				t.Fatalf("unsupported route status=%d authorized=%v", w.Code, authorized)
			}
		})
	}
}

func TestRunnerProxyUsesOperationPermissionBeforeNativeAccess(t *testing.T) {
	for _, tc := range []struct{ method, path, permissionMethod, action string }{
		{"GET", "/content/file", "GET", ""},
		{"POST", "/content/write", "PUT", ""},
		{"DELETE", "/content/delete", "DELETE", ""},
		{"POST", "/", "POST", ""},
		{"POST", "/tasks/task-a/stop", "POST", "stop"},
		{"POST", "/feedback", "POST", ""},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			gw := &runnerProxyGateway{mockSandboxGateway: mockSandboxGateway{getSandboxFn: func(context.Context, string, string) (*pb.SandboxResponse, error) {
				t.Fatal("denied user reached native gateway")
				return nil, nil
			}}}
			h := newTestSandboxHandler(gw)
			h.authorizeRunner = func(_ context.Context, bearer, session, sandbox, method, action string) (string, error) {
				if method != tc.permissionMethod || action != tc.action {
					t.Fatalf("permission=%s/%s", method, action)
				}
				return "", errors.New("viewer denied")
			}
			req := withTestAuth(httptest.NewRequest(tc.method, "/sandbox/sandbox-a/runner/session-a"+tc.path, nil))
			req.Header.Set("X-Runner-Action", "read")
			w := httptest.NewRecorder()
			h.handleRunnerProxy(w, req)
			if w.Code != http.StatusForbidden {
				t.Fatalf("status=%d", w.Code)
			}
		})
	}
}
