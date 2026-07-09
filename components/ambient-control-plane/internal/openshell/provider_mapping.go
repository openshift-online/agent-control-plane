package openshell

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"strings"
)

var providerTypeMapping = map[string]string{
	// Source control
	"github": "github",
	// Agent profiles
	"anthropic":   "claude-code",
	"claude":      "claude-code",
	"claude-code": "claude-code",
	"codex":       "codex",
	"copilot":     "copilot",
	"cursor":      "cursor",
	// Inference profiles
	"vertex":    "google-vertex-ai",
	"deepinfra": "deepinfra",
	"nvidia":    "nvidia",
	// Data profiles
	"pypi": "pypi",
	// Unmapped ACP types → generic
	"jira":       "generic",
	"google":     "generic",
	"kubeconfig": "generic",
	"mlflow":     "generic",
}

func KnownAmbientProviderTypes() []string {
	types := make([]string, 0, len(providerTypeMapping))
	for k := range providerTypeMapping {
		types = append(types, k)
	}
	return types
}

func OpenShellProviderType(ambientProvider string) string {
	if t, ok := providerTypeMapping[ambientProvider]; ok {
		return t
	}
	return "generic"
}

func ProviderName(projectName, ambientProvider string) string {
	return projectName + "-" + ambientProvider
}

var providerInjectedEnvVars = map[string][]string{
	"github":           {"GITHUB_TOKEN", "GH_TOKEN"},
	"claude-code":      {"ANTHROPIC_API_KEY", "CLAUDE_API_KEY"},
	"codex":            {"CODEX_AUTH_ACCESS_TOKEN", "CODEX_AUTH_REFRESH_TOKEN", "CODEX_AUTH_ACCOUNT_ID", "CODEX_AUTH_ID_TOKEN"},
	"copilot":          {"COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"},
	"google-vertex-ai": {"GOOGLE_SERVICE_ACCOUNT_KEY", "GOOGLE_VERTEX_AI_SERVICE_ACCOUNT_TOKEN"},
	"deepinfra":        {"DEEPINFRA_API_KEY"},
	"nvidia":           {"NVIDIA_API_KEY"},
}

func ProviderInjectedEnvVars(openshellType string) []string {
	return providerInjectedEnvVars[openshellType]
}

var inferenceCapableTypes = map[string]bool{
	"google-vertex-ai": true,
	"claude-code":      true,
	"deepinfra":        true,
	"nvidia":           true,
}

func IsInferenceCapable(ambientProvider string) bool {
	osType := OpenShellProviderType(ambientProvider)
	return inferenceCapableTypes[osType]
}

// knownProviderCredentialKey maps known provider types to the single credential
// key name expected by the OpenShell provider profile. For these types, the
// secret must have a "token" key whose value is mapped to the standard name.
var knownProviderCredentialKey = map[string]string{
	"vertex":      "GOOGLE_SERVICE_ACCOUNT_KEY",
	"anthropic":   "ANTHROPIC_API_KEY",
	"claude":      "ANTHROPIC_API_KEY",
	"claude-code": "ANTHROPIC_API_KEY",
	"github":      "GITHUB_TOKEN",
	"copilot":     "COPILOT_GITHUB_TOKEN",
	"deepinfra":   "DEEPINFRA_API_KEY",
	"nvidia":      "NVIDIA_API_KEY",
}

// ProviderCredentials maps a single token to the credential key expected by
// the OpenShell provider profile for known types. Used by the credential-based
// (non-gateway) provider path.
func ProviderCredentials(ambientProvider, token string) map[string]string {
	if credKey, ok := knownProviderCredentialKey[ambientProvider]; ok {
		return map[string]string{credKey: token}
	}
	return map[string]string{"token": token}
}

// ProviderCredentialsFromSecret builds the credential map for an OpenShell
// provider. For known types (vertex, github, anthropic), it reads the "token"
// key from the secret and maps it to the standard credential name. For unknown
// types, all secret keys are passed through as-is — the secret key names become
// the env var names in the sandbox.
//
// Vertex is special: SA keys are set as GOOGLE_SERVICE_ACCOUNT_KEY (the gateway
// strips the raw key after configuring refresh). ADC credentials are NOT set as
// initial credentials — the refresh flow mints the first access token.
func ProviderCredentialsFromSecret(ambientProvider string, secretData map[string]string) map[string]string {
	if ambientProvider == "mlflow" {
		token, ok := secretData["MLFLOW_TRACKING_TOKEN"]
		if !ok {
			return map[string]string{}
		}
		return map[string]string{"MLFLOW_TRACKING_TOKEN": strings.TrimRight(token, "\r\n")}
	}
	if ambientProvider == "vertex" {
		if token, has := secretData["token"]; has {
			credType, err := DetectGoogleCredentialType(token)
			if err == nil && credType == GoogleCredentialAuthorizedUser {
				return map[string]string{}
			}
			return map[string]string{"GOOGLE_SERVICE_ACCOUNT_KEY": token}
		}
	}
	if credKey, ok := knownProviderCredentialKey[ambientProvider]; ok {
		if token, has := secretData["token"]; has {
			return map[string]string{credKey: token}
		}
	}
	return secretData
}

// VertexRefreshCredentialKey returns the credential key where rotated access
// tokens are stored, based on the Google credential type.
// SA keys → GOOGLE_VERTEX_AI_SERVICE_ACCOUNT_TOKEN
// ADC      → GOOGLE_VERTEX_AI_TOKEN
func VertexRefreshCredentialKey(credType GoogleCredentialType) string {
	if credType == GoogleCredentialAuthorizedUser {
		return "GOOGLE_VERTEX_AI_TOKEN"
	}
	return "GOOGLE_VERTEX_AI_SERVICE_ACCOUNT_TOKEN"
}

type GoogleCredentialType int

const (
	GoogleCredentialServiceAccount GoogleCredentialType = iota
	GoogleCredentialAuthorizedUser
)

func DetectGoogleCredentialType(credJSON string) (GoogleCredentialType, error) {
	var header struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal([]byte(credJSON), &header); err != nil {
		return GoogleCredentialServiceAccount, fmt.Errorf("parsing credential JSON: %w", err)
	}
	switch header.Type {
	case "authorized_user":
		return GoogleCredentialAuthorizedUser, nil
	case "service_account", "":
		return GoogleCredentialServiceAccount, nil
	default:
		return GoogleCredentialServiceAccount, fmt.Errorf("unsupported Google credential type: %s", header.Type)
	}
}

type ServiceAccountJWTMaterial struct {
	ClientEmail string
	PrivateKey  string
}

func ExtractServiceAccountJWTMaterial(saKeyJSON string) (*ServiceAccountJWTMaterial, error) {
	var parsed struct {
		ClientEmail string `json:"client_email"`
		PrivateKey  string `json:"private_key"`
	}
	if err := json.Unmarshal([]byte(saKeyJSON), &parsed); err != nil {
		return nil, err
	}
	if parsed.ClientEmail == "" || parsed.PrivateKey == "" {
		return nil, fmt.Errorf("service account JSON missing client_email or private_key")
	}
	if err := validateRSAPEM(parsed.PrivateKey); err != nil {
		return nil, fmt.Errorf("private_key is not valid RSA PEM: %w", err)
	}
	return &ServiceAccountJWTMaterial{
		ClientEmail: parsed.ClientEmail,
		PrivateKey:  parsed.PrivateKey,
	}, nil
}

func validateRSAPEM(key string) error {
	block, _ := pem.Decode([]byte(key))
	if block == nil {
		return fmt.Errorf("no PEM block found")
	}
	if _, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return fmt.Errorf("key is not PKCS1 or PKCS8: %w", err)
	}
	if _, ok := parsed.(*rsa.PrivateKey); !ok {
		return fmt.Errorf("PKCS8 key is not RSA (got %T)", parsed)
	}
	return nil
}

const DefaultGoogleTokenURI = "https://oauth2.googleapis.com/token"

type OAuth2RefreshMaterial struct {
	ClientID     string
	ClientSecret string
	RefreshToken string
	TokenURI     string
	Account      string
}

func ExtractOAuth2RefreshMaterial(credJSON string) (*OAuth2RefreshMaterial, error) {
	var parsed struct {
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
		RefreshToken string `json:"refresh_token"`
		TokenURI     string `json:"token_uri"`
		Account      string `json:"account"`
	}
	if err := json.Unmarshal([]byte(credJSON), &parsed); err != nil {
		return nil, err
	}
	if parsed.ClientID == "" || parsed.ClientSecret == "" || parsed.RefreshToken == "" {
		return nil, fmt.Errorf("authorized_user JSON missing client_id, client_secret, or refresh_token")
	}
	tokenURI := parsed.TokenURI
	if tokenURI == "" {
		tokenURI = DefaultGoogleTokenURI
	}
	return &OAuth2RefreshMaterial{
		ClientID:     parsed.ClientID,
		ClientSecret: parsed.ClientSecret,
		RefreshToken: parsed.RefreshToken,
		TokenURI:     tokenURI,
		Account:      parsed.Account,
	}, nil
}

func ProviderConfig(ambientProvider, vertexProjectID, vertexRegion string) map[string]string {
	switch ambientProvider {
	case "vertex":
		cfg := map[string]string{}
		if vertexProjectID != "" {
			cfg["VERTEX_AI_PROJECT_ID"] = vertexProjectID
		}
		if vertexRegion != "" {
			cfg["VERTEX_AI_REGION"] = vertexRegion
		}
		return cfg
	default:
		return nil
	}
}
