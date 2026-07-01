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

var listArgs struct {
	outputFormat string
	limit        int
}

var listCmd = &cobra.Command{
	Use:   "list",
	Short: "List policies in a project",
	Example: `  acpctl policy list
  acpctl policy list -o json
  acpctl policy list -o yaml`,
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
	outputFormat string
}

var getCmd = &cobra.Command{
	Use:   "get <name-or-id>",
	Short: "Get a specific policy",
	Args:  cobra.ExactArgs(1),
	Example: `  acpctl policy get my-policy
  acpctl policy get my-policy -o json
  acpctl policy get my-policy -o yaml`,
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

		policy, err := client.Policys().Get(ctx, args[0])
		if err != nil {
			return fmt.Errorf("get policy %q: %w", args[0], err)
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

var exportCmd = &cobra.Command{
	Use:   "export <name-or-id>",
	Short: "Export policy as ConfigMap YAML",
	Long:  "Export a policy definition as a Kubernetes ConfigMap YAML suitable for kubectl apply.",
	Args:  cobra.ExactArgs(1),
	Example: `  acpctl policy export my-policy
  acpctl policy export my-policy > policy.yaml
  acpctl policy export my-policy | kubectl apply -f -`,
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

		policy, err := client.Policys().Get(ctx, args[0])
		if err != nil {
			return fmt.Errorf("get policy %q: %w", args[0], err)
		}

		out, err := policyToConfigMapYaml(policy)
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
		{Name: "NAME", Width: 24},
		{Name: "NAMESPACE", Width: 20},
		{Name: "SECTIONS", Width: 32},
		{Name: "AGE", Width: 10},
	}

	table := output.NewTable(printer.Writer(), columns)
	table.WriteHeaders()

	for _, p := range policies {
		age := ""
		if p.UpdatedAt != nil {
			age = output.FormatAge(time.Since(*p.UpdatedAt))
		} else if p.CreatedAt != nil {
			age = output.FormatAge(time.Since(*p.CreatedAt))
		}
		table.WriteRow(p.Name, p.Namespace, specSections(p.Spec), age)
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

	printMetadata(w, "Annotations", p.Annotations)
	printMetadata(w, "Labels", p.Labels)

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

func printMetadata(w interface{ Write([]byte) (int, error) }, heading, jsonStr string) {
	if jsonStr == "" || jsonStr == "{}" {
		return
	}
	var m map[string]string
	if err := json.Unmarshal([]byte(jsonStr), &m); err != nil {
		return
	}
	if len(m) == 0 {
		return
	}
	fmt.Fprintf(w, "%s:\n", heading)
	for k, v := range m {
		fmt.Fprintf(w, "  %s: %s\n", k, v)
	}
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

func policyToConfigMapYaml(p *sdktypes.Policy) (string, error) {
	dataLines := []string{
		"    name: " + p.Name,
	}

	if p.Spec != "" && p.Spec != "{}" {
		specYaml, err := specToYaml(p.Spec)
		if err != nil {
			return "", err
		}
		for _, line := range strings.Split(specYaml, "\n") {
			if line != "" {
				dataLines = append(dataLines, "    "+line)
			}
		}
	}

	namespace := p.Namespace
	if namespace == "" {
		namespace = p.ProjectID
	}

	lines := []string{
		"apiVersion: v1",
		"kind: ConfigMap",
		"metadata:",
		"  name: policy-" + p.Name,
		"  namespace: " + namespace,
		"  labels:",
		"    ambient.ai/kind: policy",
		"data:",
		"  " + p.Name + ": |",
	}
	lines = append(lines, dataLines...)

	return strings.Join(lines, "\n") + "\n", nil
}
