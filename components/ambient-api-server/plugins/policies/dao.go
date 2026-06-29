package policies

import (
	"context"

	"gorm.io/gorm/clause"

	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
)

type PolicyDao interface {
	Get(ctx context.Context, id string) (*Policy, error)
	Create(ctx context.Context, policy *Policy) (*Policy, error)
	Replace(ctx context.Context, policy *Policy) (*Policy, error)
	Delete(ctx context.Context, id string) error
	All(ctx context.Context) (PolicyList, error)
	AllByProjectID(ctx context.Context, projectID string) (PolicyList, error)
}

type sqlPolicyDao struct {
	sessionFactory *db.SessionFactory
}

func NewPolicyDao(sessionFactory *db.SessionFactory) PolicyDao {
	return &sqlPolicyDao{sessionFactory: sessionFactory}
}

func (d *sqlPolicyDao) Get(ctx context.Context, id string) (*Policy, error) {
	g2 := (*d.sessionFactory).New(ctx)
	var policy Policy
	if err := g2.Take(&policy, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &policy, nil
}

func (d *sqlPolicyDao) Create(ctx context.Context, policy *Policy) (*Policy, error) {
	g2 := (*d.sessionFactory).New(ctx)
	if err := g2.Omit(clause.Associations).Create(policy).Error; err != nil {
		db.MarkForRollback(ctx, err)
		return nil, err
	}
	return policy, nil
}

func (d *sqlPolicyDao) Replace(ctx context.Context, policy *Policy) (*Policy, error) {
	g2 := (*d.sessionFactory).New(ctx)
	if err := g2.Omit(clause.Associations).Save(policy).Error; err != nil {
		db.MarkForRollback(ctx, err)
		return nil, err
	}
	return policy, nil
}

func (d *sqlPolicyDao) Delete(ctx context.Context, id string) error {
	g2 := (*d.sessionFactory).New(ctx)
	if err := g2.Omit(clause.Associations).Delete(&Policy{Meta: api.Meta{ID: id}}).Error; err != nil {
		db.MarkForRollback(ctx, err)
		return err
	}
	return nil
}

func (d *sqlPolicyDao) All(ctx context.Context) (PolicyList, error) {
	g2 := (*d.sessionFactory).New(ctx)
	policies := PolicyList{}
	if err := g2.Find(&policies).Error; err != nil {
		return nil, err
	}
	return policies, nil
}

func (d *sqlPolicyDao) AllByProjectID(ctx context.Context, projectID string) (PolicyList, error) {
	g2 := (*d.sessionFactory).New(ctx)
	policies := PolicyList{}
	if err := g2.Where("project_id = ?", projectID).Order("name ASC").Find(&policies).Error; err != nil {
		return nil, err
	}
	return policies, nil
}
