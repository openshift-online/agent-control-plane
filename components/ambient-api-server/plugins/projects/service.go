package projects

import (
	"context"
	"fmt"
	"regexp"
	"time"

	"github.com/golang/glog"
	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/auth"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
	"github.com/openshift-online/rh-trex-ai/pkg/errors"
	"github.com/openshift-online/rh-trex-ai/pkg/logger"
	"github.com/openshift-online/rh-trex-ai/pkg/services"
	"gorm.io/gorm"
)

// roleBindingRow is a local struct for creating role_bindings rows via GORM,
// avoiding circular imports with the roleBindings plugin package.
type roleBindingRow struct {
	ID        string  `gorm:"primaryKey"`
	RoleId    string  `gorm:"column:role_id;not null"`
	Scope     string  `gorm:"not null"`
	UserId    *string `gorm:"column:user_id"`
	ProjectId *string `gorm:"column:project_id"`
	CreatedAt time.Time
	UpdatedAt time.Time
}

func (roleBindingRow) TableName() string { return "role_bindings" }

const projectsLockType db.LockType = "projects"

var (
	DisableAdvisoryLock     = false
	UseBlockingAdvisoryLock = true
	projectNameRegex        = regexp.MustCompile(`^[a-z][a-z0-9-]*[a-z0-9]$`)
)

const projectNameMaxLength = 63

func ValidateProjectName(name string) *errors.ServiceError {
	if len(name) < 2 || len(name) > projectNameMaxLength {
		return errors.Validation("project name must be between 2 and %d characters", projectNameMaxLength)
	}
	if !projectNameRegex.MatchString(name) {
		return errors.Validation("project name must match DNS-1123 label format: lowercase alphanumeric and hyphens, must start with a letter and end with an alphanumeric character")
	}
	return nil
}

type ProjectService interface {
	Get(ctx context.Context, id string) (*Project, *errors.ServiceError)
	Create(ctx context.Context, project *Project) (*Project, *errors.ServiceError)
	Replace(ctx context.Context, project *Project) (*Project, *errors.ServiceError)
	Delete(ctx context.Context, id string) *errors.ServiceError
	All(ctx context.Context) (ProjectList, *errors.ServiceError)

	FindByIDs(ctx context.Context, ids []string) (ProjectList, *errors.ServiceError)

	TransferOwnership(ctx context.Context, projectID, callerUsername, targetUserID string, callerIsAdmin bool) *errors.ServiceError

	OnUpsert(ctx context.Context, id string) error
	OnDelete(ctx context.Context, id string) error
}

func NewProjectService(lockFactory db.LockFactory, projectDao ProjectDao, events services.EventService, sessionFactory *db.SessionFactory) ProjectService {
	return &sqlProjectService{
		lockFactory:    lockFactory,
		projectDao:     projectDao,
		events:         events,
		sessionFactory: sessionFactory,
	}
}

var _ ProjectService = &sqlProjectService{}

type sqlProjectService struct {
	lockFactory    db.LockFactory
	projectDao     ProjectDao
	events         services.EventService
	sessionFactory *db.SessionFactory
}

func (s *sqlProjectService) OnUpsert(ctx context.Context, id string) error {
	logger := logger.NewLogger(ctx)

	project, err := s.projectDao.Get(ctx, id)
	if err != nil {
		return err
	}

	logger.Infof("Do idempotent somethings with this project: %s", project.ID)

	return nil
}

func (s *sqlProjectService) OnDelete(ctx context.Context, id string) error {
	logger := logger.NewLogger(ctx)
	logger.Infof("This project has been deleted: %s", id)
	return nil
}

func (s *sqlProjectService) Get(ctx context.Context, id string) (*Project, *errors.ServiceError) {
	project, err := s.projectDao.Get(ctx, id)
	if err != nil {
		return nil, services.HandleGetError("Project", "id", id, err)
	}
	return project, nil
}

func (s *sqlProjectService) Create(ctx context.Context, project *Project) (*Project, *errors.ServiceError) {
	if svcErr := ValidateProjectName(project.Name); svcErr != nil {
		return nil, svcErr
	}

	project, err := s.projectDao.Create(ctx, project)
	if err != nil {
		return nil, services.HandleCreateError("Project", err)
	}

	s.createOwnerBinding(ctx, project.ID)

	_, evErr := s.events.Create(ctx, &api.Event{
		Source:    "Projects",
		SourceID:  project.ID,
		EventType: api.CreateEventType,
	})
	if evErr != nil {
		return nil, services.HandleCreateError("Project", evErr)
	}

	return project, nil
}

func (s *sqlProjectService) createOwnerBinding(ctx context.Context, projectID string) {
	username := auth.GetUsernameFromContext(ctx)
	if username == "" {
		return
	}
	g := (*s.sessionFactory).New(ctx)

	var roleID string
	if err := g.Table("roles").Select("id").
		Where("name = ? AND deleted_at IS NULL", "project:owner").
		Limit(1).Scan(&roleID).Error; err != nil || roleID == "" {
		glog.Warningf("failed to find project:owner role for project %s: %v", projectID, err)
		return
	}

	now := time.Now()
	row := roleBindingRow{
		ID:        api.NewID(),
		RoleId:    roleID,
		Scope:     "project",
		UserId:    &username,
		ProjectId: &projectID,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := g.Create(&row).Error; err != nil {
		glog.Warningf("failed to create owner binding for project %s: %v", projectID, err)
	}
}

func (s *sqlProjectService) Replace(ctx context.Context, project *Project) (*Project, *errors.ServiceError) {
	if svcErr := ValidateProjectName(project.Name); svcErr != nil {
		return nil, svcErr
	}

	if !DisableAdvisoryLock {
		if UseBlockingAdvisoryLock {
			lockOwnerID, err := s.lockFactory.NewAdvisoryLock(ctx, project.ID, projectsLockType)
			if err != nil {
				return nil, errors.DatabaseAdvisoryLock(err)
			}
			defer s.lockFactory.Unlock(ctx, lockOwnerID)
		} else {
			lockOwnerID, locked, err := s.lockFactory.NewNonBlockingLock(ctx, project.ID, projectsLockType)
			if err != nil {
				return nil, errors.DatabaseAdvisoryLock(err)
			}
			if !locked {
				return nil, services.HandleCreateError("Project", errors.New(errors.ErrorConflict, "row locked"))
			}
			defer s.lockFactory.Unlock(ctx, lockOwnerID)
		}
	}

	project, err := s.projectDao.Replace(ctx, project)
	if err != nil {
		return nil, services.HandleUpdateError("Project", err)
	}

	_, evErr := s.events.Create(ctx, &api.Event{
		Source:    "Projects",
		SourceID:  project.ID,
		EventType: api.UpdateEventType,
	})
	if evErr != nil {
		return nil, services.HandleUpdateError("Project", evErr)
	}

	return project, nil
}

func (s *sqlProjectService) TransferOwnership(ctx context.Context, projectID, callerUsername, targetUserID string, callerIsAdmin bool) *errors.ServiceError {
	// Acquire advisory lock on the project to prevent concurrent transfers.
	lockOwnerID, lockErr := s.lockFactory.NewAdvisoryLock(ctx, projectID, projectsLockType)
	if lockErr != nil {
		return errors.DatabaseAdvisoryLock(lockErr)
	}
	defer s.lockFactory.Unlock(ctx, lockOwnerID)

	g := (*s.sessionFactory).New(ctx)

	// Look up the project:owner role ID.
	var ownerRoleID string
	if dbErr := g.Table("roles").Select("id").
		Where("name = 'project:owner' AND deleted_at IS NULL").
		Scan(&ownerRoleID).Error; dbErr != nil || ownerRoleID == "" {
		return errors.GeneralError("failed to find project:owner role")
	}

	// Look up the project:editor role ID (for downgrade).
	var editorRoleID string
	if dbErr := g.Table("roles").Select("id").
		Where("name = 'project:editor' AND deleted_at IS NULL").
		Scan(&editorRoleID).Error; dbErr != nil || editorRoleID == "" {
		return errors.GeneralError("failed to find project:editor role")
	}

	// Verify target user exists.
	var targetUserCount int64
	if dbErr := g.Table("users").
		Where("id = ? AND deleted_at IS NULL", targetUserID).
		Count(&targetUserCount).Error; dbErr != nil {
		return errors.GeneralError("failed to verify target user")
	}
	if targetUserCount == 0 {
		return errors.NotFound("target user not found")
	}

	// Check if target is already project:owner on this project.
	var existingOwnerCount int64
	if dbErr := g.Table("role_bindings").
		Where("user_id = ? AND role_id = ? AND project_id = ? AND deleted_at IS NULL",
			targetUserID, ownerRoleID, projectID).
		Count(&existingOwnerCount).Error; dbErr != nil {
		return errors.GeneralError("failed to check existing ownership")
	}
	if existingOwnerCount > 0 {
		return errors.Conflict("target user is already project owner")
	}

	// Execute the transfer in a single transaction.
	// Order: create new owner binding first, then downgrade old owner.
	// This ensures the project always has at least one owner.
	txErr := g.Transaction(func(tx *gorm.DB) error {
		// 1. Create project:owner binding for target user.
		now := time.Now()
		newBinding := roleBindingRow{
			ID:        api.NewID(),
			RoleId:    ownerRoleID,
			Scope:     "project",
			UserId:    &targetUserID,
			ProjectId: &projectID,
			CreatedAt: now,
			UpdatedAt: now,
		}
		if err := tx.Create(&newBinding).Error; err != nil {
			return fmt.Errorf("failed to create owner binding for target: %w", err)
		}

		// 2. If caller is the current owner (not admin acting externally),
		//    downgrade their binding to project:editor.
		if !callerIsAdmin {
			result := tx.Table("role_bindings").
				Where("user_id = ? AND role_id = ? AND project_id = ? AND deleted_at IS NULL",
					callerUsername, ownerRoleID, projectID).
				Updates(map[string]interface{}{
					"role_id":    editorRoleID,
					"updated_at": now,
				})
			if result.Error != nil {
				return fmt.Errorf("failed to downgrade caller binding: %w", result.Error)
			}
		} else {
			// Admin transfer: find the current owner and downgrade them.
			result := tx.Table("role_bindings").
				Where("role_id = ? AND project_id = ? AND user_id != ? AND deleted_at IS NULL",
					ownerRoleID, projectID, targetUserID).
				Updates(map[string]interface{}{
					"role_id":    editorRoleID,
					"updated_at": now,
				})
			if result.Error != nil {
				return fmt.Errorf("failed to downgrade previous owner binding: %w", result.Error)
			}
		}

		return nil
	})

	if txErr != nil {
		return errors.GeneralError("ownership transfer failed: %v", txErr)
	}

	return nil
}

func (s *sqlProjectService) Delete(ctx context.Context, id string) *errors.ServiceError {
	if err := s.projectDao.Delete(ctx, id); err != nil {
		return services.HandleDeleteError("Project", errors.GeneralError("Unable to delete project: %s", err))
	}

	_, evErr := s.events.Create(ctx, &api.Event{
		Source:    "Projects",
		SourceID:  id,
		EventType: api.DeleteEventType,
	})
	if evErr != nil {
		return services.HandleDeleteError("Project", evErr)
	}

	return nil
}

func (s *sqlProjectService) FindByIDs(ctx context.Context, ids []string) (ProjectList, *errors.ServiceError) {
	projects, err := s.projectDao.FindByIDs(ctx, ids)
	if err != nil {
		return nil, errors.GeneralError("Unable to get all projects: %s", err)
	}
	return projects, nil
}

func (s *sqlProjectService) All(ctx context.Context) (ProjectList, *errors.ServiceError) {
	projects, err := s.projectDao.All(ctx)
	if err != nil {
		return nil, errors.GeneralError("Unable to get all projects: %s", err)
	}
	return projects, nil
}
