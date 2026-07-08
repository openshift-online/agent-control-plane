package gateways

import (
	"context"

	"gorm.io/gorm/clause"

	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
)

type GatewayDao interface {
	Get(ctx context.Context, id string) (*Gateway, error)
	Create(ctx context.Context, gateway *Gateway) (*Gateway, error)
	Replace(ctx context.Context, gateway *Gateway) (*Gateway, error)
	Delete(ctx context.Context, id string) error
	FindByIDs(ctx context.Context, ids []string) (GatewayList, error)
	All(ctx context.Context) (GatewayList, error)
}

var _ GatewayDao = &sqlGatewayDao{}

type sqlGatewayDao struct {
	sessionFactory *db.SessionFactory
}

func NewGatewayDao(sessionFactory *db.SessionFactory) GatewayDao {
	return &sqlGatewayDao{sessionFactory: sessionFactory}
}

func (d *sqlGatewayDao) Get(ctx context.Context, id string) (*Gateway, error) {
	g2 := (*d.sessionFactory).New(ctx)
	var gateway Gateway
	if err := g2.Take(&gateway, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &gateway, nil
}

func (d *sqlGatewayDao) Create(ctx context.Context, gateway *Gateway) (*Gateway, error) {
	g2 := (*d.sessionFactory).New(ctx)
	if err := g2.Omit(clause.Associations).Create(gateway).Error; err != nil {
		db.MarkForRollback(ctx, err)
		return nil, err
	}
	return gateway, nil
}

func (d *sqlGatewayDao) Replace(ctx context.Context, gateway *Gateway) (*Gateway, error) {
	g2 := (*d.sessionFactory).New(ctx)
	if err := g2.Omit(clause.Associations).Save(gateway).Error; err != nil {
		db.MarkForRollback(ctx, err)
		return nil, err
	}
	return gateway, nil
}

func (d *sqlGatewayDao) Delete(ctx context.Context, id string) error {
	g2 := (*d.sessionFactory).New(ctx)
	if err := g2.Omit(clause.Associations).Delete(&Gateway{Meta: api.Meta{ID: id}}).Error; err != nil {
		db.MarkForRollback(ctx, err)
		return err
	}
	return nil
}

func (d *sqlGatewayDao) FindByIDs(ctx context.Context, ids []string) (GatewayList, error) {
	g2 := (*d.sessionFactory).New(ctx)
	gateways := GatewayList{}
	if err := g2.Where("id in (?)", ids).Find(&gateways).Error; err != nil {
		return nil, err
	}
	return gateways, nil
}

func (d *sqlGatewayDao) All(ctx context.Context) (GatewayList, error) {
	g2 := (*d.sessionFactory).New(ctx)
	gateways := GatewayList{}
	if err := g2.Find(&gateways).Error; err != nil {
		return nil, err
	}
	return gateways, nil
}
