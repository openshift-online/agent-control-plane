package tokenserver

import (
	"context"
	"net"
	"net/http"
	"net/http/httputil"
	"regexp"
	"strings"
	"time"

	pb "github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
)

// SandboxRunnerGateway carries HTTP over the gateway's authenticated stream.
// The implementation fixes the destination to the runner's loopback port.
type SandboxRunnerGateway interface {
	DialRunner(ctx context.Context, target, sandboxID string) (net.Conn, error)
}

var runnerProxySegment = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func runnerProxyPath(raw string) (name, sessionID, runnerPath string, ok bool) {
	parts := strings.SplitN(strings.TrimPrefix(raw, "/sandbox/"), "/", 4)
	if len(parts) != 4 || parts[1] != "runner" || !runnerProxySegment.MatchString(parts[0]) || !runnerProxySegment.MatchString(parts[2]) {
		return "", "", "", false
	}
	runnerPath = "/" + parts[3]
	if strings.ContainsAny(runnerPath, "\\\x00") {
		return "", "", "", false
	}
	for _, segment := range strings.Split(runnerPath, "/") {
		if segment == "." || segment == ".." {
			return "", "", "", false
		}
	}
	return parts[0], parts[2], runnerPath, true
}

func (h *sandboxHandler) handleRunnerProxy(w http.ResponseWriter, r *http.Request) {
	name, sessionID, runnerPath, ok := runnerProxyPath(r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	accessMethod, accessAction, allowed := runnerAccessOperation(r.Method, runnerPath)
	if !allowed {
		http.NotFound(w, r)
		return
	}
	bearer, err := extractBearerToken(r)
	if err != nil || h.authorizeRunner == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	target, err := h.authorizeRunner(r.Context(), bearer, sessionID, name, accessMethod, accessAction)
	if err != nil || target == "" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	gateway, ok := h.gateway.(SandboxRunnerGateway)
	if !ok {
		http.Error(w, "runner transport unavailable", http.StatusServiceUnavailable)
		return
	}
	sandbox, err := h.gateway.GetSandbox(r.Context(), target, name)
	if err != nil || sandbox.GetSandbox().GetMetadata().GetId() == "" || sandbox.GetSandbox().GetStatus().GetPhase() != pb.SandboxPhase_SANDBOX_PHASE_READY {
		http.Error(w, "session runner not available", http.StatusServiceUnavailable)
		return
	}
	sandboxID := sandbox.GetSandbox().GetMetadata().GetId()
	transport := &http.Transport{
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return gateway.DialRunner(ctx, target, sandboxID)
		},
	}
	defer transport.CloseIdleConnections()
	proxy := &httputil.ReverseProxy{
		Transport:     transport,
		FlushInterval: -1,
		Rewrite: func(p *httputil.ProxyRequest) {
			p.Out.URL.Scheme = "http"
			p.Out.URL.Host = "127.0.0.1:8001"
			p.Out.URL.Path = runnerPath
			p.Out.URL.RawPath = ""
			p.Out.Host = "127.0.0.1:8001"
			// The user token authorizes this proxy. It is not a runner credential.
			p.Out.Header.Del("Authorization")
			p.Out.Header.Del("Cookie")
			p.Out.Header.Del("Proxy-Authorization")
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "session runner not available", http.StatusBadGateway)
		},
	}
	// SSE and file responses can outlive the token server's short default write
	// deadline. Cancellation of the client request closes the gateway stream.
	if err := http.NewResponseController(w).SetWriteDeadline(time.Time{}); err != nil {
		h.logger.Debug().Msg("runner proxy response does not support write deadlines")
	}
	proxy.ServeHTTP(w, r)
}

// RunnerAuthorizer checks the API role binding before runner transport access.
type RunnerAuthorizer func(ctx context.Context, bearer, sessionID, sandboxName, method, action string) (string, error)

// runnerAccessOperation accepts only the native routes used by ACP's public
// API adapter. A new runner endpoint does not automatically become accessible.
func runnerAccessOperation(method, runnerPath string) (string, string, bool) {
	switch method {
	case http.MethodGet:
		switch runnerPath {
		case "/capabilities", "/tasks", "/mcp/status", "/repos/status",
			"/content/list", "/content/file", "/content/git-status", "/content/git-list-branches":
			return method, "", true
		}
	case http.MethodPost:
		switch runnerPath {
		case "/", "/interrupt", "/feedback", "/content/git-configure-remote":
			return method, "", true
		case "/content/write":
			// Public file PUT maps to the native writer's POST.
			return http.MethodPut, "", true
		}
	case http.MethodDelete:
		if runnerPath == "/content/delete" {
			return method, "", true
		}
	}
	parts := strings.Split(strings.TrimPrefix(runnerPath, "/"), "/")
	if method == http.MethodGet && len(parts) == 2 && parts[0] == "events" && runnerProxySegment.MatchString(parts[1]) {
		return method, "", true
	}
	if len(parts) == 3 && parts[0] == "tasks" && runnerProxySegment.MatchString(parts[1]) {
		if method == http.MethodGet && parts[2] == "output" {
			return method, "", true
		}
		if method == http.MethodPost && parts[2] == "stop" {
			return method, "stop", true
		}
	}
	return "", "", false
}
