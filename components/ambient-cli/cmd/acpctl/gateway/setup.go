package gateway

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/ambient-code/platform/components/ambient-cli/pkg/config"
	"github.com/ambient-code/platform/components/ambient-cli/pkg/connection"
	"github.com/ambient-code/platform/components/ambient-cli/pkg/output"
	sdkclient "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/client"
	sdktypes "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
	"github.com/spf13/cobra"
)

var setupArgs struct {
	gatewayURL string
	project    string
	localName  string
	printOnly  bool
	kubectl    bool
}

var setupCmd = &cobra.Command{
	Use:   "setup-cli [name]",
	Short: "Configure openshell CLI access for a gateway",
	Long: `Configure local openshell CLI access for a named gateway.

By default, uses the gateway's route address (populated when the gateway has
an OpenShift Route) as the gateway URL. If no route address is available,
use --kubectl to fall back to port-forward and cert extraction via kubectl,
or provide --gateway-url to specify a URL directly.

Reads the gateway's authentication configuration from the API server
and registers it with the openshell CLI. For OIDC-enabled gateways,
the user's existing acpctl credentials are used to configure openshell
non-interactively. If no acpctl credentials are available, the
interactive browser-based OIDC flow is used instead.

If the gateway was previously registered, re-authenticates using the
existing registration instead of creating a new one.

The API-side gateway name defaults to "openshell-gateway" if not specified.
The local openshell registration is named "<project>-openshell-gateway"
by default. Use --name to override the local registration name (e.g.
to match an existing convention like using the namespace name directly).

Use --print to show the openshell commands instead of running them.

Requires openshell to be installed.`,
	Example: `  acpctl gateway setup-cli --project tenant-a
  acpctl gateway setup-cli my-gateway --gateway-url https://gateway.example.com:8080
  acpctl gateway setup-cli --kubectl --project tenant-a
  acpctl gateway setup-cli --kubectl --project tenant-a --name tenant-a
  acpctl gateway setup-cli --project tenant-a --print`,
	Args: cobra.MaximumNArgs(1),
	RunE: runSetup,
}

func init() {
	setupCmd.Flags().StringVar(&setupArgs.gatewayURL, "gateway-url", "", "Gateway URL (e.g. https://gateway.example.com:8080). If omitted, uses the gateway's route address")
	setupCmd.Flags().StringVar(&setupArgs.project, "project", "", "Project/namespace to look up the gateway in (defaults to configured project)")
	setupCmd.Flags().StringVar(&setupArgs.localName, "name", "", "Local openshell registration name (defaults to <project>-<gateway-name>)")
	setupCmd.Flags().BoolVar(&setupArgs.printOnly, "print", false, "Print the openshell commands instead of running them")
	setupCmd.Flags().BoolVar(&setupArgs.kubectl, "kubectl", false, "Fall back to kubectl port-forward and cert extraction when no route address is available")
}

func runSetup(cmd *cobra.Command, args []string) error {
	factory, err := connection.NewClientFactory()
	if err != nil {
		return err
	}

	project := setupArgs.project
	if project == "" {
		cfg, err := config.Load()
		if err != nil {
			return err
		}
		project = cfg.GetProject()
		if project == "" {
			return fmt.Errorf("no project set; use --project or run 'acpctl config set project <name>'")
		}
	}

	client, err := factory.ForProject(project)
	if err != nil {
		return err
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), cfg.GetRequestTimeout())
	defer cancel()

	apiGWName := "openshell-gateway"
	if len(args) > 0 {
		apiGWName = args[0]
	}

	gw, err := findGateway(ctx, client, apiGWName)
	if err != nil {
		return err
	}

	gwURL := setupArgs.gatewayURL
	if gwURL == "" {
		if gw.RouteAddress != "" {
			gwURL = gw.RouteAddress
		} else if setupArgs.kubectl {
			gwURL = ""
		} else {
			return fmt.Errorf("gateway %q has no route address; use --kubectl for port-forward mode or --gateway-url to specify a URL", apiGWName)
		}
	}

	localName := setupArgs.localName
	if localName == "" {
		localName = resolveLocalName(project, apiGWName)
	}

	format, err := output.ParseFormat("")
	if err != nil {
		return err
	}
	printer := output.NewPrinter(format, cmd.OutOrStdout())

	if setupArgs.kubectl && gwURL == "" {
		return setupOpenshellKubectl(printer.Writer(), gw, cfg, localName, project, setupArgs.printOnly)
	}

	return setupOpenshellGateway(printer.Writer(), gw, cfg, localName, gwURL, project, setupArgs.printOnly, false)
}

func findGateway(ctx context.Context, client *sdkclient.Client, nameOrID string) (*sdktypes.Gateway, error) {
	gw, err := client.Gateways().Get(ctx, nameOrID)
	if err == nil {
		return gw, nil
	}

	page := 1
	pageSize := 100
	for {
		opts := sdktypes.NewListOptions().Page(page).Size(pageSize).Build()
		list, err2 := client.Gateways().List(ctx, opts)
		if err2 != nil {
			return nil, fmt.Errorf("list gateways: %w", err2)
		}
		for i := range list.Items {
			if list.Items[i].Name == nameOrID {
				return &list.Items[i], nil
			}
		}
		if len(list.Items) < pageSize {
			break
		}
		page++
	}
	return nil, fmt.Errorf("gateway %q not found", nameOrID)
}

func stripANSI(s string) string {
	var out strings.Builder
	i := 0
	for i < len(s) {
		if s[i] == '\x1b' && i+1 < len(s) && s[i+1] == '[' {
			j := i + 2
			for j < len(s) && ((s[j] >= '0' && s[j] <= '9') || s[j] == ';') {
				j++
			}
			if j < len(s) {
				j++
			}
			i = j
			continue
		}
		out.WriteByte(s[i])
		i++
	}
	return out.String()
}

func listOpenshellGateways() map[string]bool {
	names := make(map[string]bool)
	out, err := exec.Command("openshell", "gateway", "list").Output()
	if err != nil {
		return names
	}
	scanner := bufio.NewScanner(strings.NewReader(stripANSI(string(out))))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 0 {
			continue
		}
		name := fields[0]
		if name == "*" && len(fields) > 1 {
			name = fields[1]
		}
		if strings.ToUpper(name) == "NAME" {
			continue
		}
		names[name] = true
	}
	return names
}

func openshellConfigDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "openshell")
}

func gatewayRegistered(localName string) bool {
	return listOpenshellGateways()[localName]
}

func resolveLocalName(project, apiGWName string) string {
	return project + "-" + apiGWName
}

func isLocalURL(url string) bool {
	return strings.Contains(url, "localhost") || strings.Contains(url, "127.0.0.1")
}

func buildAddArgs(localName, gwURL string, oidc *sdktypes.GatewayOidc) []string {
	args := []string{"gateway", "add", "--name", localName}
	if oidc != nil && oidc.Issuer != "" {
		args = append(args,
			"--oidc-issuer", oidc.Issuer,
			"--oidc-client-id", oidc.Audience,
			"--oidc-audience", oidc.Audience,
		)
	}
	if isLocalURL(gwURL) {
		args = append(args, "--gateway-insecure")
	}
	args = append(args, gwURL)
	return args
}

func buildLoginArgs(localName, gwURL string) []string {
	args := []string{"gateway", "login", "-g", localName}
	if isLocalURL(gwURL) {
		args = append(args, "--gateway-insecure")
	}
	return args
}

type gatewayMetadata struct {
	Name            string `json:"name"`
	GatewayEndpoint string `json:"gateway_endpoint"`
	IsRemote        bool   `json:"is_remote"`
	GatewayPort     int    `json:"gateway_port"`
	AuthMode        string `json:"auth_mode"`
	OIDCIssuer      string `json:"oidc_issuer,omitempty"`
	OIDCClientID    string `json:"oidc_client_id,omitempty"`
	OIDCAudience    string `json:"oidc_audience,omitempty"`
}

type oidcTokenFile struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ExpiresAt    int64  `json:"expires_at,omitempty"`
	Issuer       string `json:"issuer"`
	ClientID     string `json:"client_id"`
}

// fetchClientTLS extracts mTLS certificates from the gateway's namespace:
//   - ca.crt from openshell-ca-tls (root CA that signed the server cert)
//   - tls.crt/tls.key from openshell-client-tls (client identity)
func fetchClientTLS(localName, namespace string) error {
	if _, err := exec.LookPath("kubectl"); err != nil {
		return fmt.Errorf("kubectl not found in PATH")
	}

	base := openshellConfigDir()
	if base == "" {
		return fmt.Errorf("cannot determine home directory")
	}

	mtlsDir := filepath.Join(base, "gateways", localName, "mtls")
	if err := os.MkdirAll(mtlsDir, 0700); err != nil {
		return fmt.Errorf("create mtls dir: %w", err)
	}

	files := []struct {
		secret string
		field  string
		name   string
		perm   os.FileMode
	}{
		{"openshell-ca-tls", "ca\\.crt", "ca.crt", 0644},
		{"openshell-client-tls", "tls\\.crt", "tls.crt", 0644},
		{"openshell-client-tls", "tls\\.key", "tls.key", 0600},
	}

	for _, f := range files {
		out, err := exec.Command("kubectl", "get", "secret", f.secret,
			"-n", namespace,
			"-o", fmt.Sprintf("jsonpath={.data.%s}", f.field),
		).Output()
		if err != nil {
			return fmt.Errorf("fetch %s from %s/%s: %w", f.name, namespace, f.secret, err)
		}

		decoded, err := base64.StdEncoding.DecodeString(string(out))
		if err != nil {
			return fmt.Errorf("decode %s: %w", f.name, err)
		}

		if err := os.WriteFile(filepath.Join(mtlsDir, f.name), decoded, f.perm); err != nil {
			return fmt.Errorf("write %s: %w", f.name, err)
		}
	}
	return nil
}

func gatewayAuthMode(gw *sdktypes.Gateway) string {
	if gw.Oidc != nil && gw.Oidc.Issuer != "" {
		return "oidc"
	}
	return "mtls"
}

func writeGatewayConfig(localName, gwURL, authMode string, oidc *sdktypes.GatewayOidc) error {
	base := openshellConfigDir()
	if base == "" {
		return fmt.Errorf("cannot determine home directory")
	}

	gwDir := filepath.Join(base, "gateways", localName)
	if err := os.MkdirAll(gwDir, 0700); err != nil {
		return fmt.Errorf("create gateway dir: %w", err)
	}

	meta := &gatewayMetadata{
		Name:            localName,
		GatewayEndpoint: gwURL,
		IsRemote:        true,
		GatewayPort:     0,
		AuthMode:        authMode,
	}
	if authMode == "oidc" && oidc != nil {
		meta.OIDCIssuer = oidc.Issuer
		meta.OIDCClientID = oidc.Audience
		meta.OIDCAudience = oidc.Audience
	}

	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal metadata: %w", err)
	}

	return os.WriteFile(filepath.Join(gwDir, "metadata.json"), data, 0600)
}

func writeOIDCToken(localName string, cfg *config.Config, gwOidc *sdktypes.GatewayOidc) error {
	accessToken := cfg.GetToken()
	if accessToken == "" {
		return fmt.Errorf("no access token in acpctl config; run 'acpctl login' first")
	}

	token := &oidcTokenFile{
		AccessToken:  accessToken,
		RefreshToken: cfg.RefreshToken,
		Issuer:       gwOidc.Issuer,
		ClientID:     gwOidc.Audience,
	}

	base := openshellConfigDir()
	if base == "" {
		return fmt.Errorf("cannot determine home directory")
	}

	tokenPath := filepath.Join(base, "gateways", localName, "oidc_token.json")

	if err := os.MkdirAll(filepath.Dir(tokenPath), 0700); err != nil {
		return fmt.Errorf("create token dir: %w", err)
	}

	data, err := json.MarshalIndent(token, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal token: %w", err)
	}

	return os.WriteFile(tokenPath, data, 0600)
}

func hasACPCredentials(cfg *config.Config) bool {
	return cfg.GetToken() != ""
}

func setupOpenshellGateway(w io.Writer, gw *sdktypes.Gateway, cfg *config.Config, localName, gwURL, namespace string, printOnly, fetchClusterCerts bool) error {
	if _, err := exec.LookPath("openshell"); err != nil {
		return fmt.Errorf("openshell not found in PATH: required for gateway setup")
	}

	gwURL = strings.TrimRight(gwURL, "/")
	alreadyRegistered := gatewayRegistered(localName)
	authMode := gatewayAuthMode(gw)
	hasCreds := hasACPCredentials(cfg)

	if printOnly {
		addArgs := buildAddArgs(localName, gwURL, gw.Oidc)
		loginArgs := buildLoginArgs(localName, gwURL)

		fmt.Fprintf(w, "# Register a new gateway\n")
		fmt.Fprintf(w, "  openshell %s\n", strings.Join(addArgs, " "))
		fmt.Fprintf(w, "\n# Re-authenticate an existing gateway\n")
		fmt.Fprintf(w, "  openshell %s\n", strings.Join(loginArgs, " "))
		fmt.Fprintf(w, "\n# Verify connectivity\n")
		fmt.Fprintf(w, "  openshell -g %s provider list\n", localName)
		return nil
	}

	if alreadyRegistered {
		fmt.Fprintf(w, "Gateway %s is already registered, refreshing credentials...\n", localName)
		if authMode == "mtls" {
			if fetchClusterCerts {
				if err := fetchClientTLS(localName, namespace); err != nil {
					return fmt.Errorf("refresh mTLS certs: %w", err)
				}
				fmt.Fprintf(w, "mTLS certificates refreshed\n")
			} else {
				fmt.Fprintf(w, "mTLS gateway already registered\n")
			}
		} else if hasCreds {
			if err := writeOIDCToken(localName, cfg, gw.Oidc); err != nil {
				return fmt.Errorf("OIDC token injection: %w", err)
			}
			if fetchClusterCerts {
				if err := fetchClientTLS(localName, namespace); err != nil {
					fmt.Fprintf(w, "Warning: could not refresh mTLS certs: %v\n", err)
				}
			}
			fmt.Fprintf(w, "OIDC credentials refreshed from acpctl\n")
		} else {
			loginArgs := buildLoginArgs(localName, gwURL)
			loginCmd := exec.Command("openshell", loginArgs...)
			loginCmd.Stdin = os.Stdin
			loginCmd.Stdout = os.Stdout
			loginCmd.Stderr = os.Stderr
			if err := loginCmd.Run(); err != nil {
				return fmt.Errorf("openshell gateway login: %w", err)
			}
		}
	} else {
		fmt.Fprintf(w, "Registering new gateway %s -> %s (%s)...\n", localName, gwURL, authMode)
		if authMode == "mtls" {
			if err := writeGatewayConfig(localName, gwURL, "mtls", nil); err != nil {
				return fmt.Errorf("write gateway config: %w", err)
			}
			if fetchClusterCerts {
				if err := fetchClientTLS(localName, namespace); err != nil {
					return fmt.Errorf("fetch mTLS certs: %w", err)
				}
			}
			fmt.Fprintf(w, "mTLS credentials configured\n")
		} else if hasCreds {
			if err := writeGatewayConfig(localName, gwURL, "oidc", gw.Oidc); err != nil {
				return fmt.Errorf("write gateway config: %w", err)
			}
			if err := writeOIDCToken(localName, cfg, gw.Oidc); err != nil {
				return fmt.Errorf("OIDC token injection: %w", err)
			}
			if fetchClusterCerts {
				if err := fetchClientTLS(localName, namespace); err != nil {
					fmt.Fprintf(w, "Warning: could not fetch mTLS certs: %v\n", err)
					fmt.Fprintf(w, "Ensure kubectl has access to namespace %q or manually provision certs\n", namespace)
				}
			}
			fmt.Fprintf(w, "OIDC credentials configured from acpctl\n")
		} else {
			addArgs := buildAddArgs(localName, gwURL, gw.Oidc)
			addCmd := exec.Command("openshell", addArgs...)
			addCmd.Stdin = os.Stdin
			addCmd.Stdout = os.Stdout
			addCmd.Stderr = os.Stderr
			if err := addCmd.Run(); err != nil {
				return fmt.Errorf("openshell gateway add failed: %w", err)
			}
		}
	}

	fmt.Fprintf(w, "Verifying gateway connectivity...\n")
	if err := verifyGateway(localName); err != nil {
		if !alreadyRegistered {
			cleanupGatewayConfig(localName)
		}
		return fmt.Errorf("gateway at %s is not reachable: %w", gwURL, err)
	}

	fmt.Fprintf(w, "Gateway %s configured and verified\n", localName)
	fmt.Fprintf(w, "\nUsage:\n")
	fmt.Fprintf(w, "  openshell sandbox list --gateway %s\n", localName)

	return nil
}

func setupOpenshellKubectl(w io.Writer, gw *sdktypes.Gateway, cfg *config.Config, localName, namespace string, printOnly bool) error {
	if _, err := exec.LookPath("openshell"); err != nil {
		return fmt.Errorf("openshell not found in PATH: required for gateway setup")
	}
	if _, err := exec.LookPath("kubectl"); err != nil {
		return fmt.Errorf("kubectl not found in PATH: required for --kubectl mode")
	}

	if printOnly {
		fmt.Fprintf(w, "# Set up port-forward to gateway\n")
		fmt.Fprintf(w, "  kubectl port-forward -n %s svc/openshell-gateway 8080:8080 &\n", namespace)
		fmt.Fprintf(w, "\n# Register gateway\n")
		addArgs := buildAddArgs(localName, "https://localhost:8080", gw.Oidc)
		fmt.Fprintf(w, "  openshell %s\n", strings.Join(addArgs, " "))
		fmt.Fprintf(w, "\n# Verify connectivity\n")
		fmt.Fprintf(w, "  openshell -g %s provider list\n", localName)
		return nil
	}

	fmt.Fprintf(w, "Starting kubectl port-forward to %s/openshell-gateway...\n", namespace)
	pfCmd := exec.Command("kubectl", "port-forward", "-n", namespace, "svc/openshell-gateway", "0:8080")

	// Write kubectl output to a temp file instead of a pipe so the
	// port-forward survives after this process exits. A pipe would
	// deliver SIGPIPE to kubectl on its next log write once the reader
	// (this process) exits.
	pfLog, err := os.CreateTemp("", "acpctl-pf-*.log")
	if err != nil {
		return fmt.Errorf("create port-forward log: %w", err)
	}
	pfLogPath := pfLog.Name()
	pfCmd.Stdout = pfLog
	pfCmd.Stderr = pfLog
	if err := pfCmd.Start(); err != nil {
		_ = pfLog.Close()
		_ = os.Remove(pfLogPath)
		return fmt.Errorf("start port-forward: %w", err)
	}

	var localPort string
	for range 60 {
		time.Sleep(100 * time.Millisecond)
		data, _ := os.ReadFile(pfLogPath)
		if idx := strings.Index(string(data), "Forwarding from 127.0.0.1:"); idx >= 0 {
			rest := string(data)[idx+len("Forwarding from 127.0.0.1:"):]
			if endIdx := strings.Index(rest, " "); endIdx > 0 {
				localPort = rest[:endIdx]
			}
			break
		}
	}
	_ = pfLog.Close()
	if localPort == "" {
		if pfCmd.Process != nil {
			_ = pfCmd.Process.Kill()
		}
		_ = os.Remove(pfLogPath)
		return fmt.Errorf("could not determine local port from kubectl port-forward")
	}

	gwURL := "https://localhost:" + localPort
	fmt.Fprintf(w, "Port-forward active at %s (PID %d)\n", gwURL, pfCmd.Process.Pid)

	if err := setupOpenshellGateway(w, gw, cfg, localName, gwURL, namespace, false, true); err != nil {
		if pfCmd.Process != nil {
			_ = pfCmd.Process.Kill()
		}
		return err
	}
	fmt.Fprintf(w, "Port-forward running in background (PID %d) — kill it when done\n", pfCmd.Process.Pid)
	return nil
}

func verifyGateway(localName string) error {
	out, err := exec.Command("openshell", "status", "-g", localName).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s", strings.TrimSpace(stripANSI(string(out))))
	}
	return nil
}

func cleanupGatewayConfig(localName string) {
	base := openshellConfigDir()
	if base == "" {
		return
	}
	gwDir := filepath.Join(base, "gateways", localName)
	_ = os.RemoveAll(gwDir)
}
