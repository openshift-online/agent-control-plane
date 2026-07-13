package sessions

import (
	"context"

	"gorm.io/gorm/clause"

	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
)

type SessionDao interface {
	Get(ctx context.Context, id string) (*Session, error)
	Create(ctx context.Context, session *Session) (*Session, error)
	Replace(ctx context.Context, session *Session) (*Session, error)
	Delete(ctx context.Context, id string) error
	FindByIDs(ctx context.Context, ids []string) (SessionList, error)
	All(ctx context.Context) (SessionList, error)
	AllByProjectId(ctx context.Context, projectId string) (SessionList, error)
	ActiveByAgentID(ctx context.Context, agentID string) (*Session, error)
	ByScheduledSessionID(ctx context.Context, scheduledSessionID string) (SessionList, error)
	ActiveByScheduledSessionID(ctx context.Context, scheduledSessionID string) (*Session, error)
	PhaseCounts(ctx context.Context, projectId string) (map[string]int64, error)
}

var _ SessionDao = &sqlSessionDao{}

type sqlSessionDao struct {
	sessionFactory *db.SessionFactory
}

func NewSessionDao(sessionFactory *db.SessionFactory) SessionDao {
	return &sqlSessionDao{sessionFactory: sessionFactory}
}

func (d *sqlSessionDao) Get(ctx context.Context, id string) (*Session, error) {
	g2 := (*d.sessionFactory).New(ctx)
	var session Session
	if err := g2.Take(&session, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &session, nil
}

func (d *sqlSessionDao) Create(ctx context.Context, session *Session) (*Session, error) {
	g2 := (*d.sessionFactory).New(ctx)
	if err := g2.Omit(clause.Associations).Create(session).Error; err != nil {
		db.MarkForRollback(ctx, err)
		return nil, err
	}
	return session, nil
}

func (d *sqlSessionDao) Replace(ctx context.Context, session *Session) (*Session, error) {
	g2 := (*d.sessionFactory).New(ctx)
	if err := g2.Omit(clause.Associations).Save(session).Error; err != nil {
		db.MarkForRollback(ctx, err)
		return nil, err
	}
	return session, nil
}

func (d *sqlSessionDao) Delete(ctx context.Context, id string) error {
	g2 := (*d.sessionFactory).New(ctx)
	if err := g2.Omit(clause.Associations).Delete(&Session{Meta: api.Meta{ID: id}}).Error; err != nil {
		db.MarkForRollback(ctx, err)
		return err
	}
	return nil
}

func (d *sqlSessionDao) FindByIDs(ctx context.Context, ids []string) (SessionList, error) {
	g2 := (*d.sessionFactory).New(ctx)
	sessions := SessionList{}
	if err := g2.Where("id in (?)", ids).Find(&sessions).Error; err != nil {
		return nil, err
	}
	return sessions, nil
}

func (d *sqlSessionDao) All(ctx context.Context) (SessionList, error) {
	g2 := (*d.sessionFactory).New(ctx)
	sessions := SessionList{}
	if err := g2.Find(&sessions).Error; err != nil {
		return nil, err
	}
	return sessions, nil
}

func (d *sqlSessionDao) AllByProjectId(ctx context.Context, projectId string) (SessionList, error) {
	g2 := (*d.sessionFactory).New(ctx)
	sessions := SessionList{}
	if err := g2.Where("project_id = ?", projectId).Find(&sessions).Error; err != nil {
		return nil, err
	}
	return sessions, nil
}

func (d *sqlSessionDao) ActiveByAgentID(ctx context.Context, agentID string) (*Session, error) {
	g2 := (*d.sessionFactory).New(ctx)
	var session Session
	err := g2.Where("agent_id = ? AND phase IN (?)", agentID, []string{"Pending", "Creating", "Running"}).
		Order("created_at DESC").
		Take(&session).Error
	if err != nil {
		return nil, err
	}
	return &session, nil
}

func (d *sqlSessionDao) ByScheduledSessionID(ctx context.Context, scheduledSessionID string) (SessionList, error) {
	g2 := (*d.sessionFactory).New(ctx)
	var list SessionList
	err := g2.Unscoped().Where("source_scheduled_session_id = ?", scheduledSessionID).
		Order("created_at DESC").
		Find(&list).Error
	return list, err
}

func (d *sqlSessionDao) ActiveByScheduledSessionID(ctx context.Context, scheduledSessionID string) (*Session, error) {
	g2 := (*d.sessionFactory).New(ctx)
	var session Session
	err := g2.Where("source_scheduled_session_id = ? AND phase NOT IN (?)", scheduledSessionID, []string{"Completed", "Failed", "Stopped"}).
		Order("created_at DESC").
		Take(&session).Error
	if err != nil {
		return nil, err
	}
	return &session, nil
}

func (d *sqlSessionDao) PhaseCounts(ctx context.Context, projectId string) (map[string]int64, error) {
	g2 := (*d.sessionFactory).New(ctx)

	type phaseRow struct {
		Phase string
		Count int64
	}
	var rows []phaseRow

	query := g2.Model(&Session{}).Select("phase, count(*) as count")
	if projectId != "" {
		query = query.Where("project_id = ?", projectId)
	}
	if err := query.Group("phase").Scan(&rows).Error; err != nil {
		return nil, err
	}

	counts := make(map[string]int64, len(rows))
	for _, r := range rows {
		if r.Phase != "" {
			counts[r.Phase] = r.Count
		}
	}
	return counts, nil
}
