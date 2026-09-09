package sessions

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
	"gorm.io/gorm"
)

func init() { db.RegisterMigration(runtimeMigration()) }

func runtimeMigration() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202609090002",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS gateway_id TEXT, ADD COLUMN IF NOT EXISTS gateway_workspace TEXT, ADD COLUMN IF NOT EXISTS sandbox_id TEXT, ADD COLUMN IF NOT EXISTS sandbox_name TEXT, ADD COLUMN IF NOT EXISTS runtime_backend TEXT, ADD COLUMN IF NOT EXISTS runner_generation TEXT, ADD COLUMN IF NOT EXISTS gateway_endpoint TEXT, ADD COLUMN IF NOT EXISTS gateway_credential_id TEXT, ADD COLUMN IF NOT EXISTS runtime_status TEXT, ADD COLUMN IF NOT EXISTS runtime_error TEXT, ADD COLUMN IF NOT EXISTS runtime_version BIGINT NOT NULL DEFAULT 0`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`ALTER TABLE sessions DROP COLUMN IF EXISTS gateway_id, DROP COLUMN IF EXISTS gateway_workspace, DROP COLUMN IF EXISTS sandbox_id, DROP COLUMN IF EXISTS sandbox_name, DROP COLUMN IF EXISTS runtime_backend, DROP COLUMN IF EXISTS runner_generation, DROP COLUMN IF EXISTS gateway_endpoint, DROP COLUMN IF EXISTS gateway_credential_id, DROP COLUMN IF EXISTS runtime_status, DROP COLUMN IF EXISTS runtime_error, DROP COLUMN IF EXISTS runtime_version`).Error
		},
	}
}
