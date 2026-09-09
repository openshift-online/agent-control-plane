package reconciler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRunnerAccessUsesUserTokenAndFailsClosed(t *testing.T) {
	for _, status := range []int{http.StatusNoContent, http.StatusForbidden, http.StatusUnauthorized, http.StatusServiceUnavailable, http.StatusOK} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPut || r.URL.Path != "/api/ambient/v1/sessions/session-a/runner/access" || r.Header.Get("Authorization") != "Bearer user-test-token-value" {
				t.Error("wrong authorization request")
			}
			w.WriteHeader(status)
		}))
		err := checkRunnerAccess(context.Background(), server.URL, "user-test-token-value", "session-a", http.MethodPut, "")
		server.Close()
		if (err == nil) != (status == http.StatusNoContent) {
			t.Fatalf("status %d error %v", status, err)
		}
	}
}
