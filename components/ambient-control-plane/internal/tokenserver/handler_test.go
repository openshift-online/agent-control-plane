package tokenserver

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/runnerauth"
	"github.com/rs/zerolog"
)

func TestTokenExchangeScopeAndRevocation(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	revoked := false
	h := &handler{privateKey: key, logger: zerolog.Nop(), validate: func(ctx context.Context, c runnerauth.Claims) error {
		if revoked || c.SessionID != "session-a" || c.ProjectID != "project-a" || c.Generation != "run-a" || c.SandboxName != "sandbox-a" {
			return fmt.Errorf("revoked")
		}
		return nil
	}}
	bootstrap, err := IssueBootstrap(key, "session-a", "project-a", "sandbox-a", "run-a", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	call := func(token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/token", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		out := httptest.NewRecorder()
		h.handleToken(out, req)
		return out
	}
	out := call(bootstrap)
	if out.Code != http.StatusOK {
		t.Fatalf("exchange: %d", out.Code)
	}
	var response tokenResponse
	if err := json.Unmarshal(out.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	claims, err := runnerauth.Verify(&key.PublicKey, response.Token, "access", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if claims.SessionID != "session-a" || claims.ProjectID != "project-a" || claims.Generation != "run-a" || claims.ExpiresAt-claims.IssuedAt > 300 {
		t.Fatalf("wrong access scope: %+v", claims)
	}
	if call(response.Token).Code != http.StatusUnauthorized {
		t.Fatal("access token used as refresh token")
	}
	revoked = true
	if call(bootstrap).Code != http.StatusForbidden {
		t.Fatal("revoked run refreshed token")
	}
	revoked = false
	other, _ := IssueBootstrap(key, "session-b", "project-a", "sandbox-a", "run-a", time.Hour)
	if call(other).Code != http.StatusForbidden {
		t.Fatal("cross-session capability accepted")
	}
	legacy, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, &key.PublicKey, []byte("session-a"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if call(base64.StdEncoding.EncodeToString(legacy)).Code != http.StatusUnauthorized {
		t.Fatal("public-key encrypted session ID accepted")
	}
	h.validate = nil
	if call(bootstrap).Code != http.StatusUnauthorized {
		t.Fatal("missing session validator accepted")
	}
}

func TestCapabilitiesRejectForgeryExpiryAndWrongPurpose(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	token, err := IssueBootstrap(key, "session-a", "project-a", "sandbox-a", "run-a", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name           string
		key            *rsa.PublicKey
		token, purpose string
		now            time.Time
	}{
		{"wrong key", &other.PublicKey, token, "bootstrap", time.Now()},
		{"expired", &key.PublicKey, token, "bootstrap", time.Now().Add(2 * time.Minute)},
		{"wrong purpose", &key.PublicKey, token, "access", time.Now()},
		{"tampered", &key.PublicKey, token + "x", "bootstrap", time.Now()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := runnerauth.Verify(tc.key, tc.token, tc.purpose, tc.now); err == nil {
				t.Fatal("invalid capability accepted")
			}
		})
	}
}
