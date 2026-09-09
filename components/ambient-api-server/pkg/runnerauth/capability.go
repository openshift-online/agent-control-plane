// Package runnerauth defines the signed runner capability contract.
package runnerauth

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"strings"
	"time"
)

const Prefix = "acp-runner-v1."
const AccessTTL = 5 * time.Minute
const MaxBootstrapTTL = 7 * 24 * time.Hour

// Claims bind a capability to one session run. Purpose separates access and refresh.
type Claims struct {
	Purpose     string `json:"purpose"`
	SessionID   string `json:"session_id"`
	ProjectID   string `json:"project_id"`
	SandboxName string `json:"sandbox_name"`
	Generation  string `json:"generation"`
	IssuedAt    int64  `json:"iat"`
	ExpiresAt   int64  `json:"exp"`
}

func Sign(key *rsa.PrivateKey, claims Claims) (string, error) {
	if key == nil || key.N.BitLen() < 2048 {
		return "", fmt.Errorf("runner signing key is not configured")
	}
	if err := claims.Validate(claims.Purpose, time.Now()); err != nil {
		return "", err
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("encode runner claims: %w", err)
	}
	message := Prefix + base64.RawURLEncoding.EncodeToString(payload)
	digest := sha256.Sum256([]byte(message))
	signature, err := rsa.SignPSS(rand.Reader, key, crypto.SHA256, digest[:], &rsa.PSSOptions{SaltLength: rsa.PSSSaltLengthEqualsHash})
	if err != nil {
		return "", fmt.Errorf("sign runner capability: %w", err)
	}
	return message + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func Verify(key *rsa.PublicKey, token, purpose string, now time.Time) (Claims, error) {
	var claims Claims
	if key == nil || key.N.BitLen() < 2048 || len(token) > 8192 || !strings.HasPrefix(token, Prefix) {
		return claims, fmt.Errorf("invalid runner capability")
	}
	parts := strings.Split(strings.TrimPrefix(token, Prefix), ".")
	if len(parts) != 2 {
		return claims, fmt.Errorf("invalid runner capability")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return claims, fmt.Errorf("invalid runner signature")
	}
	digest := sha256.Sum256([]byte(Prefix + parts[0]))
	if err := rsa.VerifyPSS(key, crypto.SHA256, digest[:], signature, &rsa.PSSOptions{SaltLength: rsa.PSSSaltLengthEqualsHash}); err != nil {
		return claims, fmt.Errorf("invalid runner signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return claims, fmt.Errorf("invalid runner claims")
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return claims, fmt.Errorf("invalid runner claims")
	}
	return claims, claims.Validate(purpose, now)
}

func (c Claims) Validate(purpose string, now time.Time) error {
	limit := int64(AccessTTL.Seconds())
	if purpose == "bootstrap" {
		limit = int64(MaxBootstrapTTL.Seconds())
	} else if purpose != "access" {
		return fmt.Errorf("invalid runner purpose")
	}
	if c.Purpose != purpose || c.SessionID == "" || c.ProjectID == "" || c.SandboxName == "" || c.Generation == "" || c.IssuedAt > now.Unix()+30 || c.ExpiresAt <= now.Unix() || c.ExpiresAt <= c.IssuedAt || c.ExpiresAt-c.IssuedAt > limit {
		return fmt.Errorf("invalid or expired runner capability")
	}
	return nil
}

func ParsePublicKey(data []byte) (*rsa.PublicKey, error) {
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, fmt.Errorf("invalid runner public key")
	}
	key, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse runner public key: %w", err)
	}
	pub, ok := key.(*rsa.PublicKey)
	if !ok || pub.N.BitLen() < 2048 {
		return nil, fmt.Errorf("runner public key must be RSA with at least 2048 bits")
	}
	return pub, nil
}
