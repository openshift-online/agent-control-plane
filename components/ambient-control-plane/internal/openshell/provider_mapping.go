package openshell

import (
	"encoding/json"
	"fmt"
)

var providerTypeMapping = map[string]string{
	"github":     "github",
	"anthropic":  "claude",
	"claude":     "claude",
	"jira":       "generic",
	"google":     "generic",
	"vertex":     "google-vertex-ai",
	"kubeconfig": "generic",
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
	"github": {"GITHUB_TOKEN"},
	"claude": {"ANTHROPIC_API_KEY"},
}

func ProviderInjectedEnvVars(openshellType string) []string {
	return providerInjectedEnvVars[openshellType]
}

var inferenceCapableTypes = map[string]bool{
	"google-vertex-ai": true,
	"claude":           true,
	"anthropic":        true,
	"nvidia":           true,
	"openai":           true,
	"aws-bedrock":      true,
}

func IsInferenceCapable(ambientProvider string) bool {
	osType := OpenShellProviderType(ambientProvider)
	return inferenceCapableTypes[osType]
}

// ProviderCredentials maps an ACP credential token to the OpenShell credential
// key names expected by each provider type's profile.
func ProviderCredentials(ambientProvider, token string) map[string]string {
	switch ambientProvider {
	case "vertex":
		return map[string]string{"GOOGLE_SERVICE_ACCOUNT_KEY": token}
	case "anthropic", "claude":
		return map[string]string{"ANTHROPIC_API_KEY": token}
	case "github":
		return map[string]string{"GITHUB_TOKEN": token}
	default:
		return map[string]string{"token": token}
	}
}

const VertexAIRefreshCredentialKey = "GOOGLE_VERTEX_AI_SERVICE_ACCOUNT_TOKEN"

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
	return &ServiceAccountJWTMaterial{
		ClientEmail: parsed.ClientEmail,
		PrivateKey:  parsed.PrivateKey,
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
