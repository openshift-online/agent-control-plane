package policies_test

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/policies"
	"github.com/openshift-online/rh-trex-ai/pkg/environments"
)

func newPolicy(id string) (*policies.Policy, error) {
	policyService := policies.Service(&environments.Environment().Services)

	spec := map[string]interface{}{
		"allowed_tools":  []string{"bash", "read", "write"},
		"max_iterations": 100,
	}
	specJSON, _ := json.Marshal(spec)
	specStr := string(specJSON)

	p := &policies.Policy{
		Name:      fmt.Sprintf("test-policy-%s", id),
		ProjectId: "test-project",
		Namespace: stringPtr("default"),
		Spec:      &specStr,
	}

	created, err := policyService.Create(context.Background(), p)
	if err != nil {
		return nil, err
	}
	return created, nil
}

func newPolicyList(namePrefix string, count int) ([]*policies.Policy, error) {
	var items []*policies.Policy
	for i := 1; i <= count; i++ {
		name := fmt.Sprintf("%s_%d", namePrefix, i)
		p, err := newPolicy(name)
		if err != nil {
			return nil, err
		}
		items = append(items, p)
	}
	return items, nil
}

func stringPtr(s string) *string { return &s }
