package scheduledSessions

import (
	"time"

	"github.com/go-gormigrate/gormigrate/v2"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
	"gorm.io/gorm"
)

func migration() *gormigrate.Migration {
	type ScheduledSession struct {
		db.Model
		Name          string
		Description   *string
		ProjectId     string
		AgentId       string
		Schedule      string
		Timezone      string
		Enabled       bool
		SessionPrompt *string
		LastRunAt     *time.Time
		NextRunAt     *time.Time
	}

	return &gormigrate.Migration{
		ID: "202604280001",
		Migrate: func(tx *gorm.DB) error {
			return tx.AutoMigrate(&ScheduledSession{})
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Migrator().DropTable("scheduled_sessions")
		},
	}
}

func executionFieldsMigration() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202605050001",
		Migrate: func(tx *gorm.DB) error {
			stmts := []string{
				`ALTER TABLE scheduled_sessions ALTER COLUMN agent_id DROP NOT NULL`,
				`ALTER TABLE scheduled_sessions ADD COLUMN IF NOT EXISTS timeout integer`,
				`ALTER TABLE scheduled_sessions ADD COLUMN IF NOT EXISTS inactivity_timeout integer`,
				`ALTER TABLE scheduled_sessions ADD COLUMN IF NOT EXISTS stop_on_run_finished boolean`,
				`ALTER TABLE scheduled_sessions ADD COLUMN IF NOT EXISTS runner_type text`,
			}
			for _, s := range stmts {
				if err := tx.Exec(s).Error; err != nil {
					return err
				}
			}
			return nil
		},
		Rollback: func(tx *gorm.DB) error {
			return nil
		},
	}
}

func schedulerFieldsMigration() *gormigrate.Migration {
	type ScheduledSession struct {
		CreatedByUserId *string `gorm:"column:created_by_user_id"`
		OverlapPolicy   string  `gorm:"column:overlap_policy;default:skip;not null"`
	}
	return &gormigrate.Migration{
		ID: "202606230001",
		Migrate: func(tx *gorm.DB) error {
			if err := tx.Table("scheduled_sessions").AutoMigrate(&ScheduledSession{}); err != nil {
				return err
			}
			return tx.Exec(`CREATE INDEX IF NOT EXISTS idx_ss_due ON scheduled_sessions(next_run_at) WHERE enabled = true AND deleted_at IS NULL`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			tx.Exec(`DROP INDEX IF EXISTS idx_ss_due`)
			return nil
		},
	}
}

func indexMigration() *gormigrate.Migration {
	stmts := []string{
		`CREATE INDEX IF NOT EXISTS idx_scheduled_sessions_project ON scheduled_sessions(project_id)`,
		`CREATE INDEX IF NOT EXISTS idx_scheduled_sessions_agent ON scheduled_sessions(agent_id)`,
	}
	return &gormigrate.Migration{
		ID: "202604280002",
		Migrate: func(tx *gorm.DB) error {
			for _, s := range stmts {
				if err := tx.Exec(s).Error; err != nil {
					return err
				}
			}
			return nil
		},
		Rollback: func(tx *gorm.DB) error {
			tx.Exec(`DROP INDEX IF EXISTS idx_scheduled_sessions_project`)
			tx.Exec(`DROP INDEX IF EXISTS idx_scheduled_sessions_agent`)
			return nil
		},
	}
}
