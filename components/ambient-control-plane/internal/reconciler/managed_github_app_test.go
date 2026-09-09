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
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestManagedGitHubAppExchangesKeyForExpiringToken(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	privatePEM := string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	expires := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/app/installations/42/access_tokens" {
			t.Error("incorrect installation request")
		}
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		parts := strings.Split(token, ".")
		if len(parts) != 3 {
			t.Error("missing App JWT")
			http.Error(w, "bad", http.StatusUnauthorized)
			return
		}
		signature, err := base64.RawURLEncoding.DecodeString(parts[2])
		if err != nil {
			t.Error(err)
		}
		digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
		if rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest[:], signature) != nil {
			t.Error("bad JWT signature")
		}
		claimsBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
		if err != nil {
			t.Error(err)
		}
		var claims map[string]interface{}
		if json.Unmarshal(claimsBytes, &claims) != nil || claims["iss"] != "7" {
			t.Error("App ID missing")
		}
		w.WriteHeader(http.StatusCreated)
		if err := json.NewEncoder(w).Encode(map[string]interface{}{"token": "installation-test-value", "expires_at": expires}); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	app := &managedGitHubApp{AppID: "7", InstallationID: "42", PrivateKey: privatePEM, APIURL: server.URL}
	token, expiry, err := app.installationToken(context.Background(), server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if token != "installation-test-value" || !expiry.Equal(expires) {
		t.Fatal("installation token expiry lost")
	}
}

func TestManagedGitHubAppRejectsUnsafeEndpointAndInvalidIDs(t *testing.T) {
	for _, value := range []string{
		`{"app_id":"1","installation_id":"2","private_key":"key","api_url":"http://github.example"}`,
		`{"app_id":"1","installation_id":"../2","private_key":"key"}`,
		`{"app_id":"1","installation_id":"2","private_key":"key","api_url":"https://user:password@github.example"}`,
	} {
		if _, err := parseManagedGitHubApp(value); err == nil {
			t.Fatal("invalid App credential accepted")
		}
	}
}
