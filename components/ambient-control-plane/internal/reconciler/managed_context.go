package reconciler

import (
	"context"
	"encoding/json"
	"fmt"
	sdkclient "github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/client"
	"github.com/openshift-online/agent-control-plane/components/ambient-sdk/go-sdk/types"
	"strings"
)

// The API stores the initial user task as a session message. Supply the other
// startup context as SDK instructions without submitting that task a second time.
func (r *ManagedReconciler) applyManagedContext(ctx context.Context, sdk *sdkclient.Client, session types.Session, agent *types.Agent, env map[string]string) error {
	project, err := sdk.Projects().Get(ctx, session.ProjectID)
	if err != nil {
		return fmt.Errorf("load workspace instructions: %w", err)
	}
	var parts []string
	if project.Prompt != "" {
		parts = append(parts, project.Prompt)
	}
	if agent != nil {
		if agent.ProjectID != session.ProjectID || agent.ID != session.AgentID {
			return fmt.Errorf("agent context does not match session")
		}
		if agent.Prompt != "" {
			parts = append(parts, agent.Prompt)
		}
		for page := 1; ; page++ {
			inbox, err := sdk.InboxMessages().ListByAgent(ctx, session.ProjectID, session.AgentID, &types.ListOptions{Page: page, Size: 100})
			if err != nil {
				return fmt.Errorf("load agent inbox context: %w", err)
			}
			for _, message := range inbox.Items {
				if !message.Read && message.Body != "" {
					parts = append(parts, message.Body)
				}
			}
			if page*100 >= inbox.Total {
				break
			}
			if len(inbox.Items) == 0 {
				return fmt.Errorf("agent inbox inventory is incomplete")
			}
		}
	}
	options := map[string]json.RawMessage{}
	if raw := env["SDK_OPTIONS"]; raw != "" {
		if err := json.Unmarshal([]byte(raw), &options); err != nil || options == nil {
			return fmt.Errorf("SDK_OPTIONS must be a JSON object")
		}
	}
	if raw, ok := options["system_prompt"]; ok {
		var existing string
		if err := json.Unmarshal(raw, &existing); err != nil {
			return fmt.Errorf("SDK_OPTIONS system_prompt must be a string")
		}
		if existing != "" {
			parts = append(parts, existing)
		}
	}
	if len(parts) == 0 {
		return nil
	}
	prompt, err := json.Marshal(strings.Join(parts, "\n\n"))
	if err != nil {
		return fmt.Errorf("encode managed instructions: %w", err)
	}
	options["system_prompt"] = prompt
	encoded, err := json.Marshal(options)
	if err != nil {
		return fmt.Errorf("encode managed SDK options: %w", err)
	}
	env["SDK_OPTIONS"] = string(encoded)
	return nil
}
