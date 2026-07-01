// Package provider implements the provider subcommand for managing providers.
package provider

import (
	"context"
	"fmt"
	"time"

	"github.com/ambient-code/platform/components/ambient-cli/pkg/config"
	"github.com/ambient-code/platform/components/ambient-cli/pkg/connection"
	"github.com/ambient-code/platform/components/ambient-cli/pkg/output"
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

var listArgs struct {
	outputFormat string
	limit        int
}

var listCmd = &cobra.Command{
	Use:   "list",
	Short: "List providers in a project",
	Example: `  acpctl provider list
  acpctl provider list -o json
  acpctl provider list -o yaml`,
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
	outputFormat string
}

var getCmd = &cobra.Command{
	Use:   "get <name-or-id>",
	Short: "Get a specific provider",
	Args:  cobra.ExactArgs(1),
	Example: `  acpctl provider get my-provider
  acpctl provider get my-provider -o json
  acpctl provider get my-provider -o yaml`,
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

		provider, err := client.Providers().Get(ctx, args[0])
		if err != nil {
			return fmt.Errorf("get provider %q: %w", args[0], err)
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
	namespace string
}

var exportCmd = &cobra.Command{
	Use:   "export <name-or-id>",
	Short: "Export provider as ConfigMap YAML",
	Long:  "Export a provider definition as a Kubernetes ConfigMap YAML suitable for kubectl apply.",
	Args:  cobra.ExactArgs(1),
	Example: `  acpctl provider export my-provider
  acpctl provider export my-provider --namespace my-ns
  acpctl provider export my-provider > provider.yaml
  acpctl provider export my-provider | kubectl apply -f -`,
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

		provider, err := client.Providers().Get(ctx, args[0])
		if err != nil {
			return fmt.Errorf("get provider %q: %w", args[0], err)
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

	listCmd.Flags().StringVarP(&listArgs.outputFormat, "output", "o", "", "Output format: json|yaml")
	listCmd.Flags().IntVar(&listArgs.limit, "limit", 100, "Maximum number of items to return")

	getCmd.Flags().StringVarP(&getArgs.outputFormat, "output", "o", "", "Output format: json|yaml")

	exportCmd.Flags().StringVar(&exportArgs.namespace, "namespace", "", "Kubernetes namespace for the ConfigMap")
}

func printProviderTable(printer *output.Printer, providers []sdktypes.Provider) error {
	columns := []output.Column{
		{Name: "NAME", Width: 24},
		{Name: "TYPE", Width: 14},
		{Name: "SECRET", Width: 24},
		{Name: "NAMESPACE", Width: 20},
		{Name: "AGE", Width: 10},
	}

	table := output.NewTable(printer.Writer(), columns)
	table.WriteHeaders()

	for _, p := range providers {
		age := ""
		if p.UpdatedAt != nil {
			age = output.FormatAge(time.Since(*p.UpdatedAt))
		} else if p.CreatedAt != nil {
			age = output.FormatAge(time.Since(*p.CreatedAt))
		}
		table.WriteRow(p.Name, p.Type, p.Secret, p.Namespace, age)
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
