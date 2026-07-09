package client

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
)

func TestNewServiceClient_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Ambient-Project") != "" {
			t.Errorf("expected no X-Ambient-Project header, got %q", r.Header.Get("X-Ambient-Project"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(marshalJSON(t, &types.SessionList{}))
	}))
	defer srv.Close()

	c, err := NewServiceClient(srv.URL, testToken)
	if err != nil {
		t.Fatalf("NewServiceClient: %v", err)
	}
	if c.Project() != "" {
		t.Errorf("expected empty project, got %q", c.Project())
	}

	_, err = c.Sessions().List(context.Background(), &types.ListOptions{})
	if err != nil {
		t.Fatalf("Sessions().List: %v", err)
	}
}

func TestNewServiceClient_MissingToken(t *testing.T) {
	_, err := NewServiceClient("http://localhost:8080", "")
	if err == nil {
		t.Fatal("expected error for empty token")
	}
}

func TestNewServiceClient_ShortToken(t *testing.T) {
	_, err := NewServiceClient("http://localhost:8080", "tooshort")
	if err == nil {
		t.Fatal("expected error for short token")
	}
}

func TestNewServiceClient_InvalidURL(t *testing.T) {
	_, err := NewServiceClient("ftp://bad-scheme.io", testToken)
	if err == nil {
		t.Fatal("expected error for invalid URL scheme")
	}
}
