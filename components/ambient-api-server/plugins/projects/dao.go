package projects

import (
	"context"
	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/pkg/runtimeapi"

	"gorm.io/gorm/clause"

	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
)

type ProjectDao interface {
	Get(ctx context.Context, id string) (*Project, error)
	Create(ctx context.Context, project *Project) (*Project, error)
	Replace(ctx context.Context, project *Project) (*Project, error)
	Delete(ctx context.Context, id string) error
	FindByIDs(ctx context.Context, ids []string) (ProjectList, error)
	All(ctx context.Context) (ProjectList, error)
}

var _ ProjectDao = &sqlProjectDao{}

type sqlProjectDao struct {
	sessionFactory *db.SessionFactory
}

func NewProjectDao(sessionFactory *db.SessionFactory) ProjectDao {
	return &sqlProjectDao{sessionFactory: sessionFactory}
}

func (d *sqlProjectDao) Get(ctx context.Context, id string) (*Project, error) {
	g2 := (*d.sessionFactory).New(ctx)
	var project Project
	if err := g2.Take(&project, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &project, nil
}

func (d *sqlProjectDao) Create(ctx context.Context, project *Project) (*Project, error) {
	g2 := (*d.sessionFactory).New(ctx)
	if err := g2.Omit(clause.Associations).Create(project).Error; err != nil {
		db.MarkForRollback(ctx, err)
		return nil, err
	}
	return project, nil
}

func (d *sqlProjectDao) Replace(ctx context.Context, project *Project) (*Project, error) {
	g2 := (*d.sessionFactory).New(ctx)
	// User writes cannot replace runtime bindings or recreate a deleted row.
	omit := []string{clause.Associations, "id", "created_at", "deleted_at", "runtime_version"}
	for field := range runtimeFields {
		omit = append(omit, field)
	}
	result := g2.Model(project).Where("runtime_version = ?", project.RuntimeVersion).Select("*").Omit(omit...).Updates(project)
	if result.Error != nil {
		db.MarkForRollback(ctx, result.Error)
		return nil, result.Error
	}
	if result.RowsAffected == 0 {
		var current Project
		if err := g2.Take(&current, "id = ?", project.ID).Error; err != nil {
			return nil, err
		}
		return nil, runtimeapi.ErrConflict
	}
	return project, nil
}

func (d *sqlProjectDao) Delete(ctx context.Context, id string) error {
	g2 := (*d.sessionFactory).New(ctx)
	if err := g2.Omit(clause.Associations).Delete(&Project{Meta: api.Meta{ID: id}}).Error; err != nil {
		db.MarkForRollback(ctx, err)
		return err
	}
	return nil
}

func (d *sqlProjectDao) FindByIDs(ctx context.Context, ids []string) (ProjectList, error) {
	g2 := (*d.sessionFactory).New(ctx)
	projects := ProjectList{}
	if err := g2.Where("id in (?)", ids).Find(&projects).Error; err != nil {
		return nil, err
	}
	return projects, nil
}

func (d *sqlProjectDao) All(ctx context.Context) (ProjectList, error) {
	g2 := (*d.sessionFactory).New(ctx)
	projects := ProjectList{}
	if err := g2.Find(&projects).Error; err != nil {
		return nil, err
	}
	return projects, nil
}
