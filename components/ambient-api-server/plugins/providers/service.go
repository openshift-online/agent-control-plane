package providers

import (
	"context"

	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
	"github.com/openshift-online/rh-trex-ai/pkg/errors"
	"github.com/openshift-online/rh-trex-ai/pkg/logger"
	"github.com/openshift-online/rh-trex-ai/pkg/services"
)

const providersLockType db.LockType = "providers"

type ProviderService interface {
	Get(ctx context.Context, id string) (*Provider, *errors.ServiceError)
	Create(ctx context.Context, provider *Provider) (*Provider, *errors.ServiceError)
	Replace(ctx context.Context, provider *Provider) (*Provider, *errors.ServiceError)
	Delete(ctx context.Context, id string) *errors.ServiceError
	All(ctx context.Context) (ProviderList, *errors.ServiceError)
	AllByProjectID(ctx context.Context, projectID string) (ProviderList, *errors.ServiceError)

	OnUpsert(ctx context.Context, id string) error
	OnDelete(ctx context.Context, id string) error
}

func NewProviderService(lockFactory db.LockFactory, providerDao ProviderDao, events services.EventService) ProviderService {
	return &sqlProviderService{
		lockFactory: lockFactory,
		providerDao: providerDao,
		events:      events,
	}
}

type sqlProviderService struct {
	lockFactory db.LockFactory
	providerDao ProviderDao
	events      services.EventService
}

func (s *sqlProviderService) Get(ctx context.Context, id string) (*Provider, *errors.ServiceError) {
	provider, err := s.providerDao.Get(ctx, id)
	if err != nil {
		return nil, services.HandleGetError("Provider", "id", id, err)
	}
	return provider, nil
}

func (s *sqlProviderService) Create(ctx context.Context, provider *Provider) (*Provider, *errors.ServiceError) {
	provider, err := s.providerDao.Create(ctx, provider)
	if err != nil {
		return nil, services.HandleCreateError("Provider", err)
	}

	_, evErr := s.events.Create(ctx, &api.Event{
		Source:    "Providers",
		SourceID:  provider.ID,
		EventType: api.CreateEventType,
	})
	if evErr != nil {
		return nil, services.HandleCreateError("Provider", evErr)
	}

	return provider, nil
}

func (s *sqlProviderService) Replace(ctx context.Context, provider *Provider) (*Provider, *errors.ServiceError) {
	lockOwnerID, locked, err := s.lockFactory.NewNonBlockingLock(ctx, provider.ID, providersLockType)
	if err != nil {
		return nil, errors.DatabaseAdvisoryLock(err)
	}
	if !locked {
		return nil, services.HandleCreateError("Provider", errors.New(errors.ErrorConflict, "row locked"))
	}
	defer s.lockFactory.Unlock(ctx, lockOwnerID)

	provider, err = s.providerDao.Replace(ctx, provider)
	if err != nil {
		return nil, services.HandleUpdateError("Provider", err)
	}

	_, evErr := s.events.Create(ctx, &api.Event{
		Source:    "Providers",
		SourceID:  provider.ID,
		EventType: api.UpdateEventType,
	})
	if evErr != nil {
		return nil, services.HandleUpdateError("Provider", evErr)
	}

	return provider, nil
}

func (s *sqlProviderService) Delete(ctx context.Context, id string) *errors.ServiceError {
	if err := s.providerDao.Delete(ctx, id); err != nil {
		return services.HandleDeleteError("Provider", errors.GeneralError("Unable to delete provider: %s", err))
	}

	_, evErr := s.events.Create(ctx, &api.Event{
		Source:    "Providers",
		SourceID:  id,
		EventType: api.DeleteEventType,
	})
	if evErr != nil {
		return services.HandleDeleteError("Provider", evErr)
	}

	return nil
}

func (s *sqlProviderService) All(ctx context.Context) (ProviderList, *errors.ServiceError) {
	providers, err := s.providerDao.All(ctx)
	if err != nil {
		return nil, services.HandleGetError("Provider", "all", "", err)
	}
	return providers, nil
}

func (s *sqlProviderService) AllByProjectID(ctx context.Context, projectID string) (ProviderList, *errors.ServiceError) {
	providers, err := s.providerDao.AllByProjectID(ctx, projectID)
	if err != nil {
		return nil, services.HandleGetError("Provider", "project_id", projectID, err)
	}
	return providers, nil
}

func (s *sqlProviderService) OnUpsert(ctx context.Context, id string) error {
	l := logger.NewLogger(ctx)
	l.Infof("Provider upserted: %s", id)
	return nil
}

func (s *sqlProviderService) OnDelete(ctx context.Context, id string) error {
	l := logger.NewLogger(ctx)
	l.Infof("Provider deleted: %s", id)
	return nil
}
