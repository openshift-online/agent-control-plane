package tokenserver

import (
	"context"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/openshift-online/agent-control-plane/components/ambient-control-plane/internal/runnerauth"
	"github.com/rs/zerolog"
)

type tokenResponse struct {
	Token     string `json:"token"`
	ExpiresAt int64  `json:"expires_at"`
}

// SessionValidator must read current session state and reject deleted, stopped,
// or replaced runs. It must compare all scope fields, not only the session ID.
type SessionValidator func(context.Context, runnerauth.Claims) error

type handler struct {
	privateKey *rsa.PrivateKey
	validate   SessionValidator
	logger     zerolog.Logger
}

// IssueBootstrap signs a capability for one run. Store it only in that sandbox.
func IssueBootstrap(key *rsa.PrivateKey, sessionID, projectID, sandboxName, generation string, ttl time.Duration) (string, error) {
	if ttl <= 0 || ttl > runnerauth.MaxBootstrapTTL {
		return "", fmt.Errorf("invalid runner bootstrap lifetime")
	}
	now := time.Now()
	return runnerauth.Sign(key, runnerauth.Claims{Purpose: "bootstrap", SessionID: sessionID, ProjectID: projectID, SandboxName: sandboxName, Generation: generation, IssuedAt: now.Unix(), ExpiresAt: now.Add(ttl).Unix()})
}

func (h *handler) handleToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	bearer, err := extractBearerToken(r)
	if err != nil || h.privateKey == nil || h.validate == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	claims, err := runnerauth.Verify(&h.privateKey.PublicKey, bearer, "bootstrap", time.Now())
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err := h.validate(r.Context(), claims); err != nil {
		http.Error(w, "runner access revoked", http.StatusForbidden)
		return
	}
	claims.Purpose = "access"
	claims.IssuedAt = time.Now().Unix()
	claims.ExpiresAt = min(claims.ExpiresAt, time.Now().Add(runnerauth.AccessTTL).Unix())
	token, err := runnerauth.Sign(h.privateKey, claims)
	if err != nil {
		h.logger.Error().Msg("failed to sign runner access token")
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(tokenResponse{Token: token, ExpiresAt: claims.ExpiresAt}); err != nil {
		h.logger.Warn().Msg("failed to write runner token response")
	}
}

func extractBearerToken(r *http.Request) (string, error) {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		return "", fmt.Errorf("Authorization header missing")
	}
	if !strings.HasPrefix(authHeader, "Bearer ") {
		return "", fmt.Errorf("Authorization header must use Bearer scheme")
	}
	token := strings.TrimPrefix(authHeader, "Bearer ")
	if token == "" {
		return "", fmt.Errorf("empty bearer token")
	}
	return token, nil
}

func handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}
