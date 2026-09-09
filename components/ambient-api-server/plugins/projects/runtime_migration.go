package projects

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
	"gorm.io/gorm"
)

func init() { db.RegisterMigration(runtimeMigration()) }

func runtimeMigration() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202609090001",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS runtime_backend TEXT, ADD COLUMN IF NOT EXISTS gateway_id TEXT, ADD COLUMN IF NOT EXISTS gateway_instance_id TEXT, ADD COLUMN IF NOT EXISTS gateway_endpoint TEXT, ADD COLUMN IF NOT EXISTS gateway_status TEXT, ADD COLUMN IF NOT EXISTS gateway_error TEXT, ADD COLUMN IF NOT EXISTS gateway_credential_id TEXT, ADD COLUMN IF NOT EXISTS gateway_account_id TEXT, ADD COLUMN IF NOT EXISTS gateway_account_expires_at TEXT, ADD COLUMN IF NOT EXISTS gateway_external_reference TEXT, ADD COLUMN IF NOT EXISTS runtime_version BIGINT NOT NULL DEFAULT 0`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`ALTER TABLE projects DROP COLUMN IF EXISTS runtime_backend, DROP COLUMN IF EXISTS gateway_id, DROP COLUMN IF EXISTS gateway_instance_id, DROP COLUMN IF EXISTS gateway_endpoint, DROP COLUMN IF EXISTS gateway_status, DROP COLUMN IF EXISTS gateway_error, DROP COLUMN IF EXISTS gateway_credential_id, DROP COLUMN IF EXISTS gateway_account_id, DROP COLUMN IF EXISTS gateway_account_expires_at, DROP COLUMN IF EXISTS gateway_external_reference, DROP COLUMN IF EXISTS runtime_version`).Error
		},
	}
}
