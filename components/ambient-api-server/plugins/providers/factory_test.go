package providers_test

import (
	"context"
	"fmt"

	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/plugins/providers"
	"github.com/openshift-online/rh-trex-ai/pkg/environments"
)

func newProvider(id string) (*providers.Provider, error) {
	providerService := providers.Service(&environments.Environment().Services)

	p := &providers.Provider{
		Name:      fmt.Sprintf("test-provider-%s", id),
		ProjectId: "test-project",
		Type:      stringPtr("llm"),
		Secret:    stringPtr("provider-secret"),
		Namespace: stringPtr("default"),
	}

	created, err := providerService.Create(context.Background(), p)
	if err != nil {
		return nil, err
	}
	return created, nil
}

func newProviderList(namePrefix string, count int) ([]*providers.Provider, error) {
	var items []*providers.Provider
	for i := 1; i <= count; i++ {
		name := fmt.Sprintf("%s_%d", namePrefix, i)
		p, err := newProvider(name)
		if err != nil {
			return nil, err
		}
		items = append(items, p)
	}
	return items, nil
}

func stringPtr(s string) *string { return &s }
