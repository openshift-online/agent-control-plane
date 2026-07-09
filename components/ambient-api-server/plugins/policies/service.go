package policies

import (
	"context"

	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
	"github.com/openshift-online/rh-trex-ai/pkg/errors"
	"github.com/openshift-online/rh-trex-ai/pkg/logger"
	"github.com/openshift-online/rh-trex-ai/pkg/services"
)

const policiesLockType db.LockType = "policies"

type PolicyService interface {
	Get(ctx context.Context, id string) (*Policy, *errors.ServiceError)
	Create(ctx context.Context, policy *Policy) (*Policy, *errors.ServiceError)
	Replace(ctx context.Context, policy *Policy) (*Policy, *errors.ServiceError)
	Delete(ctx context.Context, id string) *errors.ServiceError
	All(ctx context.Context) (PolicyList, *errors.ServiceError)
	AllByProjectID(ctx context.Context, projectID string) (PolicyList, *errors.ServiceError)

	OnUpsert(ctx context.Context, id string) error
	OnDelete(ctx context.Context, id string) error
}

func NewPolicyService(lockFactory db.LockFactory, policyDao PolicyDao, events services.EventService) PolicyService {
	return &sqlPolicyService{
		lockFactory: lockFactory,
		policyDao:   policyDao,
		events:      events,
	}
}

type sqlPolicyService struct {
	lockFactory db.LockFactory
	policyDao   PolicyDao
	events      services.EventService
}

func (s *sqlPolicyService) Get(ctx context.Context, id string) (*Policy, *errors.ServiceError) {
	policy, err := s.policyDao.Get(ctx, id)
	if err != nil {
		return nil, services.HandleGetError("Policy", "id", id, err)
	}
	return policy, nil
}

func (s *sqlPolicyService) Create(ctx context.Context, policy *Policy) (*Policy, *errors.ServiceError) {
	policy, err := s.policyDao.Create(ctx, policy)
	if err != nil {
		return nil, services.HandleCreateError("Policy", err)
	}

	_, evErr := s.events.Create(ctx, &api.Event{
		Source:    "Policies",
		SourceID:  policy.ID,
		EventType: api.CreateEventType,
	})
	if evErr != nil {
		return nil, services.HandleCreateError("Policy", evErr)
	}

	return policy, nil
}

func (s *sqlPolicyService) Replace(ctx context.Context, policy *Policy) (*Policy, *errors.ServiceError) {
	lockOwnerID, locked, err := s.lockFactory.NewNonBlockingLock(ctx, policy.ID, policiesLockType)
	if err != nil {
		return nil, errors.DatabaseAdvisoryLock(err)
	}
	if !locked {
		return nil, services.HandleCreateError("Policy", errors.New(errors.ErrorConflict, "row locked"))
	}
	defer s.lockFactory.Unlock(ctx, lockOwnerID)

	policy, err = s.policyDao.Replace(ctx, policy)
	if err != nil {
		return nil, services.HandleUpdateError("Policy", err)
	}

	_, evErr := s.events.Create(ctx, &api.Event{
		Source:    "Policies",
		SourceID:  policy.ID,
		EventType: api.UpdateEventType,
	})
	if evErr != nil {
		return nil, services.HandleUpdateError("Policy", evErr)
	}

	return policy, nil
}

func (s *sqlPolicyService) Delete(ctx context.Context, id string) *errors.ServiceError {
	if err := s.policyDao.Delete(ctx, id); err != nil {
		return services.HandleDeleteError("Policy", errors.GeneralError("Unable to delete policy: %s", err))
	}

	_, evErr := s.events.Create(ctx, &api.Event{
		Source:    "Policies",
		SourceID:  id,
		EventType: api.DeleteEventType,
	})
	if evErr != nil {
		return services.HandleDeleteError("Policy", evErr)
	}

	return nil
}

func (s *sqlPolicyService) All(ctx context.Context) (PolicyList, *errors.ServiceError) {
	policies, err := s.policyDao.All(ctx)
	if err != nil {
		return nil, services.HandleGetError("Policy", "all", "", err)
	}
	return policies, nil
}

func (s *sqlPolicyService) AllByProjectID(ctx context.Context, projectID string) (PolicyList, *errors.ServiceError) {
	policies, err := s.policyDao.AllByProjectID(ctx, projectID)
	if err != nil {
		return nil, services.HandleGetError("Policy", "project_id", projectID, err)
	}
	return policies, nil
}

func (s *sqlPolicyService) OnUpsert(ctx context.Context, id string) error {
	l := logger.NewLogger(ctx)
	l.Infof("Policy upserted: %s", id)
	return nil
}

func (s *sqlPolicyService) OnDelete(ctx context.Context, id string) error {
	l := logger.NewLogger(ctx)
	l.Infof("Policy deleted: %s", id)
	return nil
}
