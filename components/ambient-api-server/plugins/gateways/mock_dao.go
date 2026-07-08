package gateways

import (
	"context"
	"sync"

	"gorm.io/gorm"
)

var _ GatewayDao = &gatewayDaoMock{}

type gatewayDaoMock struct {
	mu       sync.RWMutex
	gateways GatewayIndex
}

func NewMockGatewayDao() *gatewayDaoMock {
	return &gatewayDaoMock{
		gateways: GatewayIndex{},
	}
}

func (d *gatewayDaoMock) Get(_ context.Context, id string) (*Gateway, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	gw, ok := d.gateways[id]
	if !ok {
		return nil, gorm.ErrRecordNotFound
	}
	return gw, nil
}

func (d *gatewayDaoMock) Create(_ context.Context, gateway *Gateway) (*Gateway, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.gateways[gateway.ID] = gateway
	return gateway, nil
}

func (d *gatewayDaoMock) Replace(_ context.Context, gateway *Gateway) (*Gateway, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.gateways[gateway.ID] = gateway
	return gateway, nil
}

func (d *gatewayDaoMock) Delete(_ context.Context, id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.gateways[id]; !ok {
		return gorm.ErrRecordNotFound
	}
	delete(d.gateways, id)
	return nil
}

func (d *gatewayDaoMock) FindByIDs(_ context.Context, ids []string) (GatewayList, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	var result GatewayList
	for _, id := range ids {
		if gw, ok := d.gateways[id]; ok {
			result = append(result, gw)
		}
	}
	return result, nil
}

func (d *gatewayDaoMock) All(_ context.Context) (GatewayList, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	var result GatewayList
	for _, gw := range d.gateways {
		result = append(result, gw)
	}
	return result, nil
}
