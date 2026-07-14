package gateways

import (
	"gorm.io/gorm"

	"github.com/go-gormigrate/gormigrate/v2"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
)

func migration() *gormigrate.Migration {
	type Gateway struct {
		db.Model
		Name           string `gorm:"not null"`
		ProjectId      string `gorm:"not null;index"`
		Image          *string
		ServerDnsNames *string `gorm:"type:jsonb"`
		Config         *string
		Labels         *string `gorm:"type:jsonb"`
		Annotations    *string `gorm:"type:jsonb"`
	}

	return &gormigrate.Migration{
		ID: "202607080001",
		Migrate: func(tx *gorm.DB) error {
			if err := tx.AutoMigrate(&Gateway{}); err != nil {
				return err
			}
			return tx.Exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_gateways_project_name ON gateways (project_id, name) WHERE deleted_at IS NULL").Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Migrator().DropTable(&Gateway{})
		},
	}
}

func migrationAddOidc() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202607140001",
		Migrate: func(tx *gorm.DB) error {
			return tx.Exec(`ALTER TABLE gateways ADD COLUMN IF NOT EXISTS oidc JSONB`).Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Exec(`ALTER TABLE gateways DROP COLUMN IF EXISTS oidc`).Error
		},
	}
}
