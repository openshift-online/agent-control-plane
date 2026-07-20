// Package create implements the create subcommand for sessions and projects.
package create

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/ambient-code/platform/components/ambient-cli/pkg/config"
	"github.com/ambient-code/platform/components/ambient-cli/pkg/connection"
	"github.com/ambient-code/platform/components/ambient-cli/pkg/output"
	sdkclient "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/client"
	sdktypes "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
	"github.com/spf13/cobra"
)

var Cmd = &cobra.Command{
	Use:   "create <resource>",
	Short: "Create a resource",
	Long: `Create a resource.

Valid resource types:
  session         Create an agentic session
  project         Create a project
  project-agent   Assign an agent to a project
  agent           Create an agent
  role            Create a role
  role-binding    Create a role binding
  gateway         Create an OpenShell gateway
  cluster         Register a cluster
`,
	Args: cobra.MinimumNArgs(1),
	RunE: run,
}

var createArgs struct {
	name          string
	prompt        string
	repoURL       string
	model         string
	maxTokens     int
	temperature   float64
	timeout       int
	displayName   string
	description   string
	outputFormat  string
	projectID     string
	agentID       string
	agentVersion  int
	ownerUserID   string
	permissions   string
	userID        string
	roleID        string
	scope         string
	bindProjectID string
	bindAgentID   string
	bindSessionID string
	bindCredID    string
	scopeID       string

	gwImage           string
	gwServerDNS       string
	gwConfig          string
	gwLabels          string
	gwAnnotations     string
	gwOidcIssuer      string
	gwOidcAudience    string
	gwOidcJwksTTL     int
	gwOidcRolesClaim  string
	gwOidcAdminRole   string
	gwOidcUserRole    string
	gwOidcScopesClaim string
	gwRouteHost       string

	apiServerURL string
	role         string
	credentialID string
}

func init() {
	Cmd.Flags().StringVar(&createArgs.name, "name", "", "Resource name")
	Cmd.Flags().StringVar(&createArgs.prompt, "prompt", "", "Session/agent prompt")
	Cmd.Flags().StringVar(&createArgs.repoURL, "repo-url", "", "Repository URL")
	Cmd.Flags().StringVar(&createArgs.model, "model", "", "LLM model")
	Cmd.Flags().IntVar(&createArgs.maxTokens, "max-tokens", 0, "LLM max tokens")
	Cmd.Flags().Float64Var(&createArgs.temperature, "temperature", 0, "LLM temperature")
	Cmd.Flags().IntVar(&createArgs.timeout, "timeout", 0, "Session timeout in seconds")
	Cmd.Flags().StringVar(&createArgs.displayName, "display-name", "", "Display name")
	Cmd.Flags().StringVar(&createArgs.description, "description", "", "Description")
	Cmd.Flags().StringVarP(&createArgs.outputFormat, "output", "o", "", "Output format: json")
	Cmd.Flags().StringVar(&createArgs.projectID, "project", "", "Project ID")
	Cmd.Flags().StringVar(&createArgs.agentID, "agent-id", "", "Agent ID (project-agent)")
	Cmd.Flags().IntVar(&createArgs.agentVersion, "agent-version", 0, "Agent version to pin (project-agent)")
	Cmd.Flags().StringVar(&createArgs.ownerUserID, "owner-user-id", "", "Owner user ID (agent)")
	Cmd.Flags().StringVar(&createArgs.permissions, "permissions", "", "Role permissions (JSON)")
	Cmd.Flags().StringVar(&createArgs.userID, "user-id", "", "User ID (role-binding)")
	Cmd.Flags().StringVar(&createArgs.roleID, "role-id", "", "Role ID (role-binding)")
	Cmd.Flags().StringVar(&createArgs.scope, "scope", "", "Scope (role-binding)")
	Cmd.Flags().StringVar(&createArgs.bindProjectID, "project-fk", "", "Project FK for role-binding")
	Cmd.Flags().StringVar(&createArgs.bindAgentID, "agent-id-fk", "", "Agent FK for role-binding")
	Cmd.Flags().StringVar(&createArgs.bindSessionID, "session-id-fk", "", "Session FK for role-binding")
	Cmd.Flags().StringVar(&createArgs.bindCredID, "credential-id-fk", "", "Credential FK for role-binding")
	Cmd.Flags().StringVar(&createArgs.scopeID, "scope-id", "", "Scope target ID for role-binding (shorthand for --{scope}-id-fk)")

	Cmd.Flags().StringVar(&createArgs.gwImage, "image", "", "Gateway container image reference")
	Cmd.Flags().StringVar(&createArgs.gwServerDNS, "server-dns-names", "", "Comma-separated DNS names for TLS cert generation")
	Cmd.Flags().StringVar(&createArgs.gwConfig, "config", "", "OpenShell gateway TOML configuration")
	Cmd.Flags().StringVar(&createArgs.gwLabels, "labels", "", "Key=value pairs (comma-separated)")
	Cmd.Flags().StringVar(&createArgs.gwAnnotations, "annotations", "", "Key=value pairs (comma-separated)")
	Cmd.Flags().StringVar(&createArgs.gwOidcIssuer, "oidc-issuer", "", "OIDC issuer URL (default: set by platform)")
	Cmd.Flags().StringVar(&createArgs.gwOidcAudience, "oidc-audience", "", "Expected aud claim in JWT")
	Cmd.Flags().IntVar(&createArgs.gwOidcJwksTTL, "oidc-jwks-ttl", 0, "JWKS key cache retention in seconds")
	Cmd.Flags().StringVar(&createArgs.gwOidcRolesClaim, "oidc-roles-claim", "", "Dot-delimited path to roles array in JWT")
	Cmd.Flags().StringVar(&createArgs.gwOidcAdminRole, "oidc-admin-role", "", "Role name conferring admin access")
	Cmd.Flags().StringVar(&createArgs.gwOidcUserRole, "oidc-user-role", "", "Role name conferring user access")
	Cmd.Flags().StringVar(&createArgs.gwOidcScopesClaim, "oidc-scopes-claim", "", "Dot-delimited path to scopes array in JWT")
	Cmd.Flags().StringVar(&createArgs.gwRouteHost, "route-host", "", "Hostname for GRPCRoute exposure (empty = auto-derived)")
	Cmd.Flags().StringVar(&createArgs.apiServerURL, "api-server-url", "", "Cluster API server URL")
	Cmd.Flags().StringVar(&createArgs.role, "role", "", "Cluster role (gateway, workload, hybrid)")
	Cmd.Flags().StringVar(&createArgs.credentialID, "credential-id", "", "Credential ID for cluster")
}

func run(cmd *cobra.Command, cmdArgs []string) error {
	resource := strings.ToLower(cmdArgs[0])

	client, err := connection.NewClientFromConfig()
	if err != nil {
		return err
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), cfg.GetRequestTimeout())
	defer cancel()

	switch resource {
	case "session", "sess":
		return createSession(cmd, ctx, client)
	case "project", "proj":
		return createProject(cmd, ctx, client)
	case "project-agent", "pa":
		return createAgent(cmd, ctx, client)
	case "agent":
		return createAgent(cmd, ctx, client)
	case "role":
		return createRole(cmd, ctx, client)
	case "role-binding", "rolebinding", "rb":
		return createRoleBinding(cmd, ctx, client)
	case "gateway", "gateways", "gw":
		return createGateway(cmd, ctx, client)
	case "cluster", "cl":
		return createCluster(cmd, ctx, client)
	default:
		return fmt.Errorf("unknown resource type: %s\nValid types: session, project, project-agent, agent, role, role-binding, gateway, cluster", cmdArgs[0])
	}
}

func warnUnusedFlags(cmd *cobra.Command, names ...string) {
	for _, name := range names {
		if cmd.Flags().Changed(name) {
			fmt.Fprintf(cmd.ErrOrStderr(), "Warning: --%s is not applicable to this resource type and will be ignored\n", name)
		}
	}
}

func printCreated(cmd *cobra.Command, kind, id string, obj interface{}) error {
	if createArgs.outputFormat == "json" {
		printer := output.NewPrinter(output.FormatJSON, cmd.OutOrStdout())
		return printer.PrintJSON(obj)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "%s/%s created\n", kind, id)
	return nil
}

func createSession(cmd *cobra.Command, ctx context.Context, client *sdkclient.Client) error {
	warnUnusedFlags(cmd, "display-name", "owner-user-id", "permissions", "user-id", "role-id", "scope", "project-fk", "agent-id-fk", "session-id-fk", "credential-id-fk", "recipient-agent-id", "body")

	if createArgs.name == "" {
		return fmt.Errorf("--name is required")
	}

	// Get current project from config
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	projectID := cfg.GetProject()
	if cmd.Flags().Changed("project") {
		projectID = createArgs.projectID
	}
	if projectID == "" {
		return fmt.Errorf("no project set; use --project or run 'acpctl project <name>' first")
	}

	builder := sdktypes.NewSessionBuilder().Name(createArgs.name).ProjectID(projectID)

	if createArgs.prompt != "" {
		builder = builder.Prompt(createArgs.prompt)
	}
	if createArgs.repoURL != "" {
		builder = builder.RepoURL(createArgs.repoURL)
	}
	if createArgs.model != "" {
		builder = builder.LlmModel(createArgs.model)
	}
	if cmd.Flags().Changed("max-tokens") {
		builder = builder.LlmMaxTokens(createArgs.maxTokens)
	}
	if cmd.Flags().Changed("temperature") {
		builder = builder.LlmTemperature(createArgs.temperature)
	}
	if cmd.Flags().Changed("timeout") {
		builder = builder.Timeout(createArgs.timeout)
	}
	if createArgs.agentID != "" {
		builder = builder.AgentID(createArgs.agentID)
	}

	session, err := builder.Build()
	if err != nil {
		return fmt.Errorf("build session: %w", err)
	}

	created, err := client.Sessions().Create(ctx, session)
	if err != nil {
		var apiErr *sdktypes.APIError
		if errors.As(err, &apiErr) && apiErr.StatusCode == 404 {
			return fmt.Errorf("project %q does not exist; run 'acpctl project <name>' to switch projects", projectID)
		}
		return fmt.Errorf("create session: %w", err)
	}

	return printCreated(cmd, "session", created.ID, created)
}

func createProject(cmd *cobra.Command, ctx context.Context, client *sdkclient.Client) error {
	warnUnusedFlags(cmd, "prompt", "repo-url", "model", "max-tokens", "temperature", "timeout", "project", "owner-user-id", "permissions", "user-id", "role-id", "scope", "project-fk", "agent-id-fk", "session-id-fk", "credential-id-fk", "recipient-agent-id", "body")

	if createArgs.name == "" {
		return fmt.Errorf("--name is required")
	}

	builder := sdktypes.NewProjectBuilder().Name(createArgs.name)

	if createArgs.description != "" {
		builder = builder.Description(createArgs.description)
	}

	project, err := builder.Build()
	if err != nil {
		return fmt.Errorf("build project: %w", err)
	}

	created, err := client.Projects().Create(ctx, project)
	if err != nil {
		return fmt.Errorf("create project: %w", err)
	}

	cfg, err := config.Load()
	if err == nil {
		cfg.Project = created.Name
		if saveErr := config.Save(cfg); saveErr == nil {
			fmt.Fprintf(cmd.OutOrStdout(), "Switched to project %q\n", created.Name)
		}
	}

	return printCreated(cmd, "project", created.ID, created)
}

func createAgent(cmd *cobra.Command, ctx context.Context, client *sdkclient.Client) error {
	warnUnusedFlags(cmd, "repo-url", "model", "max-tokens", "temperature", "timeout", "display-name", "description", "owner-user-id", "permissions", "user-id", "role-id", "scope", "project-fk", "agent-id-fk", "session-id-fk", "credential-id-fk")

	if createArgs.name == "" {
		return fmt.Errorf("--name is required")
	}

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	projectID := cfg.GetProject()
	if cmd.Flags().Changed("project") {
		projectID = createArgs.projectID
	}
	if projectID == "" {
		return fmt.Errorf("no project set; use --project or run 'acpctl project <name>' first")
	}

	builder := sdktypes.NewAgentBuilder().
		ProjectID(projectID).
		Name(createArgs.name)

	if createArgs.prompt != "" {
		builder = builder.Prompt(createArgs.prompt)
	}

	pa, err := builder.Build()
	if err != nil {
		return fmt.Errorf("build agent: %w", err)
	}

	created, err := client.Agents().CreateInProject(ctx, projectID, pa)
	if err != nil {
		return fmt.Errorf("create agent: %w", err)
	}

	return printCreated(cmd, "agent", created.ID, created)
}

func createRole(cmd *cobra.Command, ctx context.Context, client *sdkclient.Client) error {
	warnUnusedFlags(cmd, "prompt", "repo-url", "model", "max-tokens", "temperature", "timeout", "project", "owner-user-id", "user-id", "role-id", "scope", "project-fk", "agent-id-fk", "session-id-fk", "credential-id-fk", "recipient-agent-id", "body")

	if createArgs.name == "" {
		return fmt.Errorf("--name is required")
	}

	builder := sdktypes.NewRoleBuilder().Name(createArgs.name)

	if createArgs.displayName != "" {
		builder = builder.DisplayName(createArgs.displayName)
	}
	if createArgs.description != "" {
		builder = builder.Description(createArgs.description)
	}
	if createArgs.permissions != "" {
		builder = builder.Permissions(createArgs.permissions)
	}

	role, err := builder.Build()
	if err != nil {
		return fmt.Errorf("build role: %w", err)
	}

	created, err := client.Roles().Create(ctx, role)
	if err != nil {
		return fmt.Errorf("create role: %w", err)
	}

	return printCreated(cmd, "role", created.ID, created)
}

func createRoleBinding(cmd *cobra.Command, ctx context.Context, client *sdkclient.Client) error {
	warnUnusedFlags(cmd, "name", "prompt", "repo-url", "model", "max-tokens", "temperature", "timeout", "display-name", "description", "project", "owner-user-id", "permissions", "recipient-agent-id", "body")

	if createArgs.roleID == "" {
		return fmt.Errorf("--role-id is required")
	}
	if createArgs.scope == "" {
		return fmt.Errorf("--scope is required")
	}

	if createArgs.scopeID != "" {
		switch createArgs.scope {
		case "project":
			createArgs.bindProjectID = createArgs.scopeID
		case "agent":
			createArgs.bindAgentID = createArgs.scopeID
		case "session":
			createArgs.bindSessionID = createArgs.scopeID
		case "credential":
			createArgs.bindCredID = createArgs.scopeID
		default:
			return fmt.Errorf("--scope-id not supported for scope %q; use the explicit FK flag", createArgs.scope)
		}
	}

	builder := sdktypes.NewRoleBindingBuilder().
		RoleID(createArgs.roleID).
		Scope(createArgs.scope)

	if createArgs.userID != "" {
		builder = builder.UserID(createArgs.userID)
	}
	if createArgs.bindProjectID != "" {
		builder = builder.ProjectID(createArgs.bindProjectID)
	}
	if createArgs.bindAgentID != "" {
		builder = builder.AgentID(createArgs.bindAgentID)
	}
	if createArgs.bindSessionID != "" {
		builder = builder.SessionID(createArgs.bindSessionID)
	}
	if createArgs.bindCredID != "" {
		builder = builder.CredentialID(createArgs.bindCredID)
	}

	rb, err := builder.Build()
	if err != nil {
		return fmt.Errorf("build role-binding: %w", err)
	}

	created, err := client.RoleBindings().Create(ctx, rb)
	if err != nil {
		return fmt.Errorf("create role-binding: %w", err)
	}

	return printCreated(cmd, "role-binding", created.ID, created)
}

func createGateway(cmd *cobra.Command, ctx context.Context, client *sdkclient.Client) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	projectID := cfg.GetProject()
	if cmd.Flags().Changed("project") {
		projectID = createArgs.projectID
	}
	if projectID == "" {
		return fmt.Errorf("no project set; use --project or run 'acpctl project <name>' first")
	}

	gw := &sdktypes.Gateway{
		Name:      "openshell-gateway",
		ProjectID: projectID,
	}

	if cmd.Flags().Changed("name") {
		gw.Name = createArgs.name
	}
	if cmd.Flags().Changed("image") {
		gw.Image = createArgs.gwImage
	}
	if cmd.Flags().Changed("server-dns-names") {
		gw.ServerDnsNames = strings.Split(createArgs.gwServerDNS, ",")
	}
	if cmd.Flags().Changed("config") {
		gw.Config = createArgs.gwConfig
	}
	if cmd.Flags().Changed("labels") {
		parsed, parseErr := parseKeyValuePairs(createArgs.gwLabels)
		if parseErr != nil {
			return fmt.Errorf("invalid --labels: %w", parseErr)
		}
		raw, _ := json.Marshal(parsed)
		gw.Labels = string(raw)
	}
	if cmd.Flags().Changed("annotations") {
		parsed, parseErr := parseKeyValuePairs(createArgs.gwAnnotations)
		if parseErr != nil {
			return fmt.Errorf("invalid --annotations: %w", parseErr)
		}
		raw, _ := json.Marshal(parsed)
		gw.Annotations = string(raw)
	}

	var oidc *sdktypes.GatewayOidc
	oidcFlags := []string{"oidc-issuer", "oidc-audience", "oidc-jwks-ttl", "oidc-roles-claim", "oidc-admin-role", "oidc-user-role", "oidc-scopes-claim"}
	for _, f := range oidcFlags {
		if cmd.Flags().Changed(f) {
			oidc = &sdktypes.GatewayOidc{}
			break
		}
	}
	if oidc != nil {
		if cmd.Flags().Changed("oidc-issuer") {
			oidc.Issuer = createArgs.gwOidcIssuer
		}
		if cmd.Flags().Changed("oidc-audience") {
			oidc.Audience = createArgs.gwOidcAudience
		}
		if cmd.Flags().Changed("oidc-jwks-ttl") {
			oidc.JwksTtl = createArgs.gwOidcJwksTTL
		}
		if cmd.Flags().Changed("oidc-roles-claim") {
			oidc.RolesClaim = createArgs.gwOidcRolesClaim
		}
		if cmd.Flags().Changed("oidc-admin-role") {
			oidc.AdminRole = createArgs.gwOidcAdminRole
		}
		if cmd.Flags().Changed("oidc-user-role") {
			oidc.UserRole = createArgs.gwOidcUserRole
		}
		if cmd.Flags().Changed("oidc-scopes-claim") {
			oidc.ScopesClaim = createArgs.gwOidcScopesClaim
		}
		gw.Oidc = oidc
	}

	if cmd.Flags().Changed("route-host") {
		gw.Route = &sdktypes.GatewayRoute{
			Host: createArgs.gwRouteHost,
		}
	}

	created, err := client.Gateways().Create(ctx, gw)
	if err != nil {
		var apiErr *sdktypes.APIError
		if errors.As(err, &apiErr) && apiErr.StatusCode == 404 {
			return fmt.Errorf("project %q not found — create the project first or run 'acpctl project <name>'", projectID)
		}
		return fmt.Errorf("create gateway: %w", err)
	}

	fmt.Fprintf(cmd.OutOrStdout(), "gateway/%s created in project %s\n", created.Name, projectID)
	return nil
}

func parseKeyValuePairs(input string) (map[string]string, error) {
	result := make(map[string]string)
	for _, pair := range strings.Split(input, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		parts := strings.SplitN(pair, "=", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("expected key=value, got %q", pair)
		}
		result[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
	}
	return result, nil
}

func createCluster(cmd *cobra.Command, ctx context.Context, client *sdkclient.Client) error {
	warnUnusedFlags(cmd, "prompt", "repo-url", "model", "max-tokens", "temperature", "timeout", "display-name", "project", "agent-id", "owner-user-id", "permissions", "user-id", "role-id", "scope", "project-fk", "agent-id-fk", "session-id-fk", "credential-id-fk", "scope-id")

	if createArgs.name == "" {
		return fmt.Errorf("--name is required")
	}
	if createArgs.apiServerURL == "" {
		return fmt.Errorf("--api-server-url is required")
	}
	if createArgs.role == "" {
		return fmt.Errorf("--role is required (gateway, workload, hybrid)")
	}

	builder := sdktypes.NewClusterBuilder().
		Name(createArgs.name).
		APIServerURL(createArgs.apiServerURL).
		Role(createArgs.role)

	if createArgs.description != "" {
		builder = builder.Description(createArgs.description)
	}
	if createArgs.credentialID != "" {
		builder = builder.CredentialID(createArgs.credentialID)
	}

	cluster, err := builder.Build()
	if err != nil {
		return fmt.Errorf("build cluster: %w", err)
	}

	created, err := client.Clusters().Create(ctx, cluster)
	if err != nil {
		return fmt.Errorf("create cluster: %w", err)
	}

	return printCreated(cmd, "cluster", created.ID, created)
}
