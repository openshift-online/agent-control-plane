package sessions

import (
	"context"
	"fmt"
	"time"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
	"gorm.io/gorm/clause"
)

type EventDao interface {
	Insert(ctx context.Context, evt *SessionEvent) error
	ListBySessionID(ctx context.Context, sessionID string, opts EventListOptions) ([]SessionEvent, int64, error)
}

type EventListOptions struct {
	AfterSeq  int64
	EventType string
	Limit     int
	StartTime *time.Time
	EndTime   *time.Time
}

var _ EventDao = &sqlEventDao{}

type sqlEventDao struct {
	sessionFactory *db.SessionFactory
}

func NewEventDao(sessionFactory *db.SessionFactory) EventDao {
	return &sqlEventDao{sessionFactory: sessionFactory}
}

func (d *sqlEventDao) Insert(ctx context.Context, evt *SessionEvent) error {
	g2 := (*d.sessionFactory).New(ctx)
	evt.ID = api.NewID()
	evt.CreatedAt = time.Now().UTC()
	if evt.EventCount == 0 {
		evt.EventCount = 1
	}
	result := g2.Clauses(clause.Returning{Columns: []clause.Column{{Name: "seq"}}}).Create(evt)
	if result.Error != nil {
		return fmt.Errorf("insert session event: %w", result.Error)
	}
	return nil
}

func (d *sqlEventDao) ListBySessionID(ctx context.Context, sessionID string, opts EventListOptions) ([]SessionEvent, int64, error) {
	g2 := (*d.sessionFactory).New(ctx)
	q := g2.Where("session_id = ?", sessionID)

	if opts.AfterSeq > 0 {
		q = q.Where("seq > ?", opts.AfterSeq)
	}
	if opts.EventType != "" {
		q = q.Where("event_type = ?", opts.EventType)
	}
	if opts.StartTime != nil {
		q = q.Where("created_at >= ?", *opts.StartTime)
	}
	if opts.EndTime != nil {
		q = q.Where("created_at <= ?", *opts.EndTime)
	}

	var total int64
	if err := q.Model(&SessionEvent{}).Count(&total).Error; err != nil {
		return nil, 0, fmt.Errorf("count session events: %w", err)
	}

	limit := opts.Limit
	if limit <= 0 || limit > 1000 {
		limit = 100
	}

	var events []SessionEvent
	if err := q.Order("seq ASC").Limit(limit).Find(&events).Error; err != nil {
		return nil, 0, fmt.Errorf("list session events: %w", err)
	}
	return events, total, nil
}
