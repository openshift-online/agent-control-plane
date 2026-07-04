package applications_test

import (
	"context"
	"fmt"

	"github.com/ambient-code/platform/components/ambient-api-server/plugins/applications"
	"github.com/openshift-online/rh-trex-ai/pkg/environments"
)

func newApplication(name string) (*applications.Application, error) {
	applicationService := applications.Service(&environments.Environment().Services)

	application := &applications.Application{
		Name:               name,
		SourceRepoUrl:      "https://github.com/test/repo",
		SourcePath:         "agents/",
		DestinationProject: "default",
	}

	created, err := applicationService.Create(context.Background(), application)
	if err != nil {
		return nil, err
	}

	return created, nil
}

func newApplicationList(namePrefix string, count int) ([]*applications.Application, error) {
	var items []*applications.Application
	for i := 1; i <= count; i++ {
		name := fmt.Sprintf("%s_%d", namePrefix, i)
		a, err := newApplication(name)
		if err != nil {
			return nil, err
		}
		items = append(items, a)
	}
	return items, nil
}
