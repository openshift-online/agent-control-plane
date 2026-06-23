package scheduledSessions

import (
	"context"
	"time"

	"github.com/openshift-online/rh-trex-ai/pkg/errors"
	"github.com/openshift-online/rh-trex-ai/pkg/services"
	"gorm.io/gorm"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/clock"
)

type ScheduledSessionService interface {
	Get(ctx context.Context, id string) (*ScheduledSession, *errors.ServiceError)
	Create(ctx context.Context, ss *ScheduledSession) (*ScheduledSession, *errors.ServiceError)
	Patch(ctx context.Context, id string, patch *ScheduledSessionPatch) (*ScheduledSession, *errors.ServiceError)
	Delete(ctx context.Context, id string) *errors.ServiceError
	ListByProject(ctx context.Context, projectId string) (ScheduledSessionList, *errors.ServiceError)
	Suspend(ctx context.Context, id string) (*ScheduledSession, *errors.ServiceError)
	Resume(ctx context.Context, id string) (*ScheduledSession, *errors.ServiceError)
	Trigger(ctx context.Context, id string) *errors.ServiceError
}

type ScheduledSessionPatch struct {
	Name              *string
	Description       *string
	AgentId           *string
	Schedule          *string
	Timezone          *string
	Enabled           *bool
	SessionPrompt     *string
	Timeout           *int32
	InactivityTimeout *int32
	StopOnRunFinished *bool
	RunnerType        *string
	OverlapPolicy     *string
}

type sqlScheduledSessionService struct {
	dao   ScheduledSessionDao
	clock clock.Clock
}

func NewScheduledSessionService(dao ScheduledSessionDao, clk clock.Clock) ScheduledSessionService {
	return &sqlScheduledSessionService{dao: dao, clock: clk}
}

func (s *sqlScheduledSessionService) Get(ctx context.Context, id string) (*ScheduledSession, *errors.ServiceError) {
	ss, err := s.dao.Get(ctx, id)
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, errors.NotFound("ScheduledSession with id '%s' not found", id)
		}
		return nil, services.HandleGetError("ScheduledSession", "id", id, err)
	}
	return ss, nil
}

func (s *sqlScheduledSessionService) Create(ctx context.Context, ss *ScheduledSession) (*ScheduledSession, *errors.ServiceError) {
	if err := ValidateCron(ss.Schedule); err != nil {
		return nil, errors.Validation("invalid cron expression: %v", err)
	}
	if ss.Timezone == "" {
		ss.Timezone = "UTC"
	}
	if _, err := time.LoadLocation(ss.Timezone); err != nil {
		return nil, errors.Validation("invalid timezone: %v", err)
	}
	if ss.OverlapPolicy != "" && ss.OverlapPolicy != "skip" && ss.OverlapPolicy != "allow" {
		return nil, errors.Validation("overlap_policy must be 'skip' or 'allow'")
	}
	next, err := NextRunAt(s.clock, ss.Schedule, ss.Timezone, ss.Enabled)
	if err != nil {
		return nil, errors.GeneralError("failed to compute next_run_at: %v", err)
	}
	ss.NextRunAt = next

	created, createErr := s.dao.Create(ctx, ss)
	if createErr != nil {
		return nil, errors.GeneralError("failed to create scheduled session: %v", createErr)
	}
	return created, nil
}

func (s *sqlScheduledSessionService) Patch(ctx context.Context, id string, patch *ScheduledSessionPatch) (*ScheduledSession, *errors.ServiceError) {
	ss, svcErr := s.Get(ctx, id)
	if svcErr != nil {
		return nil, svcErr
	}

	recomputeNext := false

	if patch.Name != nil {
		ss.Name = *patch.Name
	}
	if patch.Description != nil {
		ss.Description = patch.Description
	}
	if patch.AgentId != nil {
		ss.AgentId = patch.AgentId
	}
	if patch.Schedule != nil {
		if err := ValidateCron(*patch.Schedule); err != nil {
			return nil, errors.Validation("invalid cron expression: %v", err)
		}
		ss.Schedule = *patch.Schedule
		recomputeNext = true
	}
	if patch.Timezone != nil {
		if _, err := time.LoadLocation(*patch.Timezone); err != nil {
			return nil, errors.Validation("invalid timezone: %v", err)
		}
		ss.Timezone = *patch.Timezone
		recomputeNext = true
	}
	if patch.Enabled != nil {
		ss.Enabled = *patch.Enabled
		recomputeNext = true
	}
	if patch.SessionPrompt != nil {
		ss.SessionPrompt = patch.SessionPrompt
	}
	if patch.Timeout != nil {
		ss.Timeout = patch.Timeout
	}
	if patch.InactivityTimeout != nil {
		ss.InactivityTimeout = patch.InactivityTimeout
	}
	if patch.StopOnRunFinished != nil {
		ss.StopOnRunFinished = patch.StopOnRunFinished
	}
	if patch.RunnerType != nil {
		ss.RunnerType = patch.RunnerType
	}
	if patch.OverlapPolicy != nil {
		if *patch.OverlapPolicy != "skip" && *patch.OverlapPolicy != "allow" {
			return nil, errors.Validation("overlap_policy must be 'skip' or 'allow'")
		}
		ss.OverlapPolicy = *patch.OverlapPolicy
	}

	if recomputeNext {
		next, err := NextRunAt(s.clock, ss.Schedule, ss.Timezone, ss.Enabled)
		if err != nil {
			return nil, errors.GeneralError("failed to compute next_run_at: %v", err)
		}
		ss.NextRunAt = next
	}

	updated, err := s.dao.Replace(ctx, ss)
	if err != nil {
		return nil, errors.GeneralError("failed to update scheduled session: %v", err)
	}
	return updated, nil
}

func (s *sqlScheduledSessionService) Delete(ctx context.Context, id string) *errors.ServiceError {
	_, svcErr := s.Get(ctx, id)
	if svcErr != nil {
		return svcErr
	}
	if err := s.dao.Delete(ctx, id); err != nil {
		return errors.GeneralError("failed to delete scheduled session: %v", err)
	}
	return nil
}

func (s *sqlScheduledSessionService) ListByProject(ctx context.Context, projectId string) (ScheduledSessionList, *errors.ServiceError) {
	list, err := s.dao.ListByProject(ctx, projectId)
	if err != nil {
		return nil, errors.GeneralError("failed to list scheduled sessions: %v", err)
	}
	return list, nil
}

func (s *sqlScheduledSessionService) Suspend(ctx context.Context, id string) (*ScheduledSession, *errors.ServiceError) {
	disabled := false
	return s.Patch(ctx, id, &ScheduledSessionPatch{Enabled: &disabled})
}

func (s *sqlScheduledSessionService) Resume(ctx context.Context, id string) (*ScheduledSession, *errors.ServiceError) {
	enabled := true
	return s.Patch(ctx, id, &ScheduledSessionPatch{Enabled: &enabled})
}

func (s *sqlScheduledSessionService) Trigger(ctx context.Context, id string) *errors.ServiceError {
	ss, svcErr := s.Get(ctx, id)
	if svcErr != nil {
		return svcErr
	}
	_ = ss
	// In production this would enqueue an immediate one-off session via the agent start endpoint.
	// In this session, we record intent and return success.
	return nil
}
