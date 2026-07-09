package scheduledSessions

import (
	"context"
	"time"

	"github.com/openshift-online/rh-trex-ai/pkg/db"
	"gorm.io/gorm"
)

type ScheduledSessionDao interface {
	Get(ctx context.Context, id string) (*ScheduledSession, error)
	Create(ctx context.Context, ss *ScheduledSession) (*ScheduledSession, error)
	Replace(ctx context.Context, ss *ScheduledSession) (*ScheduledSession, error)
	Delete(ctx context.Context, id string) error
	ListByProject(ctx context.Context, projectId string) (ScheduledSessionList, error)
	DueSchedules(ctx context.Context, now time.Time, limit int) (ScheduledSessionList, error)
	UpdateScheduleState(ctx context.Context, ss *ScheduledSession) error
}

type sqlScheduledSessionDao struct {
	sessionFactory *db.SessionFactory
}

func NewScheduledSessionDao(sessionFactory *db.SessionFactory) ScheduledSessionDao {
	return &sqlScheduledSessionDao{sessionFactory: sessionFactory}
}

func (d *sqlScheduledSessionDao) db(ctx context.Context) *gorm.DB {
	return (*d.sessionFactory).New(ctx)
}

func (d *sqlScheduledSessionDao) Get(ctx context.Context, id string) (*ScheduledSession, error) {
	ss := &ScheduledSession{}
	err := d.db(ctx).Where("id = ?", id).First(ss).Error
	if err != nil {
		return nil, err
	}
	return ss, nil
}

func (d *sqlScheduledSessionDao) Create(ctx context.Context, ss *ScheduledSession) (*ScheduledSession, error) {
	err := d.db(ctx).Create(ss).Error
	if err != nil {
		return nil, err
	}
	return ss, nil
}

func (d *sqlScheduledSessionDao) Replace(ctx context.Context, ss *ScheduledSession) (*ScheduledSession, error) {
	err := d.db(ctx).Save(ss).Error
	if err != nil {
		return nil, err
	}
	return ss, nil
}

func (d *sqlScheduledSessionDao) Delete(ctx context.Context, id string) error {
	return d.db(ctx).Delete(&ScheduledSession{}, "id = ?", id).Error
}

func (d *sqlScheduledSessionDao) ListByProject(ctx context.Context, projectId string) (ScheduledSessionList, error) {
	var list ScheduledSessionList
	err := d.db(ctx).Where("project_id = ? AND deleted_at IS NULL", projectId).Find(&list).Error
	return list, err
}

func (d *sqlScheduledSessionDao) DueSchedules(ctx context.Context, now time.Time, limit int) (ScheduledSessionList, error) {
	var list ScheduledSessionList
	err := d.db(ctx).
		Where("enabled = true AND next_run_at <= ? AND deleted_at IS NULL", now).
		Order("next_run_at").
		Limit(limit).
		Find(&list).Error
	return list, err
}

func (d *sqlScheduledSessionDao) UpdateScheduleState(ctx context.Context, ss *ScheduledSession) error {
	return d.db(ctx).Model(ss).Select("last_run_at", "next_run_at", "enabled").Updates(ss).Error
}
