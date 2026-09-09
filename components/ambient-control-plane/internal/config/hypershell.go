package config

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
)

// HypershellConfig contains operator-owned placement and trust configuration.
type HypershellConfig struct {
	APIURL              string
	TokenURL            string
	ClientID            string
	ClientSecret        string
	InstanceID          string
	GatewayTemplate     map[string]interface{}
	SandboxDriverConfig map[string]interface{}
	RunnerGRPCAddress   string
	RunnerTokenURL      string
	CACertFile          string
}

func LoadHypershell() (*HypershellConfig, error) {
	c := &HypershellConfig{
		APIURL: os.Getenv("HYPERSHELL_API_URL"), TokenURL: os.Getenv("HYPERSHELL_OIDC_TOKEN_URL"),
		ClientID: os.Getenv("HYPERSHELL_OIDC_CLIENT_ID"), ClientSecret: os.Getenv("HYPERSHELL_OIDC_CLIENT_SECRET"),
		InstanceID: os.Getenv("HYPERSHELL_INSTANCE_ID"), RunnerGRPCAddress: os.Getenv("AMBIENT_RUNNER_GRPC_ADDR"),
		RunnerTokenURL: os.Getenv("AMBIENT_RUNNER_TOKEN_URL"), CACertFile: os.Getenv("HYPERSHELL_CA_CERT_FILE"),
	}
	for name, value := range map[string]string{"HYPERSHELL_API_URL": c.APIURL, "HYPERSHELL_OIDC_TOKEN_URL": c.TokenURL, "AMBIENT_RUNNER_TOKEN_URL": c.RunnerTokenURL} {
		u, err := url.Parse(value)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return nil, fmt.Errorf("%s must be an HTTPS URL without credentials, query, or fragment", name)
		}
	}
	if c.ClientID == "" || c.ClientSecret == "" {
		return nil, fmt.Errorf("hypershell OIDC client credentials are required")
	}
	if len(c.InstanceID) < 8 || len(c.InstanceID) > 100 || strings.ContainsAny(c.InstanceID, "/ \t\r\n") {
		return nil, fmt.Errorf("HYPERSHELL_INSTANCE_ID must be a stable identifier of 8 to 100 characters")
	}
	if host, port, err := net.SplitHostPort(c.RunnerGRPCAddress); err != nil || host == "" || port == "" {
		return nil, fmt.Errorf("AMBIENT_RUNNER_GRPC_ADDR must contain a host and port")
	}
	if err := json.Unmarshal([]byte(os.Getenv("HYPERSHELL_GATEWAY_TEMPLATE")), &c.GatewayTemplate); err != nil || c.GatewayTemplate == nil {
		return nil, fmt.Errorf("HYPERSHELL_GATEWAY_TEMPLATE must be a JSON object")
	}
	for _, reserved := range []string{"name", "external_reference", "id", "namespace", "route_address", "status", "phase"} {
		if _, ok := c.GatewayTemplate[reserved]; ok {
			return nil, fmt.Errorf("HYPERSHELL_GATEWAY_TEMPLATE cannot set %s", reserved)
		}
	}
	if raw := os.Getenv("HYPERSHELL_SANDBOX_DRIVER_CONFIG"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &c.SandboxDriverConfig); err != nil {
			return nil, fmt.Errorf("HYPERSHELL_SANDBOX_DRIVER_CONFIG must be a JSON object")
		}
	}
	return c, nil
}
