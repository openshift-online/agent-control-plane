package clusters

import (
	"context"
	"sync"

	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"gorm.io/gorm"
)

var _ ClusterDao = &clusterDaoMock{}

type clusterDaoMock struct {
	mu       sync.RWMutex
	clusters ClusterIndex
}

func NewMockClusterDao() *clusterDaoMock {
	return &clusterDaoMock{
		clusters: ClusterIndex{},
	}
}

func (d *clusterDaoMock) Get(_ context.Context, id string) (*Cluster, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	c, ok := d.clusters[id]
	if !ok {
		return nil, gorm.ErrRecordNotFound
	}
	return c, nil
}

func (d *clusterDaoMock) Create(_ context.Context, cluster *Cluster) (*Cluster, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if cluster.ID == "" {
		cluster.ID = api.NewID()
	}
	d.clusters[cluster.ID] = cluster
	return cluster, nil
}

func (d *clusterDaoMock) Replace(_ context.Context, cluster *Cluster) (*Cluster, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.clusters[cluster.ID] = cluster
	return cluster, nil
}

func (d *clusterDaoMock) Delete(_ context.Context, id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.clusters[id]; !ok {
		return gorm.ErrRecordNotFound
	}
	delete(d.clusters, id)
	return nil
}

func (d *clusterDaoMock) FindByIDs(_ context.Context, ids []string) (ClusterList, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	var result ClusterList
	for _, id := range ids {
		if c, ok := d.clusters[id]; ok {
			result = append(result, c)
		}
	}
	return result, nil
}

func (d *clusterDaoMock) All(_ context.Context) (ClusterList, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	var result ClusterList
	for _, c := range d.clusters {
		result = append(result, c)
	}
	return result, nil
}
