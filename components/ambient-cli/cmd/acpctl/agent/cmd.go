// Package agent implements the agent subcommand for managing agents.
package agent

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/ambient-code/platform/components/ambient-cli/pkg/config"
	"github.com/ambient-code/platform/components/ambient-cli/pkg/connection"
	"github.com/ambient-code/platform/components/ambient-cli/pkg/output"
	sdkclient "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/client"
	sdktypes "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
	"github.com/spf13/cobra"
)

var activePhases = map[string]bool{"Pending": true, "Creating": true, "Running": true}

var Cmd = &cobra.Command{
	Use:   "agent",
	Short: "Manage project-scoped agents",
	Long: `Manage project-scoped agents.

Subcommands:
  list           List agents in a project
  get            Get a specific agent
  create         Create an agent in a project
  update         Update an agent's name, prompt, labels, or annotations
  delete         Delete an agent
  start          Start a session for an agent (idempotent)
  stop           Stop the running session for an agent (idempotent)
  start-preview  Preview start context (dry run)
  export         Export agent as ConfigMap YAML`,
	RunE: func(cmd *cobra.Command, args []string) error {
		return cmd.Help()
	},
}

func resolveProject(projectID string) (string, error) {
	if projectID != "" {
		return projectID, nil
	}
	cfg, err := config.Load()
	if err != nil {
		return "", err
	}
	p := cfg.GetProject()
	if p == "" {
		return "", fmt.Errorf("no project set; use --project-id or run 'acpctl config set project <name>'")
	}
	return p, nil
}

func resolveAgent(ctx context.Context, client *sdkclient.Client, projectID, agentArg string) (string, error) {
	if agentArg == "" {
		return "", fmt.Errorf("agent name or ID is required")
	}
	pa, err := client.Agents().GetInProject(ctx, projectID, agentArg)
	if err != nil {
		pa2, err2 := client.Agents().GetByProject(ctx, projectID, agentArg)
		if err2 != nil {
			return "", fmt.Errorf("agent %q not found in project %q", agentArg, projectID)
		}
		return pa2.ID, nil
	}
	return pa.ID, nil
}

func resolveAgentFull(ctx context.Context, client *sdkclient.Client, projectID, agentArg string) (*sdktypes.Agent, error) {
	if agentArg == "" {
		return nil, fmt.Errorf("agent name or ID is required")
	}
	pa, err := client.Agents().GetInProject(ctx, projectID, agentArg)
	if err != nil {
		pa, err = client.Agents().GetByProject(ctx, projectID, agentArg)
		if err != nil {
			return nil, fmt.Errorf("agent %q not found in project %q", agentArg, projectID)
		}
	}
	return pa, nil
}

func allAgentsInProject(ctx context.Context, client *sdkclient.Client, projectID string) ([]sdktypes.Agent, error) {
	opts := sdktypes.NewListOptions().Size(500).Build()
	list, err := client.Agents().ListByProject(ctx, projectID, opts)
	if err != nil {
		return nil, fmt.Errorf("list agents: %w", err)
	}
	return list.Items, nil
}

var listArgs struct {
	projectID    string
	outputFormat string
	limit        int
}

var listCmd = &cobra.Command{
	Use:   "list",
	Short: "List agents in a project",
	Example: `  acpctl agent list
  acpctl agent list --project-id <id> -o json`,
	RunE: func(cmd *cobra.Command, args []string) error {
		projectID, err := resolveProject(listArgs.projectID)
		if err != nil {
			return err
		}

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

		format, err := output.ParseFormat(listArgs.outputFormat)
		if err != nil {
			return err
		}
		printer := output.NewPrinter(format, cmd.OutOrStdout())

		opts := sdktypes.NewListOptions().Size(listArgs.limit).Build()
		list, err := client.Agents().ListByProject(ctx, projectID, opts)
		if err != nil {
			return fmt.Errorf("list agents: %w", err)
		}

		if printer.Format() == output.FormatJSON {
			return printer.PrintJSON(list)
		}
		if printer.Format() == output.FormatYAML {
			return printer.PrintYAML(list)
		}

		return printAgentTable(printer, list.Items)
	},
}

var getArgs struct {
	projectID    string
	outputFormat string
}

var getCmd = &cobra.Command{
	Use:   "get <name-or-id>",
	Short: "Get a specific agent",
	Args:  cobra.ExactArgs(1),
	Example: `  acpctl agent get api
  acpctl agent get api -o json
  acpctl agent get <id> --project-id <id>`,
	RunE: func(cmd *cobra.Command, args []string) error {
		projectID, err := resolveProject(getArgs.projectID)
		if err != nil {
			return err
		}

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

		pa, err := client.Agents().GetInProject(ctx, projectID, args[0])
		if err != nil {
			pa, err = client.Agents().GetByProject(ctx, projectID, args[0])
			if err != nil {
				return fmt.Errorf("get agent %q: %w", args[0], err)
			}
		}

		format, err := output.ParseFormat(getArgs.outputFormat)
		if err != nil {
			return err
		}
		printer := output.NewPrinter(format, cmd.OutOrStdout())

		if printer.Format() == output.FormatJSON {
			return printer.PrintJSON(pa)
		}
		if printer.Format() == output.FormatYAML {
			return printer.PrintYAML(pa)
		}
		return printAgentDetail(cmd, pa)
	},
}

var createArgs struct {
	projectID    string
	name         string
	prompt       string
	labels       string
	annotations  string
	outputFormat string
}

var createCmd = &cobra.Command{
	Use:   "create",
	Short: "Create an agent in a project",
	Example: `  acpctl agent create --name my-agent
  acpctl agent create --name my-agent --prompt "You are a code reviewer"
  acpctl agent create --project-id <id> --name my-agent`,
	RunE: func(cmd *cobra.Command, args []string) error {
		projectID, err := resolveProject(createArgs.projectID)
		if err != nil {
			return err
		}
		if createArgs.name == "" {
			return fmt.Errorf("--name is required")
		}

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

		builder := sdktypes.NewAgentBuilder().
			ProjectID(projectID).
			Name(createArgs.name)

		if createArgs.prompt != "" {
			builder = builder.Prompt(createArgs.prompt)
		}
		if createArgs.labels != "" {
			builder = builder.Labels(createArgs.labels)
		}
		if createArgs.annotations != "" {
			builder = builder.Annotations(createArgs.annotations)
		}

		agent, err := builder.Build()
		if err != nil {
			return fmt.Errorf("build agent: %w", err)
		}

		created, err := client.Agents().CreateInProject(ctx, projectID, agent)
		if err != nil {
			return fmt.Errorf("create agent: %w", err)
		}

		format, err := output.ParseFormat(createArgs.outputFormat)
		if err != nil {
			return err
		}
		printer := output.NewPrinter(format, cmd.OutOrStdout())

		if printer.Format() == output.FormatJSON {
			return printer.PrintJSON(created)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "agent/%s created\n", created.Name)
		return nil
	},
}

var updateArgs struct {
	projectID   string
	name        string
	prompt      string
	labels      string
	annotations string
}

var updateCmd = &cobra.Command{
	Use:   "update <name-or-id>",
	Short: "Update an agent",
	Args:  cobra.ExactArgs(1),
	Example: `  acpctl agent update api --prompt "New instructions"
  acpctl agent update api --name new-name
  acpctl agent update <id> --project-id <id> --prompt "..."`,
	RunE: func(cmd *cobra.Command, args []string) error {
		projectID, err := resolveProject(updateArgs.projectID)
		if err != nil {
			return err
		}

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

		agentID, err := resolveAgent(ctx, client, projectID, args[0])
		if err != nil {
			return err
		}

		patch := sdktypes.NewAgentPatchBuilder()
		if cmd.Flags().Changed("name") {
			patch = patch.Name(updateArgs.name)
		}
		if cmd.Flags().Changed("prompt") {
			patch = patch.Prompt(updateArgs.prompt)
		}
		if cmd.Flags().Changed("labels") {
			patch = patch.Labels(updateArgs.labels)
		}
		if cmd.Flags().Changed("annotations") {
			patch = patch.Annotations(updateArgs.annotations)
		}

		updated, err := client.Agents().UpdateInProject(ctx, projectID, agentID, patch.Build())
		if err != nil {
			return fmt.Errorf("update agent: %w", err)
		}

		fmt.Fprintf(cmd.OutOrStdout(), "agent/%s updated\n", updated.Name)
		return nil
	},
}

var deleteArgs struct {
	projectID string
	confirm   bool
}

var deleteCmd = &cobra.Command{
	Use:   "delete <name-or-id>",
	Short: "Delete an agent",
	Args:  cobra.ExactArgs(1),
	Example: `  acpctl agent delete api --confirm
  acpctl agent delete <id> --project-id <id> --confirm`,
	RunE: func(cmd *cobra.Command, args []string) error {
		projectID, err := resolveProject(deleteArgs.projectID)
		if err != nil {
			return err
		}
		if !deleteArgs.confirm {
			return fmt.Errorf("add --confirm to delete agent/%s", args[0])
		}

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

		agentID, err := resolveAgent(ctx, client, projectID, args[0])
		if err != nil {
			return err
		}

		if err := client.Agents().DeleteInProject(ctx, projectID, agentID); err != nil {
			return fmt.Errorf("delete agent: %w", err)
		}

		fmt.Fprintf(cmd.OutOrStdout(), "agent/%s deleted\n", args[0])
		return nil
	},
}

var agentStartArgs struct {
	projectID    string
	prompt       string
	outputFormat string
	all          bool
}

var agentStartCmd = &cobra.Command{
	Use:   "start [name-or-id]",
	Short: "Start a session for an agent (idempotent)",
	Long: `Start a session for an agent. If the agent already has an active
session (Pending, Creating, or Running), returns it without creating a
new one. Use --all / -A to start all agents in the project.

This operation is idempotent — calling it multiple times is safe.`,
	Args: cobra.MaximumNArgs(1),
	Example: `  acpctl agent start api
  acpctl agent start api --prompt "fix the bug"
  acpctl agent start --all
  acpctl agent start -A --prompt "run tests"`,
	RunE: func(cmd *cobra.Command, args []string) error {
		projectID, err := resolveProject(agentStartArgs.projectID)
		if err != nil {
			return err
		}

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

		if agentStartArgs.all {
			if len(args) > 0 {
				return fmt.Errorf("cannot specify agent name with --all")
			}
			return startAllAgents(ctx, cmd, client, projectID)
		}

		if len(args) == 0 {
			return fmt.Errorf("agent name or ID is required (or use --all)")
		}

		agentID, err := resolveAgent(ctx, client, projectID, args[0])
		if err != nil {
			return err
		}

		return startSingleAgent(ctx, cmd, client, projectID, agentID, args[0])
	},
}

func startSingleAgent(ctx context.Context, cmd *cobra.Command, client *sdkclient.Client, projectID, agentID, displayName string) error {
	resp, err := client.Agents().StartInProject(ctx, projectID, agentID, agentStartArgs.prompt)
	if err != nil {
		return fmt.Errorf("start agent: %w", err)
	}

	if agentStartArgs.outputFormat == "json" {
		printer := output.NewPrinter(output.FormatJSON, cmd.OutOrStdout())
		if resp.Session != nil {
			return printer.PrintJSON(resp.Session)
		}
		return printer.PrintJSON(resp)
	}
	if resp.Session != nil {
		fmt.Fprintf(cmd.OutOrStdout(), "session/%s started (phase: %s)\n", resp.Session.ID, resp.Session.Phase)
	} else {
		fmt.Fprintf(cmd.OutOrStdout(), "agent/%s started\n", displayName)
	}
	return nil
}

func startAllAgents(ctx context.Context, cmd *cobra.Command, client *sdkclient.Client, projectID string) error {
	agents, err := allAgentsInProject(ctx, client, projectID)
	if err != nil {
		return err
	}
	if len(agents) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "no agents in project")
		return nil
	}
	var failed int
	for _, a := range agents {
		if err := startSingleAgent(ctx, cmd, client, projectID, a.ID, a.Name); err != nil {
			fmt.Fprintf(cmd.ErrOrStderr(), "agent/%s: %v\n", a.Name, err)
			failed++
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d of %d agents failed to start", failed, len(agents))
	}
	return nil
}

var startPreviewArgs struct {
	projectID string
}

var startPreviewCmd = &cobra.Command{
	Use:   "start-preview <name-or-id>",
	Short: "Preview start context for an agent (dry run)",
	Args:  cobra.ExactArgs(1),
	Example: `  acpctl agent start-preview api
  acpctl agent start-preview <id> --project-id <id>`,
	RunE: func(cmd *cobra.Command, args []string) error {
		projectID, err := resolveProject(startPreviewArgs.projectID)
		if err != nil {
			return err
		}

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

		agentID, err := resolveAgent(ctx, client, projectID, args[0])
		if err != nil {
			return err
		}

		resp, err := client.Agents().GetStartPreview(ctx, projectID, agentID)
		if err != nil {
			return fmt.Errorf("get start preview for agent %q: %w", args[0], err)
		}

		fmt.Fprintln(cmd.OutOrStdout(), resp.StartingPrompt)
		return nil
	},
}

var sessionsArgs struct {
	projectID    string
	outputFormat string
	limit        int
}

var sessionsCmd = &cobra.Command{
	Use:   "sessions <name-or-id>",
	Short: "List session history for an agent",
	Args:  cobra.ExactArgs(1),
	Example: `  acpctl agent sessions api
  acpctl agent sessions <id> --project-id <id>`,
	RunE: func(cmd *cobra.Command, args []string) error {
		projectID, err := resolveProject(sessionsArgs.projectID)
		if err != nil {
			return err
		}

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

		agentID, err := resolveAgent(ctx, client, projectID, args[0])
		if err != nil {
			return err
		}

		opts := sdktypes.NewListOptions().Size(sessionsArgs.limit).Build()
		list, err := client.Agents().Sessions(ctx, projectID, agentID, opts)
		if err != nil {
			return fmt.Errorf("list sessions for agent %q: %w", args[0], err)
		}

		format, err := output.ParseFormat(sessionsArgs.outputFormat)
		if err != nil {
			return err
		}
		printer := output.NewPrinter(format, cmd.OutOrStdout())

		if printer.Format() == output.FormatJSON {
			return printer.PrintJSON(list)
		}

		return printSessionTable(printer, list.Items)
	},
}

var agentStopArgs struct {
	projectID string
	all       bool
}

var agentStopCmd = &cobra.Command{
	Use:   "stop [name-or-id]",
	Short: "Stop the running session for an agent (idempotent)",
	Long: `Stop the active session for an agent. If the agent has no active
session, prints a message and succeeds. Use --all / -A to stop all
agents in the project.

This operation is idempotent — calling it multiple times is safe.`,
	Args: cobra.MaximumNArgs(1),
	Example: `  acpctl agent stop api
  acpctl agent stop --all
  acpctl agent stop -A`,
	RunE: func(cmd *cobra.Command, args []string) error {
		projectID, err := resolveProject(agentStopArgs.projectID)
		if err != nil {
			return err
		}

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

		if agentStopArgs.all {
			if len(args) > 0 {
				return fmt.Errorf("cannot specify agent name with --all")
			}
			return stopAllAgents(ctx, cmd, client, projectID)
		}

		if len(args) == 0 {
			return fmt.Errorf("agent name or ID is required (or use --all)")
		}

		agent, err := resolveAgentFull(ctx, client, projectID, args[0])
		if err != nil {
			return err
		}

		return stopSingleAgent(ctx, cmd, client, agent)
	},
}

func stopSingleAgent(ctx context.Context, cmd *cobra.Command, client *sdkclient.Client, agent *sdktypes.Agent) error {
	if agent.CurrentSessionID == "" {
		fmt.Fprintf(cmd.OutOrStdout(), "agent/%s has no active session\n", agent.Name)
		return nil
	}

	sess, err := client.Sessions().Get(ctx, agent.CurrentSessionID)
	if err != nil {
		fmt.Fprintf(cmd.OutOrStdout(), "agent/%s session/%s not found — already cleaned up\n", agent.Name, agent.CurrentSessionID)
		return nil
	}

	if !activePhases[sess.Phase] {
		fmt.Fprintf(cmd.OutOrStdout(), "agent/%s session/%s already %s\n", agent.Name, sess.ID, sess.Phase)
		return nil
	}

	stopped, err := client.Sessions().Stop(ctx, sess.ID)
	if err != nil {
		return fmt.Errorf("stop agent/%s session/%s: %w", agent.Name, sess.ID, err)
	}

	fmt.Fprintf(cmd.OutOrStdout(), "agent/%s session/%s stopped (phase: %s)\n", agent.Name, stopped.ID, stopped.Phase)
	return nil
}

func stopAllAgents(ctx context.Context, cmd *cobra.Command, client *sdkclient.Client, projectID string) error {
	agents, err := allAgentsInProject(ctx, client, projectID)
	if err != nil {
		return err
	}
	if len(agents) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "no agents in project")
		return nil
	}
	var failed int
	for i := range agents {
		if err := stopSingleAgent(ctx, cmd, client, &agents[i]); err != nil {
			fmt.Fprintf(cmd.ErrOrStderr(), "agent/%s: %v\n", agents[i].Name, err)
			failed++
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d of %d agents failed to stop", failed, len(agents))
	}
	return nil
}

var exportArgs struct {
	projectID string
	namespace string
}

var exportCmd = &cobra.Command{
	Use:   "export <name-or-id>",
	Short: "Export agent as ConfigMap YAML",
	Long:  "Export an agent definition as a Kubernetes ConfigMap YAML suitable for kubectl apply.",
	Args:  cobra.ExactArgs(1),
	Example: `  acpctl agent export api
  acpctl agent export api --namespace my-ns
  acpctl agent export api > agent.yaml
  acpctl agent export api | kubectl apply -f -`,
	RunE: func(cmd *cobra.Command, args []string) error {
		projectID, err := resolveProject(exportArgs.projectID)
		if err != nil {
			return err
		}

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

		pa, err := resolveAgentFull(ctx, client, projectID, args[0])
		if err != nil {
			return err
		}

		out, err := agentToConfigMapYaml(pa, exportArgs.namespace)
		if err != nil {
			return err
		}
		fmt.Fprint(cmd.OutOrStdout(), out)
		return nil
	},
}

func init() {
	Cmd.AddCommand(listCmd)
	Cmd.AddCommand(getCmd)
	Cmd.AddCommand(createCmd)
	Cmd.AddCommand(updateCmd)
	Cmd.AddCommand(deleteCmd)
	Cmd.AddCommand(agentStartCmd)
	Cmd.AddCommand(agentStopCmd)
	Cmd.AddCommand(startPreviewCmd)
	Cmd.AddCommand(sessionsCmd)
	Cmd.AddCommand(exportCmd)

	listCmd.Flags().StringVar(&listArgs.projectID, "project-id", "", "Project ID (defaults to configured project)")
	listCmd.Flags().StringVarP(&listArgs.outputFormat, "output", "o", "", "Output format: json|yaml")
	listCmd.Flags().IntVar(&listArgs.limit, "limit", 100, "Maximum number of items to return")

	getCmd.Flags().StringVar(&getArgs.projectID, "project-id", "", "Project ID (defaults to configured project)")
	getCmd.Flags().StringVarP(&getArgs.outputFormat, "output", "o", "", "Output format: json|yaml")

	createCmd.Flags().StringVar(&createArgs.projectID, "project-id", "", "Project ID (defaults to configured project)")
	createCmd.Flags().StringVar(&createArgs.name, "name", "", "Agent name (required)")
	createCmd.Flags().StringVar(&createArgs.prompt, "prompt", "", "Standing instructions prompt")
	createCmd.Flags().StringVar(&createArgs.labels, "labels", "", "Labels (JSON string)")
	createCmd.Flags().StringVar(&createArgs.annotations, "annotations", "", "Annotations (JSON string)")
	createCmd.Flags().StringVarP(&createArgs.outputFormat, "output", "o", "", "Output format: json")

	updateCmd.Flags().StringVar(&updateArgs.projectID, "project-id", "", "Project ID (defaults to configured project)")
	updateCmd.Flags().StringVar(&updateArgs.name, "name", "", "New agent name")
	updateCmd.Flags().StringVar(&updateArgs.prompt, "prompt", "", "New standing instructions prompt")
	updateCmd.Flags().StringVar(&updateArgs.labels, "labels", "", "New labels (JSON string)")
	updateCmd.Flags().StringVar(&updateArgs.annotations, "annotations", "", "New annotations (JSON string)")

	deleteCmd.Flags().StringVar(&deleteArgs.projectID, "project-id", "", "Project ID (defaults to configured project)")
	deleteCmd.Flags().BoolVar(&deleteArgs.confirm, "confirm", false, "Confirm deletion")

	agentStartCmd.Flags().StringVar(&agentStartArgs.projectID, "project-id", "", "Project ID (defaults to configured project)")
	agentStartCmd.Flags().StringVar(&agentStartArgs.prompt, "prompt", "", "Task prompt for this run")
	agentStartCmd.Flags().StringVarP(&agentStartArgs.outputFormat, "output", "o", "", "Output format: json")
	agentStartCmd.Flags().BoolVarP(&agentStartArgs.all, "all", "A", false, "Start all agents in the project")

	agentStopCmd.Flags().StringVar(&agentStopArgs.projectID, "project-id", "", "Project ID (defaults to configured project)")
	agentStopCmd.Flags().BoolVarP(&agentStopArgs.all, "all", "A", false, "Stop all agents in the project")

	startPreviewCmd.Flags().StringVar(&startPreviewArgs.projectID, "project-id", "", "Project ID (defaults to configured project)")

	sessionsCmd.Flags().StringVar(&sessionsArgs.projectID, "project-id", "", "Project ID (defaults to configured project)")
	sessionsCmd.Flags().StringVarP(&sessionsArgs.outputFormat, "output", "o", "", "Output format: json")
	sessionsCmd.Flags().IntVar(&sessionsArgs.limit, "limit", 100, "Maximum number of items to return")

	exportCmd.Flags().StringVar(&exportArgs.projectID, "project-id", "", "Project ID (defaults to configured project)")
	exportCmd.Flags().StringVar(&exportArgs.namespace, "namespace", "", "Kubernetes namespace for the ConfigMap")
}

func printAgentTable(printer *output.Printer, agents []sdktypes.Agent) error {
	columns := []output.Column{
		{Name: "ID", Width: 27},
		{Name: "NAME", Width: 20},
		{Name: "DISPLAY NAME", Width: 18},
		{Name: "MODEL", Width: 20},
		{Name: "OWNER", Width: 16},
		{Name: "SESSION", Width: 27},
		{Name: "UPDATED", Width: 20},
	}

	table := output.NewTable(printer.Writer(), columns)
	table.WriteHeaders()

	for _, a := range agents {
		updated := ""
		if a.UpdatedAt != nil {
			updated = a.UpdatedAt.Format(time.RFC3339)
		}
		table.WriteRow(a.ID, a.Name, a.DisplayName, a.LlmModel, a.OwnerUserID, a.CurrentSessionID, updated)
	}
	return nil
}

func printAgentDetail(cmd *cobra.Command, a *sdktypes.Agent) error {
	w := cmd.OutOrStdout()
	fmt.Fprintf(w, "Name:             %s\n", a.Name)
	if a.DisplayName != "" {
		fmt.Fprintf(w, "Display Name:     %s\n", a.DisplayName)
	}
	fmt.Fprintf(w, "ID:               %s\n", a.ID)
	if a.Description != "" {
		fmt.Fprintf(w, "Description:      %s\n", a.Description)
	}
	fmt.Fprintf(w, "Project ID:       %s\n", a.ProjectID)
	if a.OwnerUserID != "" {
		fmt.Fprintf(w, "Owner:            %s\n", a.OwnerUserID)
	}
	fmt.Fprintf(w, "Model:            %s\n", a.LlmModel)
	if a.LlmTemperature != 0 {
		fmt.Fprintf(w, "Temperature:      %.1f\n", a.LlmTemperature)
	}
	if a.LlmMaxTokens != 0 {
		fmt.Fprintf(w, "Max Tokens:       %d\n", a.LlmMaxTokens)
	}
	if a.Entrypoint != "" {
		fmt.Fprintf(w, "Entrypoint:       %s\n", a.Entrypoint)
	}
	if a.RepoURL != "" {
		fmt.Fprintf(w, "Repo URL:         %s\n", a.RepoURL)
	}
	if a.WorkflowID != "" {
		fmt.Fprintf(w, "Workflow ID:      %s\n", a.WorkflowID)
	}
	if a.CurrentSessionID != "" {
		fmt.Fprintf(w, "Current Session:  %s\n", a.CurrentSessionID)
	}
	if a.SandboxPolicy != "" {
		fmt.Fprintf(w, "Sandbox Policy:   %s\n", a.SandboxPolicy)
	}

	if len(a.Providers) > 0 {
		fmt.Fprintf(w, "Providers:        %s\n", strings.Join(a.Providers, ", "))
	}

	if a.SandboxTemplate != nil {
		fmt.Fprintf(w, "Sandbox Template:\n")
		if a.SandboxTemplate.Image != "" {
			fmt.Fprintf(w, "  Image:          %s\n", a.SandboxTemplate.Image)
		}
		if a.SandboxTemplate.Resources != nil {
			if a.SandboxTemplate.Resources.CPU != "" {
				fmt.Fprintf(w, "  CPU:            %s\n", a.SandboxTemplate.Resources.CPU)
			}
			if a.SandboxTemplate.Resources.Memory != "" {
				fmt.Fprintf(w, "  Memory:         %s\n", a.SandboxTemplate.Resources.Memory)
			}
		}
		if a.SandboxTemplate.Gpu != nil && a.SandboxTemplate.Gpu.Count > 0 {
			fmt.Fprintf(w, "  GPU Count:      %d\n", a.SandboxTemplate.Gpu.Count)
		}
		if a.SandboxTemplate.RuntimeClassName != "" {
			fmt.Fprintf(w, "  Runtime Class:  %s\n", a.SandboxTemplate.RuntimeClassName)
		}
		if a.SandboxTemplate.LogLevel != "" {
			fmt.Fprintf(w, "  Log Level:      %s\n", a.SandboxTemplate.LogLevel)
		}
	}

	if len(a.Payloads) > 0 {
		fmt.Fprintf(w, "Payloads:\n")
		for _, p := range a.Payloads {
			fmt.Fprintf(w, "  - %s", p.SandboxPath)
			if p.RepoURL != "" {
				fmt.Fprintf(w, " (repo: %s", p.RepoURL)
				if p.Ref != "" {
					fmt.Fprintf(w, ", ref: %s", p.Ref)
				}
				fmt.Fprint(w, ")")
			}
			fmt.Fprintln(w)
		}
	}

	if len(a.Environment) > 0 {
		fmt.Fprintf(w, "Environment:\n")
		for k, v := range a.Environment {
			fmt.Fprintf(w, "  %s: %s\n", k, v)
		}
	}

	if a.Prompt != "" {
		fmt.Fprintf(w, "Prompt:\n")
		for _, line := range strings.Split(a.Prompt, "\n") {
			fmt.Fprintf(w, "  %s\n", line)
		}
	}

	if a.CreatedAt != nil {
		fmt.Fprintf(w, "Created:          %s\n", a.CreatedAt.Format(time.RFC3339))
	}
	if a.UpdatedAt != nil {
		fmt.Fprintf(w, "Updated:          %s\n", a.UpdatedAt.Format(time.RFC3339))
	}

	output.PrintMetadata(w, "Annotations", a.Annotations)
	output.PrintMetadata(w, "Labels", a.Labels)

	return nil
}

type agentExportData struct {
	Name            string            `yaml:"name"`
	DisplayName     string            `yaml:"display_name,omitempty"`
	Description     string            `yaml:"description,omitempty"`
	Model           string            `yaml:"model,omitempty"`
	Entrypoint      string            `yaml:"entrypoint,omitempty"`
	RepoURL         string            `yaml:"repo_url,omitempty"`
	Prompt          string            `yaml:"prompt,omitempty"`
	Providers       []string          `yaml:"providers,omitempty"`
	Payloads        []payloadExport   `yaml:"payloads,omitempty"`
	Environment     map[string]string `yaml:"environment,omitempty"`
	SandboxTemplate *sandboxExport    `yaml:"sandbox_template,omitempty"`
	SandboxPolicy   string            `yaml:"sandbox_policy,omitempty"`
}

type payloadExport struct {
	SandboxPath string `yaml:"sandbox_path"`
	RepoURL     string `yaml:"repo_url,omitempty"`
	Ref         string `yaml:"ref,omitempty"`
	Content     string `yaml:"content,omitempty"`
}

type sandboxExport struct {
	Image     string          `yaml:"image,omitempty"`
	Resources *resourceExport `yaml:"resources,omitempty"`
	Gpu       *gpuExport      `yaml:"gpu,omitempty"`
}

type resourceExport struct {
	CPU    string `yaml:"cpu,omitempty"`
	Memory string `yaml:"memory,omitempty"`
}

type gpuExport struct {
	Count int `yaml:"count,omitempty"`
}

func agentToConfigMapYaml(a *sdktypes.Agent, namespace string) (string, error) {
	data := agentExportData{
		Name:          a.Name,
		DisplayName:   a.DisplayName,
		Description:   a.Description,
		Model:         a.LlmModel,
		Entrypoint:    a.Entrypoint,
		RepoURL:       a.RepoURL,
		Prompt:        a.Prompt,
		Providers:     a.Providers,
		Environment:   a.Environment,
		SandboxPolicy: a.SandboxPolicy,
	}

	if len(a.Payloads) > 0 {
		data.Payloads = make([]payloadExport, len(a.Payloads))
		for i, p := range a.Payloads {
			data.Payloads[i] = payloadExport{
				SandboxPath: p.SandboxPath,
				RepoURL:     p.RepoURL,
				Ref:         p.Ref,
				Content:     p.Content,
			}
		}
	}

	if a.SandboxTemplate != nil {
		st := &sandboxExport{
			Image: a.SandboxTemplate.Image,
		}
		if a.SandboxTemplate.Resources != nil {
			r := &resourceExport{
				CPU:    a.SandboxTemplate.Resources.CPU,
				Memory: a.SandboxTemplate.Resources.Memory,
			}
			if r.CPU == "" && r.Memory == "" {
				r = nil
			}
			st.Resources = r
		}
		if a.SandboxTemplate.Gpu != nil && a.SandboxTemplate.Gpu.Count > 0 {
			st.Gpu = &gpuExport{Count: a.SandboxTemplate.Gpu.Count}
		}
		if st.Image == "" && st.Resources == nil && st.Gpu == nil {
			st = nil
		}
		data.SandboxTemplate = st
	}

	return output.ConfigMapYAML("agent", a.Name, namespace, data)
}

func printSessionTable(printer *output.Printer, sessions []sdktypes.Session) error {
	columns := []output.Column{
		{Name: "ID", Width: 27},
		{Name: "NAME", Width: 32},
		{Name: "PHASE", Width: 12},
		{Name: "AGE", Width: 10},
	}

	table := output.NewTable(printer.Writer(), columns)
	table.WriteHeaders()

	for _, s := range sessions {
		age := ""
		if s.CreatedAt != nil {
			age = output.FormatAge(time.Since(*s.CreatedAt))
		}
		table.WriteRow(s.ID, s.Name, s.Phase, age)
	}
	return nil
}
