package client

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCheckRunnerAccessPreservesMethodAndRejectsFailure(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		for _, status := range []int{http.StatusNoContent, http.StatusForbidden, http.StatusOK} {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != method || r.URL.EscapedPath() != "/api/ambient/v1/sessions/session%2Fid/runner/access" || r.Header.Get("Authorization") != "Bearer "+testToken {
					t.Error("wrong permission request")
				}
				w.WriteHeader(status)
			}))
			client, err := NewServiceClient(server.URL, testToken)
			if err != nil {
				t.Fatal(err)
			}
			err = client.Sessions().CheckRunnerAccess(context.Background(), "session/id", method, "")
			server.Close()
			if (err == nil) != (status == http.StatusNoContent) {
				t.Fatalf("method %s status %d error %v", method, status, err)
			}
		}
	}
}

func TestCheckRunnerAccessRejectsUnsupportedOperationWithoutHTTP(t *testing.T) {
	client, err := NewServiceClient("http://127.0.0.1:1", testToken)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range [][2]string{{"TRACE", ""}, {"OPTIONS", ""}, {"POST", "read"}, {"GET", "stop"}} {
		if err := client.Sessions().CheckRunnerAccess(context.Background(), "session", tc[0], tc[1]); err == nil {
			t.Fatal("unsupported permission accepted")
		}
	}
}
