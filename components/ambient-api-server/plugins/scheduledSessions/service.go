package scheduledSessions

import (
	"context"
	"fmt"
	"time"

	"github.com/golang/glog"
	"github.com/openshift-online/rh-trex-ai/pkg/errors"
	"github.com/openshift-online/rh-trex-ai/pkg/services"
	"gorm.io/gorm"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/clock"
	"github.com/ambient-code/platform/components/ambient-api-server/pkg/rbac"
	"github.com/ambient-code/platform/components/ambient-api-server/plugins/sessions"
)

type ScheduledSessionService interface {
	Get(ctx context.Context, id string) (*ScheduledSession, *errors.ServiceError)
	Create(ctx context.Context, ss *ScheduledSession) (*ScheduledSession, *errors.ServiceError)
	Patch(ctx context.Context, id string, patch *ScheduledSessionPatch) (*ScheduledSession, *errors.ServiceError)
	Delete(ctx context.Context, id string) *errors.ServiceError
	ListByProject(ctx context.Context, projectId string) (ScheduledSessionList, *errors.ServiceError)
	Suspend(ctx context.Context, id string) (*ScheduledSession, *errors.ServiceError)
	Resume(ctx context.Context, id string) (*ScheduledSession, *errors.ServiceError)
	Trigger(ctx context.Context, id string) (*sessions.Session, *errors.ServiceError)
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
	dao        ScheduledSessionDao
	clock      clock.Clock
	sessionSvc sessions.SessionService
	messageSvc sessions.MessageService
	evaluator  *rbac.Evaluator
}

func NewScheduledSessionService(dao ScheduledSessionDao, clk clock.Clock, sessionSvc sessions.SessionService, messageSvc sessions.MessageService, evaluator *rbac.Evaluator) ScheduledSessionService {
	return &sqlScheduledSessionService{
		dao:        dao,
		clock:      clk,
		sessionSvc: sessionSvc,
		messageSvc: messageSvc,
		evaluator:  evaluator,
	}
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

func (s *sqlScheduledSessionService) Trigger(ctx context.Context, id string) (*sessions.Session, *errors.ServiceError) {
	ss, svcErr := s.Get(ctx, id)
	if svcErr != nil {
		return nil, svcErr
	}
	return s.createSessionFromSchedule(ctx, ss, s.clock.Now().Truncate(time.Second), false)
}

func (s *sqlScheduledSessionService) createSessionFromSchedule(
	ctx context.Context,
	ss *ScheduledSession,
	scheduledFor time.Time,
	isSchedulerTrigger bool,
) (*sessions.Session, *errors.ServiceError) {
	if isSchedulerTrigger {
		if ss.CreatedByUserId == nil {
			glog.Warningf("Schedule %s disabled: no creator identity", ss.ID)
			ss.Enabled = false
			_ = s.dao.UpdateScheduleState(ctx, ss)
			return nil, nil
		}

		if s.evaluator != nil {
			allowed, evalErr := s.evaluator.Evaluate(ctx, *ss.CreatedByUserId, rbac.ResourceSession, rbac.ActionCreate, rbac.RequestScope{ProjectID: ss.ProjectId})
			if evalErr != nil {
				return nil, errors.GeneralError("RBAC evaluation failed for schedule %s: %v", ss.ID, evalErr)
			}
			if !allowed {
				glog.Warningf("Schedule %s disabled: creator %s no longer authorized", ss.ID, *ss.CreatedByUserId)
				ss.Enabled = false
				_ = s.dao.UpdateScheduleState(ctx, ss)
				return nil, nil
			}
		}

		if ss.OverlapPolicy == "skip" && s.sessionSvc != nil {
			active, lookupErr := s.sessionSvc.ActiveByScheduledSessionID(ctx, ss.ID)
			if lookupErr != nil {
				return nil, lookupErr
			}
			if active != nil {
				glog.Infof("Schedule %s: skipping due to overlap (active session %s)", ss.ID, active.ID)
				return nil, nil
			}
		}
	}

	if s.sessionSvc == nil {
		return nil, errors.GeneralError("session service not available")
	}

	stopDefault := true
	stopVal := &stopDefault
	if ss.StopOnRunFinished != nil {
		stopVal = ss.StopOnRunFinished
	}

	sess := &sessions.Session{
		Name:                     fmt.Sprintf("sched-%s-%d", ss.Name, scheduledFor.Unix()),
		Prompt:                   ss.SessionPrompt,
		ProjectId:                &ss.ProjectId,
		AgentId:                  ss.AgentId,
		Timeout:                  ss.Timeout,
		CreatedByUserId:          ss.CreatedByUserId,
		SourceScheduledSessionId: &ss.ID,
		ScheduledFor:             &scheduledFor,
	}
	_ = stopVal // stop_on_run_finished is on the Session model but not yet wired to runner behavior

	created, createErr := s.sessionSvc.Create(ctx, sess)
	if createErr != nil {
		return nil, createErr
	}

	if ss.SessionPrompt != nil && *ss.SessionPrompt != "" && s.messageSvc != nil {
		if _, msgErr := s.messageSvc.Push(ctx, created.ID, "user", *ss.SessionPrompt); msgErr != nil {
			glog.Warningf("Schedule %s: failed to push initial prompt for session %s: %v", ss.ID, created.ID, msgErr)
		}
	}

	if _, startErr := s.sessionSvc.Start(ctx, created.ID); startErr != nil {
		glog.Warningf("Schedule %s: session %s created but start failed: %v", ss.ID, created.ID, startErr)
	}

	return created, nil
}
