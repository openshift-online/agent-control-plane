// Package policy implements the policy subcommand for managing policies.
package policy

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/ambient-code/platform/components/ambient-cli/pkg/config"
	"github.com/ambient-code/platform/components/ambient-cli/pkg/connection"
	"github.com/ambient-code/platform/components/ambient-cli/pkg/output"
	sdkclient "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/client"
	sdktypes "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

var Cmd = &cobra.Command{
	Use:   "policy",
	Short: "Manage policies",
	Long: `Manage policies in a project.

Subcommands:
  list        List policies in a project
  get         Get a specific policy
  export      Export policy as ConfigMap YAML`,
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

func resolvePolicy(ctx context.Context, client *sdkclient.Client, nameOrID string) (*sdktypes.Policy, error) {
	p, err := client.Policys().Get(ctx, nameOrID)
	if err == nil {
		return p, nil
	}
	opts := &sdktypes.ListOptions{Search: "name = '" + nameOrID + "'"}
	list, err2 := client.Policys().List(ctx, opts)
	if err2 != nil {
		return nil, fmt.Errorf("policy %q not found", nameOrID)
	}
	for i := range list.Items {
		if list.Items[i].Name == nameOrID {
			return &list.Items[i], nil
		}
	}
	return nil, fmt.Errorf("policy %q not found", nameOrID)
}

var listArgs struct {
	projectID    string
	outputFormat string
	limit        int
}

var listCmd = &cobra.Command{
	Use:   "list",
	Short: "List policies in a project",
	Example: `  acpctl policy list
  acpctl policy list --project-id <id> -o json
  acpctl policy list -o yaml`,
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
		list, err := client.Policys().List(ctx, opts)
		if err != nil {
			return fmt.Errorf("list policies: %w", err)
		}

		if printer.Format() == output.FormatJSON {
			return printer.PrintJSON(list)
		}
		if printer.Format() == output.FormatYAML {
			return printer.PrintYAML(list)
		}

		return printPolicyTable(printer, list.Items)
	},
}

var getArgs struct {
	projectID    string
	outputFormat string
}

var getCmd = &cobra.Command{
	Use:   "get <name-or-id>",
	Short: "Get a specific policy",
	Args:  cobra.ExactArgs(1),
	Example: `  acpctl policy get my-policy
  acpctl policy get my-policy --project-id <id>
  acpctl policy get my-policy -o json
  acpctl policy get my-policy -o yaml`,
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

		policy, err := resolvePolicy(ctx, client, args[0])
		if err != nil {
			return err
		}

		format, err := output.ParseFormat(getArgs.outputFormat)
		if err != nil {
			return err
		}
		printer := output.NewPrinter(format, cmd.OutOrStdout())

		if printer.Format() == output.FormatJSON {
			return printer.PrintJSON(policy)
		}
		if printer.Format() == output.FormatYAML {
			return printer.PrintYAML(policy)
		}

		return printPolicyDetail(cmd, policy)
	},
}

var exportArgs struct {
	projectID string
	namespace string
}

var exportCmd = &cobra.Command{
	Use:   "export <name-or-id>",
	Short: "Export policy as ConfigMap YAML",
	Long:  "Export a policy definition as a Kubernetes ConfigMap YAML suitable for kubectl apply.",
	Args:  cobra.ExactArgs(1),
	Example: `  acpctl policy export my-policy
  acpctl policy export my-policy --project-id <id>
  acpctl policy export my-policy --namespace my-ns
  acpctl policy export my-policy > policy.yaml
  acpctl policy export my-policy | kubectl apply -f -`,
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

		policy, err := resolvePolicy(ctx, client, args[0])
		if err != nil {
			return err
		}

		out, err := policyToConfigMapYaml(policy, exportArgs.namespace)
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

func specSections(specJSON string) string {
	if specJSON == "" {
		return ""
	}
	var m map[string]interface{}
	if err := json.Unmarshal([]byte(specJSON), &m); err != nil {
		return ""
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return strings.Join(keys, ", ")
}

func printPolicyTable(printer *output.Printer, policies []sdktypes.Policy) error {
	columns := []output.Column{
		{Name: "ID", Width: 27},
		{Name: "NAME", Width: 24},
		{Name: "NAMESPACE", Width: 20},
		{Name: "SECTIONS", Width: 32},
		{Name: "UPDATED", Width: 20},
	}

	table := output.NewTable(printer.Writer(), columns)
	table.WriteHeaders()

	for _, p := range policies {
		updated := ""
		if p.UpdatedAt != nil {
			updated = p.UpdatedAt.Format(time.RFC3339)
		}
		table.WriteRow(p.ID, p.Name, p.Namespace, specSections(p.Spec), updated)
	}
	return nil
}

func printPolicyDetail(cmd *cobra.Command, p *sdktypes.Policy) error {
	w := cmd.OutOrStdout()
	fmt.Fprintf(w, "Name:        %s\n", p.Name)
	fmt.Fprintf(w, "ID:          %s\n", p.ID)
	fmt.Fprintf(w, "Namespace:   %s\n", p.Namespace)
	fmt.Fprintf(w, "Project ID:  %s\n", p.ProjectID)

	sections := specSections(p.Spec)
	if sections != "" {
		fmt.Fprintf(w, "Sections:    %s\n", sections)
	}

	if p.CreatedAt != nil {
		fmt.Fprintf(w, "Created:     %s\n", p.CreatedAt.Format(time.RFC3339))
	}
	if p.UpdatedAt != nil {
		fmt.Fprintf(w, "Updated:     %s\n", p.UpdatedAt.Format(time.RFC3339))
	}

	output.PrintMetadata(w, "Annotations", p.Annotations)
	output.PrintMetadata(w, "Labels", p.Labels)

	if p.Spec != "" && p.Spec != "{}" {
		fmt.Fprintf(w, "\nSpec:\n")
		specYaml, err := specToYaml(p.Spec)
		if err == nil {
			for _, line := range strings.Split(specYaml, "\n") {
				if line != "" {
					fmt.Fprintf(w, "  %s\n", line)
				}
			}
		}
	}

	return nil
}

func specToYaml(specJSON string) (string, error) {
	var specMap interface{}
	if err := json.Unmarshal([]byte(specJSON), &specMap); err != nil {
		return "", fmt.Errorf("parse spec JSON: %w", err)
	}
	data, err := yaml.Marshal(specMap)
	if err != nil {
		return "", fmt.Errorf("marshal spec YAML: %w", err)
	}
	return strings.TrimRight(string(data), "\n"), nil
}

func policyToConfigMapYaml(p *sdktypes.Policy, namespace string) (string, error) {
	if namespace == "" {
		namespace = p.Namespace
	}
	data := map[string]any{"name": p.Name}
	if p.Spec != "" && p.Spec != "{}" {
		var specMap map[string]any
		if err := json.Unmarshal([]byte(p.Spec), &specMap); err != nil {
			return "", fmt.Errorf("parse policy spec: %w", err)
		}
		for k, v := range specMap {
			data[k] = v
		}
	}
	return output.ConfigMapYAML("policy", p.Name, namespace, data)
}
