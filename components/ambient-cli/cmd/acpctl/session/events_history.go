package session

import (
	"context"
	"fmt"
	"time"

	"github.com/ambient-code/platform/components/ambient-cli/pkg/config"
	"github.com/ambient-code/platform/components/ambient-cli/pkg/connection"
	"github.com/ambient-code/platform/components/ambient-cli/pkg/output"
	sdkclient "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/client"
	"github.com/spf13/cobra"
)

var eventsHistoryArgs struct {
	afterSeq     int64
	eventType    string
	limit        int
	outputFormat string
}

var eventsHistoryCmd = &cobra.Command{
	Use:   "events-history <session-id>",
	Short: "List persisted compressed AG-UI events for a session",
	Long: `List persisted compressed AG-UI events for a session.

Retrieves events from the Events API (database-backed), not the live
SSE stream. Use this to replay or audit events after a session ends.

Examples:
  acpctl session events-history <id>
  acpctl session events-history <id> --event-type TEXT_MESSAGE_END
  acpctl session events-history <id> --after-seq 100 --limit 50
  acpctl session events-history <id> -o json`,
	Args: cobra.ExactArgs(1),
	RunE: runEventsHistory,
}

func init() {
	eventsHistoryCmd.Flags().Int64Var(&eventsHistoryArgs.afterSeq, "after-seq", 0, "Only show events after this sequence number")
	eventsHistoryCmd.Flags().StringVar(&eventsHistoryArgs.eventType, "event-type", "", "Filter by event type")
	eventsHistoryCmd.Flags().IntVar(&eventsHistoryArgs.limit, "limit", 100, "Maximum number of events to return")
	eventsHistoryCmd.Flags().StringVarP(&eventsHistoryArgs.outputFormat, "output", "o", "", "Output format: json, yaml")
}

func runEventsHistory(cmd *cobra.Command, args []string) error {
	sessionID := args[0]

	client, err := connection.NewClientFromConfig()
	if err != nil {
		return err
	}

	format, err := output.ParseFormat(eventsHistoryArgs.outputFormat)
	if err != nil {
		return err
	}
	printer := output.NewPrinter(format, cmd.OutOrStdout())

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), cfg.GetRequestTimeout())
	defer cancel()

	opts := &sdkclient.SessionEventListOptions{
		AfterSeq:  eventsHistoryArgs.afterSeq,
		EventType: eventsHistoryArgs.eventType,
		Limit:     eventsHistoryArgs.limit,
	}

	result, err := client.Sessions().ListEvents(ctx, sessionID, opts)
	if err != nil {
		return fmt.Errorf("list events: %w", err)
	}

	if printer.Format() == output.FormatJSON {
		return printer.PrintJSON(result)
	}
	if printer.Format() == output.FormatYAML {
		return printer.PrintYAML(result)
	}

	w := printer.Writer()
	fmt.Fprintf(w, "Events for session %s (%d of %d total)\n\n", sessionID, len(result.Items), result.Total)

	for _, evt := range result.Items {
		var age string
		if evt.CreatedAt != nil {
			age = output.FormatAge(time.Since(*evt.CreatedAt))
		}
		countStr := ""
		if evt.EventCount > 1 {
			countStr = fmt.Sprintf("  (compressed: %d events)", evt.EventCount)
		}
		header := fmt.Sprintf("#%-6d  %-30s  %s%s", evt.Seq, evt.EventType, age, countStr)
		fmt.Fprintln(w, header)

		if evt.Payload != "" {
			payloadPreview := evt.Payload
			if len(payloadPreview) > 200 {
				payloadPreview = payloadPreview[:197] + "..."
			}
			fmt.Fprintf(w, "         %s\n", payloadPreview)
		}
		fmt.Fprintln(w)
	}
	return nil
}
