package openshell

var providerTypeMapping = map[string]string{
	"github":     "github",
	"anthropic":  "claude",
	"claude":     "claude",
	"jira":       "generic",
	"google":     "generic",
	"vertex":     "vertex-prod",
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
