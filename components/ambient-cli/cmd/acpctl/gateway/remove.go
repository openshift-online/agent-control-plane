package gateway

import (
	"fmt"
	"os/exec"
	"strings"

	"github.com/openshift-online/agent-control-plane/components/ambient-cli/pkg/config"
	"github.com/spf13/cobra"
)

var removeArgs struct {
	project string
}

var removeCmd = &cobra.Command{
	Use:   "remove-cli [name]",
	Short: "Remove an openshell CLI gateway registration",
	Long: `Remove a local openshell CLI gateway registration.

The gateway name defaults to "<project>-openshell-gateway" if not specified.

This is equivalent to running 'openshell gateway remove <name>'.`,
	Example: `  acpctl gateway remove-cli --project tenant-a
  acpctl gateway remove-cli tenant-a-openshell-gateway`,
	Args: cobra.MaximumNArgs(1),
	RunE: runRemove,
}

func init() {
	removeCmd.Flags().StringVar(&removeArgs.project, "project", "", "Project/namespace used to derive the gateway name (defaults to configured project)")
}

func runRemove(cmd *cobra.Command, args []string) error {
	if _, err := exec.LookPath("openshell"); err != nil {
		return fmt.Errorf("openshell not found in PATH: required for gateway removal")
	}

	var localName string
	if len(args) > 0 {
		localName = args[0]
	} else {
		project := removeArgs.project
		if project == "" {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			project = cfg.GetProject()
			if project == "" {
				return fmt.Errorf("no project set; use --project or provide the gateway name as an argument")
			}
		}
		localName = project + "-openshell-gateway"
	}

	if !gatewayRegistered(localName) {
		return fmt.Errorf("gateway %q is not registered in openshell", localName)
	}

	fmt.Fprintf(cmd.OutOrStdout(), "Removing gateway %s...\n", localName)
	removeOut, err := exec.Command("openshell", "gateway", "remove", localName).CombinedOutput()
	if err != nil {
		return fmt.Errorf("openshell gateway remove: %s", strings.TrimSpace(string(removeOut)))
	}

	fmt.Fprintf(cmd.OutOrStdout(), "Gateway %s removed\n", localName)
	return nil
}
