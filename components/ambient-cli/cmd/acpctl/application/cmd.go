// Package application implements the application subcommand for managing GitOps applications.
package application

import (
	"context"
	"fmt"
	"regexp"
	"time"

	"github.com/ambient-code/platform/components/ambient-cli/pkg/config"
	"github.com/ambient-code/platform/components/ambient-cli/pkg/connection"
	"github.com/ambient-code/platform/components/ambient-cli/pkg/output"
	sdkclient "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/client"
	sdktypes "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
	"github.com/spf13/cobra"
)

var safeTSLPattern = regexp.MustCompile(`^[a-zA-Z0-9_.@:\-]+$`)

var Cmd = &cobra.Command{
	Use:   "application",
	Short: "Manage GitOps applications",
	Long: `Manage GitOps applications that sync agent fleet definitions from git repos.

Subcommands:
  list        List applications
  get         Get a specific application
  create      Create an application
  update      Update an application's fields
  delete      Delete an application
  sync        Trigger a sync for an application
  refresh     Refresh an application's status`,
	Aliases: []string{"app", "apps"},
	RunE: func(cmd *cobra.Command, args []string) error {
		return cmd.Help()
	},
}

var listArgs struct {
	outputFormat string
	limit        int
}

var listCmd = &cobra.Command{
	Use:   "list",
	Short: "List applications",
	Example: `  acpctl application list
  acpctl application list -o json`,
	RunE: func(cmd *cobra.Command, args []string) error {
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
		list, err := client.Applications().List(ctx, opts)
		if err != nil {
			return fmt.Errorf("list applications: %w", err)
		}

		if printer.Format() == output.FormatJSON {
			return printer.PrintJSON(list)
		}

		return printApplicationTable(printer, list.Items)
	},
}

var getArgs struct {
	outputFormat string
}

var getCmd = &cobra.Command{
	Use:   "get <name-or-id>",
	Short: "Get a specific application",
	Args:  cobra.ExactArgs(1),
	Example: `  acpctl application get my-fleet
  acpctl application get my-fleet -o json`,
	RunE: func(cmd *cobra.Command, args []string) error {
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

		appID, _, err := resolveApplication(ctx, client, args[0])
		if err != nil {
			return err
		}

		app, err := client.Applications().Get(ctx, appID)
		if err != nil {
			return fmt.Errorf("get application %q: %w", args[0], err)
		}

		format, err := output.ParseFormat(getArgs.outputFormat)
		if err != nil {
			return err
		}
		printer := output.NewPrinter(format, cmd.OutOrStdout())

		if printer.Format() == output.FormatJSON {
			return printer.PrintJSON(app)
		}
		return printApplicationTable(printer, []sdktypes.Application{*app})
	},
}

var createArgs struct {
	name                  string
	sourceRepoURL         string
	sourcePath            string
	sourceTargetRevision  string
	destinationProject    string
	destinationAmbientURL string
	credentialID          string
	autoSync              bool
	autoPrune             bool
	selfHeal              bool
	retryLimit            int32
	labels                string
	annotations           string
	outputFormat          string
}

var createCmd = &cobra.Command{
	Use:   "create",
	Short: "Create an application",
	Example: `  acpctl application create --name my-fleet --source-repo-url https://github.com/org/repo --source-path agents/ --destination-project my-project
  acpctl application create --name my-fleet --source-repo-url https://github.com/org/repo --source-path agents/ --destination-project my-project --auto-sync`,
	RunE: func(cmd *cobra.Command, args []string) error {
		if createArgs.name == "" {
			return fmt.Errorf("--name is required")
		}
		if createArgs.sourceRepoURL == "" {
			return fmt.Errorf("--source-repo-url is required")
		}
		if createArgs.sourcePath == "" {
			return fmt.Errorf("--source-path is required")
		}
		if createArgs.destinationProject == "" {
			return fmt.Errorf("--destination-project is required")
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

		builder := sdktypes.NewApplicationBuilder().
			Name(createArgs.name).
			SourceRepoURL(createArgs.sourceRepoURL).
			SourcePath(createArgs.sourcePath).
			DestinationProject(createArgs.destinationProject)

		if createArgs.sourceTargetRevision != "" {
			builder = builder.SourceTargetRevision(createArgs.sourceTargetRevision)
		}
		if createArgs.destinationAmbientURL != "" {
			builder = builder.DestinationAmbientURL(createArgs.destinationAmbientURL)
		}
		if createArgs.credentialID != "" {
			builder = builder.CredentialID(createArgs.credentialID)
		}
		if cmd.Flags().Changed("auto-sync") {
			builder = builder.AutoSync(createArgs.autoSync)
		}
		if cmd.Flags().Changed("auto-prune") {
			builder = builder.AutoPrune(createArgs.autoPrune)
		}
		if cmd.Flags().Changed("self-heal") {
			builder = builder.SelfHeal(createArgs.selfHeal)
		}
		if cmd.Flags().Changed("retry-limit") {
			builder = builder.RetryLimit(createArgs.retryLimit)
		}
		if createArgs.labels != "" {
			builder = builder.Labels(createArgs.labels)
		}
		if createArgs.annotations != "" {
			builder = builder.Annotations(createArgs.annotations)
		}

		app, err := builder.Build()
		if err != nil {
			return fmt.Errorf("build application: %w", err)
		}

		created, err := client.Applications().Create(ctx, app)
		if err != nil {
			return fmt.Errorf("create application: %w", err)
		}

		format, err := output.ParseFormat(createArgs.outputFormat)
		if err != nil {
			return err
		}
		printer := output.NewPrinter(format, cmd.OutOrStdout())

		if printer.Format() == output.FormatJSON {
			return printer.PrintJSON(created)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "application/%s created\n", created.Name)
		return nil
	},
}

var updateArgs struct {
	name                  string
	sourceRepoURL         string
	sourcePath            string
	sourceTargetRevision  string
	destinationProject    string
	destinationAmbientURL string
	credentialID          string
	autoSync              bool
	autoPrune             bool
	selfHeal              bool
	retryLimit            int32
	labels                string
	annotations           string
}

var updateCmd = &cobra.Command{
	Use:   "update <name-or-id>",
	Short: "Update an application",
	Args:  cobra.ExactArgs(1),
	Example: `  acpctl application update my-fleet --auto-sync
  acpctl application update my-fleet --source-target-revision v2.0`,
	RunE: func(cmd *cobra.Command, args []string) error {
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

		appID, _, err := resolveApplication(ctx, client, args[0])
		if err != nil {
			return err
		}

		patch := sdktypes.NewApplicationPatchBuilder()
		if cmd.Flags().Changed("name") {
			patch = patch.Name(updateArgs.name)
		}
		if cmd.Flags().Changed("source-repo-url") {
			patch = patch.SourceRepoURL(updateArgs.sourceRepoURL)
		}
		if cmd.Flags().Changed("source-path") {
			patch = patch.SourcePath(updateArgs.sourcePath)
		}
		if cmd.Flags().Changed("source-target-revision") {
			patch = patch.SourceTargetRevision(updateArgs.sourceTargetRevision)
		}
		if cmd.Flags().Changed("destination-project") {
			patch = patch.DestinationProject(updateArgs.destinationProject)
		}
		if cmd.Flags().Changed("destination-ambient-url") {
			patch = patch.DestinationAmbientURL(updateArgs.destinationAmbientURL)
		}
		if cmd.Flags().Changed("credential-id") {
			patch = patch.CredentialID(updateArgs.credentialID)
		}
		if cmd.Flags().Changed("auto-sync") {
			patch = patch.AutoSync(updateArgs.autoSync)
		}
		if cmd.Flags().Changed("auto-prune") {
			patch = patch.AutoPrune(updateArgs.autoPrune)
		}
		if cmd.Flags().Changed("self-heal") {
			patch = patch.SelfHeal(updateArgs.selfHeal)
		}
		if cmd.Flags().Changed("retry-limit") {
			patch = patch.RetryLimit(updateArgs.retryLimit)
		}
		if cmd.Flags().Changed("labels") {
			patch = patch.Labels(updateArgs.labels)
		}
		if cmd.Flags().Changed("annotations") {
			patch = patch.Annotations(updateArgs.annotations)
		}

		updated, err := client.Applications().Update(ctx, appID, patch.Build())
		if err != nil {
			return fmt.Errorf("update application: %w", err)
		}

		fmt.Fprintf(cmd.OutOrStdout(), "application/%s updated\n", updated.Name)
		return nil
	},
}

var deleteArgs struct {
	confirm bool
}

var deleteCmd = &cobra.Command{
	Use:     "delete <name-or-id>",
	Short:   "Delete an application",
	Args:    cobra.ExactArgs(1),
	Example: `  acpctl application delete my-fleet --confirm`,
	RunE: func(cmd *cobra.Command, args []string) error {
		if !deleteArgs.confirm {
			return fmt.Errorf("add --confirm to delete application/%s", args[0])
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

		appID, appName, err := resolveApplication(ctx, client, args[0])
		if err != nil {
			return err
		}

		if err := client.Applications().Delete(ctx, appID); err != nil {
			return fmt.Errorf("delete application: %w", err)
		}

		fmt.Fprintf(cmd.OutOrStdout(), "application/%s deleted\n", appName)
		return nil
	},
}

var syncArgs struct {
	outputFormat string
}

var syncCmd = &cobra.Command{
	Use:   "sync <name-or-id>",
	Short: "Trigger a sync for an application",
	Args:  cobra.ExactArgs(1),
	Example: `  acpctl application sync my-fleet
  acpctl application sync my-fleet -o json`,
	RunE: func(cmd *cobra.Command, args []string) error {
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

		appID, appName, err := resolveApplication(ctx, client, args[0])
		if err != nil {
			return err
		}

		result, err := client.Applications().Sync(ctx, appID)
		if err != nil {
			return fmt.Errorf("sync application: %w", err)
		}

		format, err := output.ParseFormat(syncArgs.outputFormat)
		if err != nil {
			return err
		}
		printer := output.NewPrinter(format, cmd.OutOrStdout())

		if printer.Format() == output.FormatJSON {
			return printer.PrintJSON(result)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "application/%s sync triggered\n", appName)
		return nil
	},
}

var refreshArgs struct {
	outputFormat string
}

var refreshCmd = &cobra.Command{
	Use:   "refresh <name-or-id>",
	Short: "Refresh an application's status",
	Args:  cobra.ExactArgs(1),
	Example: `  acpctl application refresh my-fleet
  acpctl application refresh my-fleet -o json`,
	RunE: func(cmd *cobra.Command, args []string) error {
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

		appID, appName, err := resolveApplication(ctx, client, args[0])
		if err != nil {
			return err
		}

		app, err := client.Applications().Refresh(ctx, appID)
		if err != nil {
			return fmt.Errorf("refresh application %q: %w", args[0], err)
		}

		format, err := output.ParseFormat(refreshArgs.outputFormat)
		if err != nil {
			return err
		}
		printer := output.NewPrinter(format, cmd.OutOrStdout())

		if printer.Format() == output.FormatJSON {
			return printer.PrintJSON(app)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "application/%s refreshed (sync: %s, health: %s)\n", appName, app.SyncStatus, app.HealthStatus)
		return nil
	},
}

func init() {
	Cmd.AddCommand(listCmd)
	Cmd.AddCommand(getCmd)
	Cmd.AddCommand(createCmd)
	Cmd.AddCommand(updateCmd)
	Cmd.AddCommand(deleteCmd)
	Cmd.AddCommand(syncCmd)
	Cmd.AddCommand(refreshCmd)

	listCmd.Flags().StringVarP(&listArgs.outputFormat, "output", "o", "", "Output format: json")
	listCmd.Flags().IntVar(&listArgs.limit, "limit", 100, "Maximum number of items to return")

	getCmd.Flags().StringVarP(&getArgs.outputFormat, "output", "o", "", "Output format: json")

	createCmd.Flags().StringVar(&createArgs.name, "name", "", "Application name (required)")
	createCmd.Flags().StringVar(&createArgs.sourceRepoURL, "source-repo-url", "", "Git repository URL (required)")
	createCmd.Flags().StringVar(&createArgs.sourcePath, "source-path", "", "Path within the repository (required)")
	createCmd.Flags().StringVar(&createArgs.sourceTargetRevision, "source-target-revision", "", "Target revision (branch, tag, commit)")
	createCmd.Flags().StringVar(&createArgs.destinationProject, "destination-project", "", "Destination project (required)")
	createCmd.Flags().StringVar(&createArgs.destinationAmbientURL, "destination-ambient-url", "", "Destination Ambient URL")
	createCmd.Flags().StringVar(&createArgs.credentialID, "credential-id", "", "Credential ID for repo access")
	createCmd.Flags().BoolVar(&createArgs.autoSync, "auto-sync", false, "Enable automatic sync")
	createCmd.Flags().BoolVar(&createArgs.autoPrune, "auto-prune", false, "Enable automatic pruning")
	createCmd.Flags().BoolVar(&createArgs.selfHeal, "self-heal", false, "Enable self-healing")
	createCmd.Flags().Int32Var(&createArgs.retryLimit, "retry-limit", 0, "Retry limit for sync operations")
	createCmd.Flags().StringVar(&createArgs.labels, "labels", "", "Labels (JSON string)")
	createCmd.Flags().StringVar(&createArgs.annotations, "annotations", "", "Annotations (JSON string)")
	createCmd.Flags().StringVarP(&createArgs.outputFormat, "output", "o", "", "Output format: json")

	updateCmd.Flags().StringVar(&updateArgs.name, "name", "", "New application name")
	updateCmd.Flags().StringVar(&updateArgs.sourceRepoURL, "source-repo-url", "", "New git repository URL")
	updateCmd.Flags().StringVar(&updateArgs.sourcePath, "source-path", "", "New path within the repository")
	updateCmd.Flags().StringVar(&updateArgs.sourceTargetRevision, "source-target-revision", "", "New target revision")
	updateCmd.Flags().StringVar(&updateArgs.destinationProject, "destination-project", "", "New destination project")
	updateCmd.Flags().StringVar(&updateArgs.destinationAmbientURL, "destination-ambient-url", "", "New destination Ambient URL")
	updateCmd.Flags().StringVar(&updateArgs.credentialID, "credential-id", "", "New credential ID")
	updateCmd.Flags().BoolVar(&updateArgs.autoSync, "auto-sync", false, "Enable/disable automatic sync")
	updateCmd.Flags().BoolVar(&updateArgs.autoPrune, "auto-prune", false, "Enable/disable automatic pruning")
	updateCmd.Flags().BoolVar(&updateArgs.selfHeal, "self-heal", false, "Enable/disable self-healing")
	updateCmd.Flags().Int32Var(&updateArgs.retryLimit, "retry-limit", 0, "New retry limit")
	updateCmd.Flags().StringVar(&updateArgs.labels, "labels", "", "New labels (JSON string)")
	updateCmd.Flags().StringVar(&updateArgs.annotations, "annotations", "", "New annotations (JSON string)")

	deleteCmd.Flags().BoolVar(&deleteArgs.confirm, "confirm", false, "Confirm deletion")

	syncCmd.Flags().StringVarP(&syncArgs.outputFormat, "output", "o", "", "Output format: json")
	refreshCmd.Flags().StringVarP(&refreshArgs.outputFormat, "output", "o", "", "Output format: json")
}

func resolveApplication(ctx context.Context, client *sdkclient.Client, nameOrID string) (string, string, error) {
	if safeTSLPattern.MatchString(nameOrID) {
		opts := sdktypes.NewListOptions().Size(10).Build()
		opts.Search = fmt.Sprintf("name = '%s'", nameOrID)
		list, err := client.Applications().List(ctx, opts)
		if err == nil && list.Total > 0 {
			return list.Items[0].ID, list.Items[0].Name, nil
		}
	}

	app, err := client.Applications().Get(ctx, nameOrID)
	if err != nil {
		return "", "", fmt.Errorf("application %q not found", nameOrID)
	}
	return app.ID, app.Name, nil
}

func printApplicationTable(printer *output.Printer, applications []sdktypes.Application) error {
	columns := []output.Column{
		{Name: "ID", Width: 27},
		{Name: "NAME", Width: 24},
		{Name: "SOURCE", Width: 40},
		{Name: "PROJECT", Width: 16},
		{Name: "SYNC", Width: 12},
		{Name: "HEALTH", Width: 12},
		{Name: "AGE", Width: 10},
	}

	table := output.NewTable(printer.Writer(), columns)
	table.WriteHeaders()

	for _, a := range applications {
		age := ""
		if a.CreatedAt != nil {
			age = output.FormatAge(time.Since(*a.CreatedAt))
		}
		source := a.SourceRepoURL
		if a.SourcePath != "" {
			source = source + "/" + a.SourcePath
		}
		table.WriteRow(a.ID, a.Name, source, a.DestinationProject, a.SyncStatus, a.HealthStatus, age)
	}
	return nil
}
