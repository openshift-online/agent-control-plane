package providers

import (
	"context"

	"gorm.io/gorm/clause"

	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
)

type ProviderDao interface {
	Get(ctx context.Context, id string) (*Provider, error)
	Create(ctx context.Context, provider *Provider) (*Provider, error)
	Replace(ctx context.Context, provider *Provider) (*Provider, error)
	Delete(ctx context.Context, id string) error
	All(ctx context.Context) (ProviderList, error)
	AllByProjectID(ctx context.Context, projectID string) (ProviderList, error)
}

type sqlProviderDao struct {
	sessionFactory *db.SessionFactory
}

func NewProviderDao(sessionFactory *db.SessionFactory) ProviderDao {
	return &sqlProviderDao{sessionFactory: sessionFactory}
}

func (d *sqlProviderDao) Get(ctx context.Context, id string) (*Provider, error) {
	g2 := (*d.sessionFactory).New(ctx)
	var provider Provider
	if err := g2.Take(&provider, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &provider, nil
}

func (d *sqlProviderDao) Create(ctx context.Context, provider *Provider) (*Provider, error) {
	g2 := (*d.sessionFactory).New(ctx)
	if err := g2.Omit(clause.Associations).Create(provider).Error; err != nil {
		db.MarkForRollback(ctx, err)
		return nil, err
	}
	return provider, nil
}

func (d *sqlProviderDao) Replace(ctx context.Context, provider *Provider) (*Provider, error) {
	g2 := (*d.sessionFactory).New(ctx)
	if err := g2.Omit(clause.Associations).Save(provider).Error; err != nil {
		db.MarkForRollback(ctx, err)
		return nil, err
	}
	return provider, nil
}

func (d *sqlProviderDao) Delete(ctx context.Context, id string) error {
	g2 := (*d.sessionFactory).New(ctx)
	if err := g2.Omit(clause.Associations).Delete(&Provider{Meta: api.Meta{ID: id}}).Error; err != nil {
		db.MarkForRollback(ctx, err)
		return err
	}
	return nil
}

func (d *sqlProviderDao) All(ctx context.Context) (ProviderList, error) {
	g2 := (*d.sessionFactory).New(ctx)
	providers := ProviderList{}
	if err := g2.Find(&providers).Error; err != nil {
		return nil, err
	}
	return providers, nil
}

func (d *sqlProviderDao) AllByProjectID(ctx context.Context, projectID string) (ProviderList, error) {
	g2 := (*d.sessionFactory).New(ctx)
	providers := ProviderList{}
	if err := g2.Where("project_id = ?", projectID).Order("name ASC").Find(&providers).Error; err != nil {
		return nil, err
	}
	return providers, nil
}
