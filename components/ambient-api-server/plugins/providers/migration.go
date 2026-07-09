package providers

import (
	"gorm.io/gorm"

	"github.com/go-gormigrate/gormigrate/v2"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
)

func migration() *gormigrate.Migration {
	type Provider struct {
		db.Model
		ProjectId   string
		Name        string
		Type        *string
		Secret      *string
		Namespace   *string
		Labels      *string
		Annotations *string
	}

	return &gormigrate.Migration{
		ID: "202606300100",
		Migrate: func(tx *gorm.DB) error {
			if err := tx.AutoMigrate(&Provider{}); err != nil {
				return err
			}
			stmts := []string{
				`CREATE INDEX IF NOT EXISTS idx_providers_project_id ON providers(project_id)`,
			}
			for _, s := range stmts {
				if err := tx.Exec(s).Error; err != nil {
					return err
				}
			}
			return nil
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Migrator().DropTable(&Provider{})
		},
	}
}
