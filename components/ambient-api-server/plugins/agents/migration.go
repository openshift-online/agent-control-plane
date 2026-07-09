package agents

import (
	"fmt"

	"gorm.io/gorm"

	"github.com/go-gormigrate/gormigrate/v2"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
)

func migration() *gormigrate.Migration {
	type Agent struct {
		db.Model
		ProjectId        string
		Name             string
		Prompt           *string `gorm:"type:text"`
		CurrentSessionId *string
		Labels           *string
		Annotations      *string
	}

	return &gormigrate.Migration{
		ID: "202603211930",
		Migrate: func(tx *gorm.DB) error {
			if err := tx.AutoMigrate(&Agent{}); err != nil {
				return err
			}
			stmts := []string{
				`CREATE INDEX IF NOT EXISTS idx_agents_project_id ON agents(project_id)`,
				`CREATE INDEX IF NOT EXISTS idx_agents_current_session_id ON agents(current_session_id)`,
			}
			for _, s := range stmts {
				if err := tx.Exec(s).Error; err != nil {
					return err
				}
			}
			return nil
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Migrator().DropTable(&Agent{})
		},
	}
}

func agentSchemaExpansionMigration() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202604181000",
		Migrate: func(tx *gorm.DB) error {
			stmts := []string{
				`ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_user_id TEXT NOT NULL DEFAULT ''`,
				`ALTER TABLE agents ADD COLUMN IF NOT EXISTS display_name TEXT`,
				`ALTER TABLE agents ADD COLUMN IF NOT EXISTS description TEXT`,
				`ALTER TABLE agents ADD COLUMN IF NOT EXISTS repo_url TEXT`,
				`ALTER TABLE agents ADD COLUMN IF NOT EXISTS workflow_id TEXT`,
				`ALTER TABLE agents ADD COLUMN IF NOT EXISTS llm_model TEXT DEFAULT 'claude-sonnet-4-6'`,
				`ALTER TABLE agents ADD COLUMN IF NOT EXISTS llm_temperature DOUBLE PRECISION DEFAULT 0.7`,
				`ALTER TABLE agents ADD COLUMN IF NOT EXISTS llm_max_tokens INTEGER DEFAULT 4000`,
				`ALTER TABLE agents ADD COLUMN IF NOT EXISTS bot_account_name TEXT`,
				`ALTER TABLE agents ADD COLUMN IF NOT EXISTS resource_overrides TEXT`,
				`ALTER TABLE agents ADD COLUMN IF NOT EXISTS environment_variables TEXT`,
			}
			for _, s := range stmts {
				if err := tx.Exec(s).Error; err != nil {
					return err
				}
			}
			return nil
		},
		Rollback: func(tx *gorm.DB) error {
			cols := []string{
				"owner_user_id", "display_name", "description",
				"repo_url", "workflow_id", "llm_model", "llm_temperature", "llm_max_tokens",
				"bot_account_name", "resource_overrides", "environment_variables",
			}
			for _, col := range cols {
				if err := tx.Exec(fmt.Sprintf("ALTER TABLE agents DROP COLUMN IF EXISTS %s", col)).Error; err != nil {
					return err
				}
			}
			return nil
		},
	}
}

func dropParentAgentIdMigration() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202606171000",
		Migrate: func(tx *gorm.DB) error {
			stmts := []string{
				`DROP INDEX IF EXISTS idx_agents_parent_agent_id`,
				`ALTER TABLE agents DROP COLUMN IF EXISTS parent_agent_id`,
			}
			for _, s := range stmts {
				if err := tx.Exec(s).Error; err != nil {
					return err
				}
			}
			return nil
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS parent_agent_id TEXT`).Error
		},
	}
}

func sandboxConfigMigration() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202606291000",
		Migrate: func(tx *gorm.DB) error {
			stmts := []string{
				`ALTER TABLE agents ADD COLUMN IF NOT EXISTS entrypoint TEXT`,
				`ALTER TABLE agents ADD COLUMN IF NOT EXISTS providers JSONB`,
				`ALTER TABLE agents ADD COLUMN IF NOT EXISTS payloads JSONB`,
				`ALTER TABLE agents ADD COLUMN IF NOT EXISTS environment JSONB`,
				`ALTER TABLE agents ADD COLUMN IF NOT EXISTS sandbox_template JSONB`,
				`ALTER TABLE agents ADD COLUMN IF NOT EXISTS sandbox_policy TEXT`,
			}
			for _, s := range stmts {
				if err := tx.Exec(s).Error; err != nil {
					return err
				}
			}
			return nil
		},
		Rollback: func(tx *gorm.DB) error {
			cols := []string{
				"entrypoint", "providers", "payloads",
				"environment", "sandbox_template", "sandbox_policy",
			}
			for _, col := range cols {
				if err := tx.Exec(fmt.Sprintf("ALTER TABLE agents DROP COLUMN IF EXISTS %s", col)).Error; err != nil {
					return err
				}
			}
			return nil
		},
	}
}
