package reconciler

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// GitHub App keys stay in ACP. The gateway receives only an expiring installation token.
type managedGitHubApp struct {
	AppID          string `json:"app_id"`
	InstallationID string `json:"installation_id"`
	PrivateKey     string `json:"private_key"`
	APIURL         string `json:"api_url"`
}

func parseManagedGitHubApp(value string) (*managedGitHubApp, error) {
	var app managedGitHubApp
	if json.Unmarshal([]byte(value), &app) != nil || app.AppID == "" || app.InstallationID == "" || app.PrivateKey == "" {
		return nil, fmt.Errorf("GitHub App credential requires string app_id, installation_id, and private_key fields")
	}
	for _, id := range []string{app.AppID, app.InstallationID} {
		for _, r := range id {
			if r < '0' || r > '9' {
				return nil, fmt.Errorf("GitHub App IDs must be decimal strings")
			}
		}
	}
	if app.APIURL == "" {
		app.APIURL = "https://api.github.com"
	}
	endpoint, err := url.Parse(app.APIURL)
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, fmt.Errorf("GitHub App api_url must be HTTPS without credentials or query")
	}
	return &app, nil
}

func (a *managedGitHubApp) installationToken(ctx context.Context, client *http.Client) (value string, expiry time.Time, resultErr error) {
	block, _ := pem.Decode([]byte(a.PrivateKey))
	if block == nil {
		return "", time.Time{}, fmt.Errorf("invalid GitHub App private key")
	}
	key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		parsed, parseErr := x509.ParsePKCS8PrivateKey(block.Bytes)
		if parseErr != nil {
			return "", time.Time{}, fmt.Errorf("invalid GitHub App private key")
		}
		var ok bool
		key, ok = parsed.(*rsa.PrivateKey)
		if !ok {
			return "", time.Time{}, fmt.Errorf("GitHub App requires an RSA private key")
		}
	}
	if key.N.BitLen() < 2048 {
		return "", time.Time{}, fmt.Errorf("GitHub App RSA key must have at least 2048 bits")
	}
	now := time.Now()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, err := json.Marshal(map[string]interface{}{"iss": a.AppID, "iat": now.Add(-time.Minute).Unix(), "exp": now.Add(9 * time.Minute).Unix()})
	if err != nil {
		return "", time.Time{}, fmt.Errorf("encode GitHub App claims")
	}
	message := header + "." + base64.RawURLEncoding.EncodeToString(claims)
	digest := sha256.Sum256([]byte(message))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", time.Time{}, fmt.Errorf("sign GitHub App request")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(a.APIURL, "/")+"/app/installations/"+a.InstallationID+"/access_tokens", strings.NewReader("{}"))
	if err != nil {
		return "", time.Time{}, fmt.Errorf("build GitHub App request")
	}
	request.Header.Set("Authorization", "Bearer "+message+"."+base64.RawURLEncoding.EncodeToString(signature))
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("GitHub App token endpoint unavailable")
	}
	defer func() {
		if err := response.Body.Close(); err != nil {
			value = ""
			expiry = time.Time{}
			resultErr = errors.Join(resultErr, fmt.Errorf("close GitHub App response: %w", err))
		}
	}()
	if response.StatusCode != http.StatusCreated {
		return "", time.Time{}, fmt.Errorf("GitHub App token endpoint returned HTTP %d", response.StatusCode)
	}
	var result struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&result) != nil || result.Token == "" || !result.ExpiresAt.After(now.Add(5*time.Minute)) {
		return "", time.Time{}, fmt.Errorf("invalid GitHub App installation token response")
	}
	return result.Token, result.ExpiresAt, nil
}

var managedProviderHTTPClient = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(r *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
