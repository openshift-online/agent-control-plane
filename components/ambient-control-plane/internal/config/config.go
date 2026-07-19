package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
)

type ControlPlaneConfig struct {
	APIServerURL                    string
	APIToken                        string
	GRPCServerAddr                  string
	GRPCUseTLS                      bool
	LogLevel                        string
	Kubeconfig                      string
	Mode                            string
	PlatformMode                    string
	MPPConfigNamespace              string
	CPRuntimeNamespace              string
	OIDCTokenURL                    string
	OIDCClientID                    string
	OIDCClientSecret                string
	Reconcilers                     []string
	RunnerImage                     string
	RunnerGRPCUseTLS                bool
	Namespace                       string
	AnthropicAPIKey                 string
	VertexEnabled                   bool
	VertexProjectID                 string
	VertexRegion                    string
	VertexCredentialsPath           string
	VertexSecretName                string
	VertexSecretNamespace           string
	RunnerImageNamespace            string
	MCPImage                        string
	MCPAPIServerURL                 string
	GitHubMCPImage                  string
	JiraMCPImage                    string
	K8sMCPImage                     string
	GoogleMCPImage                  string
	RunnerLogLevel                  string
	ProjectKubeTokenFile            string
	CPTokenListenAddr               string
	CPTokenURL                      string
	HTTPProxy                       string
	HTTPSProxy                      string
	NoProxy                         string
	ImagePullSecret                 string
	OpenShellEnabled                bool
	OpenShellUseGateway             bool
	OpenShellRunnerImage            string
	OpenShellPolicyName             string
	OpenShellGatewayServiceName     string
	OpenShellGatewayGRPCPort        int
	OpenShellGatewayTLSEnabled      bool
	OpenShellGatewayClientTLSSecret string
	OpenShellGatewayTLSServerName   string
	OpenShellGatewaySATokenPath     string
	ServiceIdentity                 string
	CACertFile                      string
	AllowedSandboxRegistries        []string
	SandboxReadinessTimeoutSeconds  int
	MLflowTrackingURI               string // empty = no default; sandboxes get no URI unless set
	MLflowExperimentName            string // empty = no default; runner falls back to its own default
	MLflowCredentialSecretName      string
	MLflowCredentialSecretNamespace string
	MLflowTracingEnabled            string
	MLflowTrackingAuth              string
	MLflowWorkspace                 string
	MLflowEnableAsyncTraceLogging   string
	MLflowAsyncTraceLoggingWorkers  string
	MLflowAsyncTraceLoggingQueue    string
	MLflowAutologExcludeFlavors     string
	MLflowGenAIAutologIntegrations  string
	ClusterHealthIntervalSeconds    int
	PlacementHeartbeatThresholdSecs int
}

func Load() (*ControlPlaneConfig, error) {
	cfg := &ControlPlaneConfig{
		APIServerURL:                    envOrDefault("AMBIENT_API_SERVER_URL", "http://localhost:8000"),
		APIToken:                        os.Getenv("AMBIENT_API_TOKEN"),
		GRPCServerAddr:                  envOrDefault("AMBIENT_GRPC_SERVER_ADDR", "localhost:8001"),
		GRPCUseTLS:                      os.Getenv("AMBIENT_GRPC_USE_TLS") == "true",
		LogLevel:                        envOrDefault("LOG_LEVEL", "info"),
		Kubeconfig:                      os.Getenv("KUBECONFIG"),
		Mode:                            envOrDefault("MODE", "kube"),
		PlatformMode:                    envOrDefault("PLATFORM_MODE", "standard"),
		MPPConfigNamespace:              envOrDefault("MPP_CONFIG_NAMESPACE", "ambient-code--config"),
		CPRuntimeNamespace:              envOrDefault("CP_RUNTIME_NAMESPACE", envOrDefault("NAMESPACE", "ambient-code")),
		OIDCTokenURL:                    envOrDefault("OIDC_TOKEN_URL", "https://sso.redhat.com/auth/realms/redhat-external/protocol/openid-connect/token"),
		OIDCClientID:                    os.Getenv("OIDC_CLIENT_ID"),
		OIDCClientSecret:                os.Getenv("OIDC_CLIENT_SECRET"),
		Reconcilers:                     parseReconcilers(envOrDefault("RECONCILERS", "tally,kube")),
		RunnerImage:                     envOrDefault("RUNNER_IMAGE", "quay.io/ambient_code/ambient_runner_openshell:latest"),
		RunnerGRPCUseTLS:                os.Getenv("AMBIENT_GRPC_USE_TLS") == "true",
		Namespace:                       envOrDefault("NAMESPACE", "ambient-code"),
		AnthropicAPIKey:                 os.Getenv("ANTHROPIC_API_KEY"),
		VertexEnabled:                   os.Getenv("USE_VERTEX") == "1" || os.Getenv("USE_VERTEX") == "true",
		VertexProjectID:                 os.Getenv("ANTHROPIC_VERTEX_PROJECT_ID"),
		VertexRegion:                    envOrDefault("CLOUD_ML_REGION", "global"),
		VertexCredentialsPath:           envOrDefault("GOOGLE_APPLICATION_CREDENTIALS", "/app/vertex/ambient-code-key.json"),
		VertexSecretName:                envOrDefault("VERTEX_SECRET_NAME", "ambient-vertex"),
		VertexSecretNamespace:           envOrDefault("VERTEX_SECRET_NAMESPACE", "ambient-code"),
		RunnerImageNamespace:            os.Getenv("RUNNER_IMAGE_NAMESPACE"),
		MCPImage:                        os.Getenv("MCP_IMAGE"),
		MCPAPIServerURL:                 envOrDefault("MCP_API_SERVER_URL", ""),
		GitHubMCPImage:                  os.Getenv("GITHUB_MCP_IMAGE"),
		JiraMCPImage:                    os.Getenv("JIRA_MCP_IMAGE"),
		K8sMCPImage:                     os.Getenv("K8S_MCP_IMAGE"),
		GoogleMCPImage:                  os.Getenv("GOOGLE_MCP_IMAGE"),
		RunnerLogLevel:                  envOrDefault("RUNNER_LOG_LEVEL", "info"),
		ProjectKubeTokenFile:            os.Getenv("PROJECT_KUBE_TOKEN_FILE"),
		CPTokenListenAddr:               envOrDefault("CP_TOKEN_LISTEN_ADDR", ":8080"),
		CPTokenURL:                      os.Getenv("CP_TOKEN_URL"),
		HTTPProxy:                       os.Getenv("HTTP_PROXY"),
		HTTPSProxy:                      os.Getenv("HTTPS_PROXY"),
		NoProxy:                         os.Getenv("NO_PROXY"),
		ImagePullSecret:                 os.Getenv("IMAGE_PULL_SECRET"),
		OpenShellEnabled:                os.Getenv("OPENSHELL_ENABLED") == "true",
		OpenShellUseGateway:             os.Getenv("OPENSHELL_USE_GATEWAY") == "true",
		OpenShellRunnerImage:            envOrDefault("OPENSHELL_RUNNER_IMAGE", "quay.io/ambient_code/acp_runner_openshell:latest"),
		OpenShellPolicyName:             envOrDefault("OPENSHELL_POLICY_CONFIGMAP", "openshell-policy"),
		OpenShellGatewayServiceName:     envOrDefault("OPENSHELL_GATEWAY_SERVICE_NAME", "openshell-gateway"),
		OpenShellGatewayGRPCPort:        envOrDefaultInt("OPENSHELL_GATEWAY_GRPC_PORT", 8080),
		OpenShellGatewayTLSEnabled:      os.Getenv("OPENSHELL_GATEWAY_TLS") != "false",
		OpenShellGatewayClientTLSSecret: envOrDefault("OPENSHELL_GATEWAY_CLIENT_TLS_SECRET", "openshell-client-tls"),
		OpenShellGatewayTLSServerName:   os.Getenv("OPENSHELL_GATEWAY_TLS_SERVER_NAME"),
		OpenShellGatewaySATokenPath:     envOrDefault("OPENSHELL_GATEWAY_SA_TOKEN_PATH", "/var/run/secrets/kubernetes.io/serviceaccount/token"),
		ServiceIdentity:                 strings.TrimSpace(os.Getenv("GRPC_SERVICE_ACCOUNT")),
		CACertFile:                      envOrDefault("CA_CERT_FILE", "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem"),
		AllowedSandboxRegistries:        parseAllowedRegistries(os.Getenv("ALLOWED_SANDBOX_REGISTRIES")),
		SandboxReadinessTimeoutSeconds:  envOrDefaultInt("SANDBOX_READINESS_TIMEOUT_SECONDS", 600),
		MLflowTrackingURI:               strings.TrimSpace(os.Getenv("MLFLOW_TRACKING_URI")),
		MLflowExperimentName:            os.Getenv("MLFLOW_EXPERIMENT_NAME"),
		MLflowCredentialSecretName:      envOrDefault("MLFLOW_CREDENTIAL_SECRET_NAME", "mlflow"),
		MLflowCredentialSecretNamespace: os.Getenv("MLFLOW_CREDENTIAL_SECRET_NAMESPACE"),
		MLflowTracingEnabled:            os.Getenv("MLFLOW_TRACING_ENABLED"),
		MLflowTrackingAuth:              os.Getenv("MLFLOW_TRACKING_AUTH"),
		MLflowWorkspace:                 os.Getenv("MLFLOW_WORKSPACE"),
		MLflowEnableAsyncTraceLogging:   os.Getenv("MLFLOW_ENABLE_ASYNC_TRACE_LOGGING"),
		MLflowAsyncTraceLoggingWorkers:  os.Getenv("MLFLOW_ASYNC_TRACE_LOGGING_MAX_WORKERS"),
		MLflowAsyncTraceLoggingQueue:    os.Getenv("MLFLOW_ASYNC_TRACE_LOGGING_MAX_QUEUE_SIZE"),
		MLflowAutologExcludeFlavors:     os.Getenv("MLFLOW_AUTOLOG_EXCLUDE_FLAVORS"),
		MLflowGenAIAutologIntegrations:  os.Getenv("MLFLOW_GENAI_AUTOLOG_INTEGRATIONS"),
		ClusterHealthIntervalSeconds:    envOrDefaultInt("CLUSTER_HEALTH_INTERVAL", 30),
		PlacementHeartbeatThresholdSecs: envOrDefaultInt("PLACEMENT_HEARTBEAT_THRESHOLD", 120),
	}

	if cfg.MCPAPIServerURL == "" {
		cfg.MCPAPIServerURL = cfg.APIServerURL
	}
	if cfg.MLflowCredentialSecretNamespace == "" {
		cfg.MLflowCredentialSecretNamespace = cfg.CPRuntimeNamespace
	}
	if err := validateMLflowTrackingURI(cfg.MLflowTrackingURI); err != nil {
		return nil, err
	}

	if cfg.APIToken == "" && (cfg.OIDCClientID == "" || cfg.OIDCClientSecret == "") {
		return nil, fmt.Errorf("either AMBIENT_API_TOKEN or both OIDC_CLIENT_ID and OIDC_CLIENT_SECRET must be set; set AMBIENT_API_TOKEN for k8s SA token auth or OIDC_CLIENT_ID+OIDC_CLIENT_SECRET for OIDC")
	}

	switch cfg.Mode {
	case "kube", "test":
	default:
		return nil, fmt.Errorf("unknown MODE %q: must be one of kube, test", cfg.Mode)
	}

	switch cfg.PlatformMode {
	case "standard", "mpp":
	default:
		return nil, fmt.Errorf("unknown PLATFORM_MODE %q: must be one of standard, mpp", cfg.PlatformMode)
	}

	return cfg, nil
}

func validateMLflowTrackingURI(raw string) error {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return fmt.Errorf("MLFLOW_TRACKING_URI is invalid: %w", err)
	}
	host := parsed.Hostname()
	if parsed.Scheme == "" || host == "" {
		return fmt.Errorf("MLFLOW_TRACKING_URI must be an absolute URL with a host")
	}
	if parsed.User != nil {
		return fmt.Errorf("MLFLOW_TRACKING_URI must not include credentials")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && isLoopbackHost(host)) {
		return fmt.Errorf("MLFLOW_TRACKING_URI must use https, except http loopback for local development")
	}
	return nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envOrDefaultInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

var defaultAllowedSandboxRegistries = []string{
	"quay.io/ambient_code/",
	"ghcr.io/nvidia/",
}

func parseAllowedRegistries(val string) []string {
	if val == "" {
		return defaultAllowedSandboxRegistries
	}
	parts := strings.Split(val, ",")
	var result []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			result = append(result, p)
		}
	}
	if len(result) == 0 {
		return defaultAllowedSandboxRegistries
	}
	return result
}

func parseReconcilers(reconcilersStr string) []string {
	if reconcilersStr == "" {
		return []string{"tally"}
	}

	reconcilers := strings.Split(reconcilersStr, ",")
	var result []string
	for _, r := range reconcilers {
		r = strings.TrimSpace(r)
		if r != "" {
			result = append(result, r)
		}
	}

	if len(result) == 0 {
		return []string{"tally"}
	}

	return result
}
