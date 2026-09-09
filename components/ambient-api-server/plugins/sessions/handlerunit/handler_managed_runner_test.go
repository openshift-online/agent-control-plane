package handlerunit_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v4"
	. "github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/sessions"
	"github.com/openshift-online/rh-trex-ai/pkg/auth"
)

func managedRunnerHarness(t *testing.T, upstream http.HandlerFunc) (*Session, http.Handler) {
	t.Helper()
	server := httptest.NewTLSServer(upstream)
	previousURL, previousClient := ControlPlaneURL, EventsHTTPClient
	ControlPlaneURL, EventsHTTPClient = server.URL, server.Client()
	t.Cleanup(func() { ControlPlaneURL, EventsHTTPClient = previousURL, previousClient; server.Close() })
	svc := NewInMemorySessionService()
	session := seedSession(t, svc)
	backend, sandbox := "hypershell", "sb-managed"
	session.RuntimeBackend, session.SandboxName = &backend, &sandbox
	if _, err := svc.Replace(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	router := setupFullRouter(svc)
	router.HandleFunc("/api/ambient/v1/sessions/{id}/runner-events", NewSessionHandler(svc, nil, nil).StreamRunnerEvents).Methods(http.MethodGet)
	return session, router
}

func managedRequest(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer untrusted-header")
	req.Header.Set("Cookie", "private-cookie")
	return req.WithContext(context.WithValue(req.Context(), auth.ContextAuthKey, &jwt.Token{Raw: "verified-user-token"}))
}

func TestManagedRunnerNativeRoutesAndAuthentication(t *testing.T) {
	var receivedPath, receivedQuery, receivedMethod string
	session, router := managedRunnerHarness(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer verified-user-token" || r.Header.Get("Cookie") != "" {
			t.Error("user identity was not forwarded safely")
		}
		receivedPath, receivedQuery, receivedMethod = r.URL.Path, r.URL.RawQuery, r.Method
		_, _ = io.WriteString(w, `{"ok":true}`)
	})
	for _, tt := range []struct{ path, method, native string }{
		{"git/status", "GET", "/content/git-status"},
		{"git/configure-remote", "POST", "/content/git-configure-remote"},
		{"agui/run", "POST", "/"}, {"agui/interrupt", "POST", "/interrupt"},
		{"agui/feedback", "POST", "/feedback"}, {"agui/capabilities", "GET", "/capabilities"},
		{"agui/tasks", "GET", "/tasks"}, {"agui/tasks/task-a/stop", "POST", "/tasks/task-a/stop"},
		{"agui/tasks/task-a/output", "GET", "/tasks/task-a/output"},
		{"repos/status", "GET", "/repos/status"}, {"mcp/status", "GET", "/mcp/status"},
		{"agui/events", "GET", "/events/" + session.ID}, {"runner-events", "GET", "/events/" + session.ID},
	} {
		t.Run(tt.path, func(t *testing.T) {
			path := fmt.Sprintf("/api/ambient/v1/sessions/%s/%s?path=repo%%20one&after=4", session.ID, tt.path)
			rr := httptest.NewRecorder()
			router.ServeHTTP(rr, managedRequest(tt.method, path, `{}`))
			if rr.Code != 200 {
				t.Fatalf("status %d: %s", rr.Code, rr.Body)
			}
			expected := "/sandbox/sb-managed/runner/" + session.ID + tt.native
			if receivedPath != expected || receivedMethod != tt.method || receivedQuery != "path=repo%20one&after=4" {
				t.Fatalf("upstream %s %s?%s, expected %s", receivedMethod, receivedPath, receivedQuery, expected)
			}
		})
	}
}

func TestManagedRunnerFileAdapterPreservesBytesAndPath(t *testing.T) {
	var expectedPath string
	raw := []byte{0, 255, 10, 'a'}
	session, router := managedRunnerHarness(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/content/write"):
			if r.Method != "POST" {
				t.Errorf("method %s", r.Method)
			}
			var data map[string]string
			if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
				t.Fatal(err)
			}
			if data["path"] != expectedPath {
				t.Errorf("path %q", data["path"])
			}
			if data["encoding"] == "base64" {
				decoded, err := base64.StdEncoding.DecodeString(data["content"])
				if err != nil || !bytes.Equal(decoded, raw) {
					t.Error("file bytes changed")
				}
			} else if data["content"] != "hello" {
				t.Error("JSON content changed")
			}
			_, _ = io.WriteString(w, `{"message":"ok"}`)
		case strings.HasSuffix(r.URL.Path, "/content/file"):
			if r.URL.Query().Get("path") != expectedPath {
				t.Errorf("read path %q", r.URL.Query().Get("path"))
			}
			_, _ = w.Write(raw)
		case strings.HasSuffix(r.URL.Path, "/content/delete"):
			var data map[string]string
			if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
				t.Fatal(err)
			}
			if data["path"] != expectedPath || r.Method != "DELETE" {
				t.Error("delete path or method changed")
			}
			_, _ = io.WriteString(w, `{"message":"ok"}`)
		default:
			t.Errorf("unexpected route %s", r.URL.Path)
		}
	})
	expectedPath = "notes/report #1.txt"
	for _, family := range []string{"workspace", "files"} {
		path := fmt.Sprintf("/api/ambient/v1/sessions/%s/%s/notes/report%%20%%231.txt?path=attacker", session.ID, family)
		for _, tt := range []struct{ method, body, contentType string }{{"PUT", string(raw), "application/octet-stream"}, {"PUT", `{"path":"attacker","content":"hello"}`, "application/json"}, {"DELETE", "", ""}} {
			req := managedRequest(tt.method, path, tt.body)
			req.Header.Set("Content-Type", tt.contentType)
			rr := httptest.NewRecorder()
			router.ServeHTTP(rr, req)
			if rr.Code != 200 {
				t.Fatalf("%s %s: %d %s", tt.method, family, rr.Code, rr.Body)
			}
		}
		if family == "workspace" {
			rr := httptest.NewRecorder()
			router.ServeHTTP(rr, managedRequest("GET", path, ""))
			if rr.Code != 200 || !bytes.Equal(rr.Body.Bytes(), raw) {
				t.Error("read bytes changed")
			}
		}
	}
}

func TestManagedRunnerListEnvelopes(t *testing.T) {
	session, router := managedRunnerHarness(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/content/list") {
			_, _ = io.WriteString(w, `{"items":[{"name":"file","isDir":false}]}`)
		} else {
			_, _ = io.WriteString(w, `{"branches":["main"]}`)
		}
	})
	for _, tt := range []struct{ route, body string }{{"workspace", `{"files":[{"name":"file","isDir":false}]}`}, {"files", `{"files":[{"name":"file","isDir":false}]}`}, {"git/branches", `["main"]`}} {
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, managedRequest("GET", fmt.Sprintf("/api/ambient/v1/sessions/%s/%s", session.ID, tt.route), ""))
		if rr.Code != 200 || strings.TrimSpace(rr.Body.String()) != tt.body {
			t.Errorf("%s: %d %s", tt.route, rr.Code, rr.Body)
		}
	}
}

func TestManagedRunnerFailuresAreNotEmptySuccess(t *testing.T) {
	calls := 0
	session, router := managedRunnerHarness(t, func(w http.ResponseWriter, r *http.Request) { calls++; http.Error(w, "unavailable", 503) })
	for _, route := range []string{"workspace", "files", "git/status", "agui/events", "mcp/status"} {
		path := fmt.Sprintf("/api/ambient/v1/sessions/%s/%s", session.ID, route)
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, managedRequest("GET", path, ""))
		if rr.Code != 503 {
			t.Errorf("%s status %d", route, rr.Code)
		}
		before := calls
		rr = httptest.NewRecorder()
		router.ServeHTTP(rr, httptest.NewRequest("GET", path, nil))
		if rr.Code != 401 || calls != before {
			t.Error("unauthenticated request reached control plane")
		}
	}
	EventsHTTPClient = &http.Client{Transport: failingRunnerTransport{}}
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, managedRequest("GET", fmt.Sprintf("/api/ambient/v1/sessions/%s/files", session.ID), ""))
	if rr.Code != 502 {
		t.Errorf("transport failure status %d", rr.Code)
	}
}

type failingRunnerTransport struct{}

func (failingRunnerTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, fmt.Errorf("unavailable")
}

func TestManagedRunnerStreamsBeforeUpstreamCompletes(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	session, router := managedRunnerHarness(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		router.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), auth.ContextAuthKey, &jwt.Token{Raw: "verified-user-token"})))
	}))
	defer api.Close()
	client := &http.Client{Timeout: 3 * time.Second}
	req, err := http.NewRequest("POST", api.URL+fmt.Sprintf("/api/ambient/v1/sessions/%s/agui/run", session.ID), strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(req)
	if err != nil {
		t.Fatal("stream did not arrive before upstream completed:", err)
	}
	defer func() { _ = response.Body.Close() }()
	chunk := make([]byte, len("data: first\n\n"))
	if _, err := io.ReadFull(response.Body, chunk); err != nil {
		t.Fatal(err)
	}
	if string(chunk) != "data: first\n\n" {
		t.Fatal("event changed")
	}
}

func TestManagedRunnerRejectsInvalidFileJSON(t *testing.T) {
	calls := 0
	session, router := managedRunnerHarness(t, func(w http.ResponseWriter, r *http.Request) { calls++ })
	for _, body := range []string{"null", "{", `{"content":5}`} {
		req := managedRequest("PUT", fmt.Sprintf("/api/ambient/v1/sessions/%s/files/test", session.ID), body)
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, req)
		if rr.Code != 400 {
			t.Errorf("status %d", rr.Code)
		}
	}
	if calls != 0 {
		t.Fatal("invalid request reached runner")
	}
}

func TestManagedRunnerRejectsMalformedLists(t *testing.T) {
	session, router := managedRunnerHarness(t, func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, `{"wrong":[]}`) })
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, managedRequest("GET", fmt.Sprintf("/api/ambient/v1/sessions/%s/workspace", session.ID), ""))
	if rr.Code != 502 {
		t.Errorf("status %d", rr.Code)
	}
}

func TestManagedRunnerMissingBindingReturnsUnavailable(t *testing.T) {
	svc := NewInMemorySessionService()
	session := seedSession(t, svc)
	backend := "hypershell"
	session.RuntimeBackend = &backend
	if _, err := svc.Replace(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	rr := httptest.NewRecorder()
	setupFullRouter(svc).ServeHTTP(rr, managedRequest("GET", fmt.Sprintf("/api/ambient/v1/sessions/%s/workspace", session.ID), ""))
	if rr.Code != 503 {
		t.Errorf("status %d", rr.Code)
	}
}
