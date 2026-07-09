package policies

import (
	"gorm.io/gorm"

	"github.com/go-gormigrate/gormigrate/v2"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
)

func migration() *gormigrate.Migration {
	type Policy struct {
		db.Model
		ProjectId   string
		Name        string
		Namespace   *string
		Spec        *string `gorm:"type:jsonb"`
		Labels      *string
		Annotations *string
	}

	return &gormigrate.Migration{
		ID: "202606300200",
		Migrate: func(tx *gorm.DB) error {
			if err := tx.AutoMigrate(&Policy{}); err != nil {
				return err
			}
			stmts := []string{
				`CREATE INDEX IF NOT EXISTS idx_policies_project_id ON policies(project_id)`,
			}
			for _, s := range stmts {
				if err := tx.Exec(s).Error; err != nil {
					return err
				}
			}
			return nil
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Migrator().DropTable(&Policy{})
		},
	}
}
