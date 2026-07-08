package gateways

import (
	"context"

	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
	"github.com/openshift-online/rh-trex-ai/pkg/errors"
	"github.com/openshift-online/rh-trex-ai/pkg/logger"
	"github.com/openshift-online/rh-trex-ai/pkg/services"
)

const GatewaysLockType db.LockType = "gateways"

var (
	DisableAdvisoryLock     = false
	UseBlockingAdvisoryLock = true
)

type GatewayService interface {
	Get(ctx context.Context, id string) (*Gateway, *errors.ServiceError)
	Create(ctx context.Context, gateway *Gateway) (*Gateway, *errors.ServiceError)
	Replace(ctx context.Context, gateway *Gateway) (*Gateway, *errors.ServiceError)
	Delete(ctx context.Context, id string) *errors.ServiceError
	All(ctx context.Context) (GatewayList, *errors.ServiceError)

	FindByIDs(ctx context.Context, ids []string) (GatewayList, *errors.ServiceError)

	OnUpsert(ctx context.Context, id string) error
	OnDelete(ctx context.Context, id string) error
}

func NewGatewayService(lockFactory db.LockFactory, gatewayDao GatewayDao, events services.EventService) GatewayService {
	return &sqlGatewayService{
		lockFactory: lockFactory,
		gatewayDao:  gatewayDao,
		events:      events,
	}
}

var _ GatewayService = &sqlGatewayService{}

type sqlGatewayService struct {
	lockFactory db.LockFactory
	gatewayDao  GatewayDao
	events      services.EventService
}

func (s *sqlGatewayService) OnUpsert(ctx context.Context, id string) error {
	log := logger.NewLogger(ctx)

	gateway, err := s.gatewayDao.Get(ctx, id)
	if err != nil {
		return err
	}

	log.Infof("Gateway upserted: %s (project=%s)", gateway.ID, gateway.ProjectId)

	return nil
}

func (s *sqlGatewayService) OnDelete(ctx context.Context, id string) error {
	log := logger.NewLogger(ctx)
	log.Infof("Gateway deleted: %s", id)
	return nil
}

func (s *sqlGatewayService) Get(ctx context.Context, id string) (*Gateway, *errors.ServiceError) {
	gateway, err := s.gatewayDao.Get(ctx, id)
	if err != nil {
		return nil, services.HandleGetError("Gateway", "id", id, err)
	}
	return gateway, nil
}

func (s *sqlGatewayService) Create(ctx context.Context, gateway *Gateway) (*Gateway, *errors.ServiceError) {
	gateway, err := s.gatewayDao.Create(ctx, gateway)
	if err != nil {
		return nil, services.HandleCreateError("Gateway", err)
	}

	_, evErr := s.events.Create(ctx, &api.Event{
		Source:    "Gateways",
		SourceID:  gateway.ID,
		EventType: api.CreateEventType,
	})
	if evErr != nil {
		return nil, services.HandleCreateError("Gateway", evErr)
	}

	return gateway, nil
}

func (s *sqlGatewayService) Replace(ctx context.Context, gateway *Gateway) (*Gateway, *errors.ServiceError) {
	if !DisableAdvisoryLock {
		if UseBlockingAdvisoryLock {
			lockOwnerID, err := s.lockFactory.NewAdvisoryLock(ctx, gateway.ID, GatewaysLockType)
			if err != nil {
				return nil, errors.DatabaseAdvisoryLock(err)
			}
			defer s.lockFactory.Unlock(ctx, lockOwnerID)
		} else {
			lockOwnerID, locked, err := s.lockFactory.NewNonBlockingLock(ctx, gateway.ID, GatewaysLockType)
			if err != nil {
				return nil, errors.DatabaseAdvisoryLock(err)
			}
			if !locked {
				return nil, services.HandleCreateError("Gateway", errors.New(errors.ErrorConflict, "row locked"))
			}
			defer s.lockFactory.Unlock(ctx, lockOwnerID)
		}
	}

	gateway, err := s.gatewayDao.Replace(ctx, gateway)
	if err != nil {
		return nil, services.HandleUpdateError("Gateway", err)
	}

	_, evErr := s.events.Create(ctx, &api.Event{
		Source:    "Gateways",
		SourceID:  gateway.ID,
		EventType: api.UpdateEventType,
	})
	if evErr != nil {
		return nil, services.HandleUpdateError("Gateway", evErr)
	}

	return gateway, nil
}

func (s *sqlGatewayService) Delete(ctx context.Context, id string) *errors.ServiceError {
	if err := s.gatewayDao.Delete(ctx, id); err != nil {
		return services.HandleDeleteError("Gateway", errors.GeneralError("unable to delete gateway: %s", err))
	}

	_, evErr := s.events.Create(ctx, &api.Event{
		Source:    "Gateways",
		SourceID:  id,
		EventType: api.DeleteEventType,
	})
	if evErr != nil {
		return services.HandleDeleteError("Gateway", evErr)
	}

	return nil
}

func (s *sqlGatewayService) FindByIDs(ctx context.Context, ids []string) (GatewayList, *errors.ServiceError) {
	gateways, err := s.gatewayDao.FindByIDs(ctx, ids)
	if err != nil {
		return nil, errors.GeneralError("unable to find gateways: %s", err)
	}
	return gateways, nil
}

func (s *sqlGatewayService) All(ctx context.Context) (GatewayList, *errors.ServiceError) {
	gateways, err := s.gatewayDao.All(ctx)
	if err != nil {
		return nil, errors.GeneralError("unable to get all gateways: %s", err)
	}
	return gateways, nil
}
