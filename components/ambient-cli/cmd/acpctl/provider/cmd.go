// Package provider implements the provider subcommand for managing providers.
package provider

import (
	"context"
	"fmt"
	"time"

	"github.com/ambient-code/platform/components/ambient-cli/pkg/config"
	"github.com/ambient-code/platform/components/ambient-cli/pkg/connection"
	"github.com/ambient-code/platform/components/ambient-cli/pkg/output"
	sdkclient "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/client"
	sdktypes "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
	"github.com/spf13/cobra"
)

var Cmd = &cobra.Command{
	Use:   "provider",
	Short: "Manage providers",
	Long: `Manage providers in a project.

Subcommands:
  list        List providers in a project
  get         Get a specific provider
  export      Export provider as ConfigMap YAML`,
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

func resolveProvider(ctx context.Context, client *sdkclient.Client, nameOrID string) (*sdktypes.Provider, error) {
	p, err := client.Providers().Get(ctx, nameOrID)
	if err == nil {
		return p, nil
	}
	opts := &sdktypes.ListOptions{Search: "name = '" + nameOrID + "'"}
	list, err2 := client.Providers().List(ctx, opts)
	if err2 != nil {
		return nil, fmt.Errorf("provider %q not found", nameOrID)
	}
	for i := range list.Items {
		if list.Items[i].Name == nameOrID {
			return &list.Items[i], nil
		}
	}
	return nil, fmt.Errorf("provider %q not found", nameOrID)
}

var listArgs struct {
	projectID    string
	outputFormat string
	limit        int
}

var listCmd = &cobra.Command{
	Use:   "list",
	Short: "List providers in a project",
	Example: `  acpctl provider list
  acpctl provider list --project-id <id> -o json
  acpctl provider list -o yaml`,
	RunE: func(cmd *cobra.Command, args []string) error {
		projectID, err := resolveProject(listArgs.projectID)
		if err != nil {
			return err
		}

		factory, err := connection.NewClientFactory()
		if err != nil {
			return err
		}

		client, err := factory.ForProject(projectID)
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
		list, err := client.Providers().List(ctx, opts)
		if err != nil {
			return fmt.Errorf("list providers: %w", err)
		}

		if printer.Format() == output.FormatJSON {
			return printer.PrintJSON(list)
		}
		if printer.Format() == output.FormatYAML {
			return printer.PrintYAML(list)
		}

		return printProviderTable(printer, list.Items)
	},
}

var getArgs struct {
	projectID    string
	outputFormat string
}

var getCmd = &cobra.Command{
	Use:   "get <name-or-id>",
	Short: "Get a specific provider",
	Args:  cobra.ExactArgs(1),
	Example: `  acpctl provider get my-provider
  acpctl provider get my-provider --project-id <id>
  acpctl provider get my-provider -o json
  acpctl provider get my-provider -o yaml`,
	RunE: func(cmd *cobra.Command, args []string) error {
		projectID, err := resolveProject(getArgs.projectID)
		if err != nil {
			return err
		}

		factory, err := connection.NewClientFactory()
		if err != nil {
			return err
		}

		client, err := factory.ForProject(projectID)
		if err != nil {
			return err
		}

		cfg, err := config.Load()
		if err != nil {
			return err
		}

		ctx, cancel := context.WithTimeout(context.Background(), cfg.GetRequestTimeout())
		defer cancel()

		provider, err := resolveProvider(ctx, client, args[0])
		if err != nil {
			return err
		}

		format, err := output.ParseFormat(getArgs.outputFormat)
		if err != nil {
			return err
		}
		printer := output.NewPrinter(format, cmd.OutOrStdout())

		if printer.Format() == output.FormatJSON {
			return printer.PrintJSON(provider)
		}
		if printer.Format() == output.FormatYAML {
			return printer.PrintYAML(provider)
		}

		return printProviderDetail(cmd, provider)
	},
}

var exportArgs struct {
	projectID string
	namespace string
}

var exportCmd = &cobra.Command{
	Use:   "export <name-or-id>",
	Short: "Export provider as ConfigMap YAML",
	Long:  "Export a provider definition as a Kubernetes ConfigMap YAML suitable for kubectl apply.",
	Args:  cobra.ExactArgs(1),
	Example: `  acpctl provider export my-provider
  acpctl provider export my-provider --project-id <id>
  acpctl provider export my-provider --namespace my-ns
  acpctl provider export my-provider > provider.yaml
  acpctl provider export my-provider | kubectl apply -f -`,
	RunE: func(cmd *cobra.Command, args []string) error {
		projectID, err := resolveProject(exportArgs.projectID)
		if err != nil {
			return err
		}

		factory, err := connection.NewClientFactory()
		if err != nil {
			return err
		}

		client, err := factory.ForProject(projectID)
		if err != nil {
			return err
		}

		cfg, err := config.Load()
		if err != nil {
			return err
		}

		ctx, cancel := context.WithTimeout(context.Background(), cfg.GetRequestTimeout())
		defer cancel()

		provider, err := resolveProvider(ctx, client, args[0])
		if err != nil {
			return err
		}

		out, err := providerToConfigMapYaml(provider, exportArgs.namespace)
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
	Cmd.AddCommand(exportCmd)

	listCmd.Flags().StringVar(&listArgs.projectID, "project-id", "", "Project ID (defaults to configured project)")
	listCmd.Flags().StringVarP(&listArgs.outputFormat, "output", "o", "", "Output format: json|yaml")
	listCmd.Flags().IntVar(&listArgs.limit, "limit", 100, "Maximum number of items to return")

	getCmd.Flags().StringVar(&getArgs.projectID, "project-id", "", "Project ID (defaults to configured project)")
	getCmd.Flags().StringVarP(&getArgs.outputFormat, "output", "o", "", "Output format: json|yaml")

	exportCmd.Flags().StringVar(&exportArgs.projectID, "project-id", "", "Project ID (defaults to configured project)")
	exportCmd.Flags().StringVar(&exportArgs.namespace, "namespace", "", "Kubernetes namespace for the ConfigMap")
}

func printProviderTable(printer *output.Printer, providers []sdktypes.Provider) error {
	columns := []output.Column{
		{Name: "ID", Width: 27},
		{Name: "NAME", Width: 24},
		{Name: "TYPE", Width: 14},
		{Name: "SECRET", Width: 24},
		{Name: "NAMESPACE", Width: 20},
		{Name: "UPDATED", Width: 20},
	}

	table := output.NewTable(printer.Writer(), columns)
	table.WriteHeaders()

	for _, p := range providers {
		updated := ""
		if p.UpdatedAt != nil {
			updated = p.UpdatedAt.Format(time.RFC3339)
		}
		table.WriteRow(p.ID, p.Name, p.Type, p.Secret, p.Namespace, updated)
	}
	return nil
}

func printProviderDetail(cmd *cobra.Command, p *sdktypes.Provider) error {
	w := cmd.OutOrStdout()
	fmt.Fprintf(w, "Name:        %s\n", p.Name)
	fmt.Fprintf(w, "ID:          %s\n", p.ID)
	fmt.Fprintf(w, "Type:        %s\n", p.Type)
	fmt.Fprintf(w, "Secret:      %s\n", p.Secret)
	fmt.Fprintf(w, "Namespace:   %s\n", p.Namespace)
	fmt.Fprintf(w, "Project ID:  %s\n", p.ProjectID)

	if p.CreatedAt != nil {
		fmt.Fprintf(w, "Created:     %s\n", p.CreatedAt.Format(time.RFC3339))
	}
	if p.UpdatedAt != nil {
		fmt.Fprintf(w, "Updated:     %s\n", p.UpdatedAt.Format(time.RFC3339))
	}

	output.PrintMetadata(w, "Annotations", p.Annotations)
	output.PrintMetadata(w, "Labels", p.Labels)

	return nil
}

type providerExportData struct {
	Name   string `yaml:"name"`
	Type   string `yaml:"type,omitempty"`
	Secret string `yaml:"secret,omitempty"`
}

func providerToConfigMapYaml(p *sdktypes.Provider, namespace string) (string, error) {
	if namespace == "" {
		namespace = p.Namespace
	}
	data := providerExportData{
		Name:   p.Name,
		Type:   p.Type,
		Secret: p.Secret,
	}
	return output.ConfigMapYAML("provider", p.Name, namespace, data)
}
