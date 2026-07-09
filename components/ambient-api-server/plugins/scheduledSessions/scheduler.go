package scheduledSessions

import (
	"context"
	"time"

	"github.com/golang/glog"
	"github.com/openshift-online/rh-trex-ai/pkg/db"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/clock"
)

const (
	schedulerLockType        db.LockType = "scheduled-session-scheduler"
	schedulerLockID                      = "singleton"
	defaultSchedulerInterval             = 30 * time.Second
	defaultBatchLimit                    = 100
)

type SchedulerConfig struct {
	PollInterval time.Duration
	BatchLimit   int
}

type Scheduler struct {
	svc         *sqlScheduledSessionService
	dao         ScheduledSessionDao
	lockFactory db.LockFactory
	clock       clock.Clock
	config      SchedulerConfig
	cancel      context.CancelFunc
	done        chan struct{}
}

func NewScheduler(svc *sqlScheduledSessionService, dao ScheduledSessionDao, lockFactory db.LockFactory, clk clock.Clock, cfg SchedulerConfig) *Scheduler {
	if cfg.PollInterval == 0 {
		cfg.PollInterval = defaultSchedulerInterval
	}
	if cfg.BatchLimit == 0 {
		cfg.BatchLimit = defaultBatchLimit
	}
	return &Scheduler{
		svc:         svc,
		dao:         dao,
		lockFactory: lockFactory,
		clock:       clk,
		config:      cfg,
		done:        make(chan struct{}),
	}
}

func (s *Scheduler) Start(ctx context.Context) {
	ctx, s.cancel = context.WithCancel(ctx)
	go s.run(ctx)
}

func (s *Scheduler) Stop() {
	if s.cancel != nil {
		s.cancel()
	}
	<-s.done
}

func (s *Scheduler) run(ctx context.Context) {
	defer close(s.done)
	ticker := s.clock.NewTicker(s.config.PollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.Tick(ctx)
		}
	}
}

func (s *Scheduler) Tick(ctx context.Context) {
	lockOwnerID, locked, err := s.lockFactory.NewNonBlockingLock(ctx, schedulerLockID, schedulerLockType)
	if err != nil {
		glog.Warningf("Scheduler: advisory lock error: %v", err)
		return
	}
	if !locked {
		return
	}
	defer s.lockFactory.Unlock(ctx, lockOwnerID)

	now := s.clock.Now()
	due, err := s.dao.DueSchedules(ctx, now, s.config.BatchLimit)
	if err != nil {
		glog.Warningf("Scheduler: failed to query due schedules: %v", err)
		return
	}

	for _, ss := range due {
		if ctx.Err() != nil {
			return
		}
		s.processSchedule(ctx, ss, now)
	}
}

func (s *Scheduler) processSchedule(ctx context.Context, ss *ScheduledSession, now time.Time) {
	scheduledFor := now
	if ss.NextRunAt != nil {
		scheduledFor = ss.NextRunAt.Truncate(time.Second)
	}

	_, svcErr := s.svc.createSessionFromSchedule(ctx, ss, scheduledFor, true)
	if svcErr != nil {
		glog.Warningf("Scheduler: failed to create session for schedule %s: %v", ss.ID, svcErr)
	}

	next, err := NextRunAtFrom(now, ss.Schedule, ss.Timezone)
	if err != nil {
		glog.Warningf("Scheduler: failed to compute next_run_at for schedule %s: %v", ss.ID, err)
		return
	}
	ss.NextRunAt = next
	ss.LastRunAt = &now
	if updateErr := s.dao.UpdateScheduleState(ctx, ss); updateErr != nil {
		glog.Warningf("Scheduler: failed to update schedule state for %s: %v", ss.ID, updateErr)
	}
}
