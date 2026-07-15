package clusters_test

import (
	"context"
	"fmt"

	"github.com/ambient-code/platform/components/ambient-api-server/plugins/clusters"
	"github.com/openshift-online/rh-trex-ai/pkg/environments"
)

func newCluster(id string) (*clusters.Cluster, error) {
	clusterService := clusters.Service(&environments.Environment().Services)

	c := &clusters.Cluster{
		Name:         fmt.Sprintf("test-cluster-%s", id),
		ApiServerUrl: fmt.Sprintf("https://k8s-%s.example.com:6443", id),
		Role:         "hybrid",
	}

	created, err := clusterService.Create(context.Background(), c)
	if err != nil {
		return nil, err
	}
	return created, nil
}

func newClusterList(namePrefix string, count int) ([]*clusters.Cluster, error) {
	var items []*clusters.Cluster
	for i := 1; i <= count; i++ {
		name := fmt.Sprintf("%s_%d", namePrefix, i)
		c, err := newCluster(name)
		if err != nil {
			return nil, err
		}
		items = append(items, c)
	}
	return items, nil
}
