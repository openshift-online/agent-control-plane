package scheduledSessions

import (
	"context"
	"testing"
	"time"

	"github.com/openshift-online/rh-trex-ai/pkg/db"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/clock"
	"github.com/ambient-code/platform/components/ambient-api-server/plugins/sessions"
)

type mockLockFactory struct {
	locked bool
}

func (m *mockLockFactory) NewAdvisoryLock(_ context.Context, _ string, _ db.LockType) (string, error) {
	return "owner-1", nil
}

func (m *mockLockFactory) NewNonBlockingLock(_ context.Context, _ string, _ db.LockType) (string, bool, error) {
	return "owner-1", m.locked, nil
}

func (m *mockLockFactory) Unlock(_ context.Context, _ string) {
}

type memScheduleDao struct {
	data map[string]*ScheduledSession
}

func newMemScheduleDao() *memScheduleDao {
	return &memScheduleDao{data: make(map[string]*ScheduledSession)}
}

func (d *memScheduleDao) Get(_ context.Context, id string) (*ScheduledSession, error) {
	ss, ok := d.data[id]
	if !ok {
		return nil, nil
	}
	cp := *ss
	return &cp, nil
}

func (d *memScheduleDao) Create(_ context.Context, ss *ScheduledSession) (*ScheduledSession, error) {
	ss.ID = "ss-" + ss.Name
	d.data[ss.ID] = ss
	return ss, nil
}

func (d *memScheduleDao) Replace(_ context.Context, ss *ScheduledSession) (*ScheduledSession, error) {
	d.data[ss.ID] = ss
	return ss, nil
}

func (d *memScheduleDao) Delete(_ context.Context, id string) error {
	delete(d.data, id)
	return nil
}

func (d *memScheduleDao) ListByProject(_ context.Context, _ string) (ScheduledSessionList, error) {
	return nil, nil
}

func (d *memScheduleDao) DueSchedules(_ context.Context, now time.Time, limit int) (ScheduledSessionList, error) {
	var list ScheduledSessionList
	for _, ss := range d.data {
		if ss.Enabled && ss.NextRunAt != nil && !ss.NextRunAt.After(now) {
			cp := *ss
			list = append(list, &cp)
		}
		if len(list) >= limit {
			break
		}
	}
	return list, nil
}

func (d *memScheduleDao) UpdateScheduleState(_ context.Context, ss *ScheduledSession) error {
	if existing, ok := d.data[ss.ID]; ok {
		existing.LastRunAt = ss.LastRunAt
		existing.NextRunAt = ss.NextRunAt
		existing.Enabled = ss.Enabled
	}
	return nil
}

func makeSchedule(id, name, schedule, tz string, enabled bool, nextRunAt *time.Time, createdByUserId *string) *ScheduledSession {
	return &ScheduledSession{
		Name:            name,
		Schedule:        schedule,
		Timezone:        tz,
		Enabled:         enabled,
		NextRunAt:       nextRunAt,
		ProjectId:       "proj-1",
		OverlapPolicy:   "skip",
		CreatedByUserId: createdByUserId,
	}
}

func setupScheduler(t *testing.T, clk *clock.FakeClock) (*Scheduler, *memScheduleDao, *sessions.InMemorySessionService) {
	t.Helper()
	dao := newMemScheduleDao()
	sessionSvc := sessions.NewInMemorySessionService()
	svc := &sqlScheduledSessionService{
		dao:        dao,
		clock:      clk,
		sessionSvc: sessionSvc,
	}
	lockFactory := &mockLockFactory{locked: true}
	scheduler := NewScheduler(svc, dao, lockFactory, clk, SchedulerConfig{
		PollInterval: 1 * time.Second,
		BatchLimit:   100,
	})
	return scheduler, dao, sessionSvc
}

func TestScheduler_PollsAndFires(t *testing.T) {
	now := time.Date(2026, 6, 24, 9, 0, 0, 0, time.UTC)
	clk := clock.NewFakeClock(now)
	scheduler, dao, sessionSvc := setupScheduler(t, clk)

	pastTime := now.Add(-1 * time.Minute)
	creator := "user-1"
	ss := makeSchedule("ss-1", "nightly", "0 9 * * *", "UTC", true, &pastTime, &creator)
	ss.ID = "ss-1"
	dao.data["ss-1"] = ss

	scheduler.Tick(context.Background())

	created, _ := sessionSvc.ByScheduledSessionID(context.Background(), "ss-1")
	if len(created) != 1 {
		t.Fatalf("expected 1 session created, got %d", len(created))
	}
	if created[0].SourceScheduledSessionId == nil || *created[0].SourceScheduledSessionId != "ss-1" {
		t.Fatal("session should have source_scheduled_session_id = ss-1")
	}
}

func TestScheduler_AdvancesNextRunAt(t *testing.T) {
	now := time.Date(2026, 6, 24, 9, 0, 0, 0, time.UTC)
	clk := clock.NewFakeClock(now)
	scheduler, dao, _ := setupScheduler(t, clk)

	pastTime := now.Add(-1 * time.Minute)
	creator := "user-1"
	ss := makeSchedule("ss-1", "hourly", "0 * * * *", "UTC", true, &pastTime, &creator)
	ss.ID = "ss-1"
	dao.data["ss-1"] = ss

	scheduler.Tick(context.Background())

	updated := dao.data["ss-1"]
	if updated.NextRunAt == nil {
		t.Fatal("next_run_at should not be nil after tick")
	}
	if !updated.NextRunAt.After(now) {
		t.Fatalf("next_run_at should be after now, got %v", updated.NextRunAt)
	}
	if updated.LastRunAt == nil || !updated.LastRunAt.Equal(now) {
		t.Fatalf("last_run_at should be set to now, got %v", updated.LastRunAt)
	}
}

func TestScheduler_SkipsWhenLockNotAcquired(t *testing.T) {
	now := time.Date(2026, 6, 24, 9, 0, 0, 0, time.UTC)
	clk := clock.NewFakeClock(now)
	dao := newMemScheduleDao()
	sessionSvc := sessions.NewInMemorySessionService()
	svc := &sqlScheduledSessionService{
		dao:        dao,
		clock:      clk,
		sessionSvc: sessionSvc,
	}
	lockFactory := &mockLockFactory{locked: false}
	scheduler := NewScheduler(svc, dao, lockFactory, clk, SchedulerConfig{
		PollInterval: 1 * time.Second,
		BatchLimit:   100,
	})

	pastTime := now.Add(-1 * time.Minute)
	creator := "user-1"
	ss := makeSchedule("ss-1", "nightly", "0 9 * * *", "UTC", true, &pastTime, &creator)
	ss.ID = "ss-1"
	dao.data["ss-1"] = ss

	scheduler.Tick(context.Background())

	created, _ := sessionSvc.ByScheduledSessionID(context.Background(), "ss-1")
	if len(created) != 0 {
		t.Fatal("should not create sessions when lock not acquired")
	}
}

func TestScheduler_OverlapSkip(t *testing.T) {
	now := time.Date(2026, 6, 24, 9, 0, 0, 0, time.UTC)
	clk := clock.NewFakeClock(now)
	scheduler, dao, sessionSvc := setupScheduler(t, clk)

	pastTime := now.Add(-1 * time.Minute)
	creator := "user-1"
	ss := makeSchedule("ss-1", "hourly", "0 * * * *", "UTC", true, &pastTime, &creator)
	ss.ID = "ss-1"
	ss.OverlapPolicy = "skip"
	dao.data["ss-1"] = ss

	// Create an active session from this schedule
	running := "Running"
	activeSession := &sessions.Session{
		Name:                     "existing",
		SourceScheduledSessionId: &ss.ID,
		Phase:                    &running,
	}
	activeSession.ProjectId = &ss.ProjectId
	_, _ = sessionSvc.Create(context.Background(), activeSession)

	scheduler.Tick(context.Background())

	created, _ := sessionSvc.ByScheduledSessionID(context.Background(), "ss-1")
	if len(created) != 1 {
		t.Fatalf("expected only the original session, got %d", len(created))
	}
}

func TestScheduler_OverlapAllow(t *testing.T) {
	now := time.Date(2026, 6, 24, 9, 0, 0, 0, time.UTC)
	clk := clock.NewFakeClock(now)
	scheduler, dao, sessionSvc := setupScheduler(t, clk)

	pastTime := now.Add(-1 * time.Minute)
	creator := "user-1"
	ss := makeSchedule("ss-1", "hourly", "0 * * * *", "UTC", true, &pastTime, &creator)
	ss.ID = "ss-1"
	ss.OverlapPolicy = "allow"
	dao.data["ss-1"] = ss

	// Create an active session from this schedule
	running := "Running"
	activeSession := &sessions.Session{
		Name:                     "existing",
		SourceScheduledSessionId: &ss.ID,
		Phase:                    &running,
	}
	activeSession.ProjectId = &ss.ProjectId
	_, _ = sessionSvc.Create(context.Background(), activeSession)

	scheduler.Tick(context.Background())

	created, _ := sessionSvc.ByScheduledSessionID(context.Background(), "ss-1")
	if len(created) != 2 {
		t.Fatalf("expected 2 sessions (overlap=allow), got %d", len(created))
	}
}

func TestScheduler_CatchUpOnce(t *testing.T) {
	now := time.Date(2026, 6, 24, 9, 0, 0, 0, time.UTC)
	clk := clock.NewFakeClock(now)
	scheduler, dao, sessionSvc := setupScheduler(t, clk)

	// Schedule was due 6 hours ago (hourly)
	sixHoursAgo := now.Add(-6 * time.Hour)
	creator := "user-1"
	ss := makeSchedule("ss-1", "hourly", "0 * * * *", "UTC", true, &sixHoursAgo, &creator)
	ss.ID = "ss-1"
	dao.data["ss-1"] = ss

	scheduler.Tick(context.Background())

	created, _ := sessionSvc.ByScheduledSessionID(context.Background(), "ss-1")
	if len(created) != 1 {
		t.Fatalf("expected exactly 1 catch-up session, got %d", len(created))
	}

	updated := dao.data["ss-1"]
	if updated.NextRunAt == nil || !updated.NextRunAt.After(now) {
		t.Fatalf("next_run_at should jump to future, got %v", updated.NextRunAt)
	}
}

func TestScheduler_NullCreatorDisablesSchedule(t *testing.T) {
	now := time.Date(2026, 6, 24, 9, 0, 0, 0, time.UTC)
	clk := clock.NewFakeClock(now)
	scheduler, dao, sessionSvc := setupScheduler(t, clk)

	pastTime := now.Add(-1 * time.Minute)
	ss := makeSchedule("ss-1", "nightly", "0 9 * * *", "UTC", true, &pastTime, nil)
	ss.ID = "ss-1"
	dao.data["ss-1"] = ss

	scheduler.Tick(context.Background())

	created, _ := sessionSvc.ByScheduledSessionID(context.Background(), "ss-1")
	if len(created) != 0 {
		t.Fatal("should not create sessions when creator is nil")
	}
	if dao.data["ss-1"].Enabled {
		t.Fatal("schedule should be disabled when creator is nil")
	}
}

func TestScheduler_GracefulShutdown(t *testing.T) {
	now := time.Date(2026, 6, 24, 9, 0, 0, 0, time.UTC)
	clk := clock.NewFakeClock(now)
	scheduler, _, _ := setupScheduler(t, clk)

	scheduler.Start(context.Background())

	done := make(chan struct{})
	go func() {
		scheduler.Stop()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("scheduler did not stop within 2 seconds")
	}
}

func TestScheduler_BatchLimit(t *testing.T) {
	now := time.Date(2026, 6, 24, 9, 0, 0, 0, time.UTC)
	clk := clock.NewFakeClock(now)
	dao := newMemScheduleDao()
	sessionSvc := sessions.NewInMemorySessionService()
	svc := &sqlScheduledSessionService{
		dao:        dao,
		clock:      clk,
		sessionSvc: sessionSvc,
	}
	lockFactory := &mockLockFactory{locked: true}
	scheduler := NewScheduler(svc, dao, lockFactory, clk, SchedulerConfig{
		PollInterval: 1 * time.Second,
		BatchLimit:   5,
	})

	pastTime := now.Add(-1 * time.Minute)
	creator := "user-1"
	for i := 0; i < 10; i++ {
		id := "ss-" + string(rune('a'+i))
		ss := makeSchedule(id, "sched-"+id, "0 * * * *", "UTC", true, &pastTime, &creator)
		ss.ID = id
		dao.data[id] = ss
	}

	scheduler.Tick(context.Background())

	totalCreated := 0
	for _, ss := range dao.data {
		created, _ := sessionSvc.ByScheduledSessionID(context.Background(), ss.ID)
		totalCreated += len(created)
	}
	if totalCreated > 5 {
		t.Fatalf("batch limit should cap at 5, got %d sessions created", totalCreated)
	}
}
