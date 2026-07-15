package clusters

import (
	"context"

	"gorm.io/gorm/clause"

	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
)

type ClusterDao interface {
	Get(ctx context.Context, id string) (*Cluster, error)
	Create(ctx context.Context, cluster *Cluster) (*Cluster, error)
	Replace(ctx context.Context, cluster *Cluster) (*Cluster, error)
	Delete(ctx context.Context, id string) error
	FindByIDs(ctx context.Context, ids []string) (ClusterList, error)
	All(ctx context.Context) (ClusterList, error)
}

var _ ClusterDao = &sqlClusterDao{}

type sqlClusterDao struct {
	sessionFactory *db.SessionFactory
}

func NewClusterDao(sessionFactory *db.SessionFactory) ClusterDao {
	return &sqlClusterDao{sessionFactory: sessionFactory}
}

func (d *sqlClusterDao) Get(ctx context.Context, id string) (*Cluster, error) {
	g2 := (*d.sessionFactory).New(ctx)
	var cluster Cluster
	if err := g2.Take(&cluster, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &cluster, nil
}

func (d *sqlClusterDao) Create(ctx context.Context, cluster *Cluster) (*Cluster, error) {
	g2 := (*d.sessionFactory).New(ctx)
	if err := g2.Omit(clause.Associations).Create(cluster).Error; err != nil {
		db.MarkForRollback(ctx, err)
		return nil, err
	}
	return cluster, nil
}

func (d *sqlClusterDao) Replace(ctx context.Context, cluster *Cluster) (*Cluster, error) {
	g2 := (*d.sessionFactory).New(ctx)
	if err := g2.Omit(clause.Associations).Save(cluster).Error; err != nil {
		db.MarkForRollback(ctx, err)
		return nil, err
	}
	return cluster, nil
}

func (d *sqlClusterDao) Delete(ctx context.Context, id string) error {
	g2 := (*d.sessionFactory).New(ctx)
	if err := g2.Omit(clause.Associations).Delete(&Cluster{Meta: api.Meta{ID: id}}).Error; err != nil {
		db.MarkForRollback(ctx, err)
		return err
	}
	return nil
}

func (d *sqlClusterDao) FindByIDs(ctx context.Context, ids []string) (ClusterList, error) {
	g2 := (*d.sessionFactory).New(ctx)
	clusters := ClusterList{}
	if err := g2.Where("id in (?)", ids).Find(&clusters).Error; err != nil {
		return nil, err
	}
	return clusters, nil
}

func (d *sqlClusterDao) All(ctx context.Context) (ClusterList, error) {
	g2 := (*d.sessionFactory).New(ctx)
	clusters := ClusterList{}
	if err := g2.Find(&clusters).Error; err != nil {
		return nil, err
	}
	return clusters, nil
}
