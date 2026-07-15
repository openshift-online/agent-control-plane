package clusters

import (
	"time"

	"gorm.io/gorm"

	"github.com/go-gormigrate/gormigrate/v2"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
)

func migration() *gormigrate.Migration {
	type Cluster struct {
		db.Model
		Name            string `gorm:"not null"`
		Description     *string
		ApiServerUrl    string  `gorm:"not null"`
		CredentialId    *string `gorm:"index"`
		Role            string  `gorm:"not null;default:'hybrid'"`
		Status          string  `gorm:"not null;default:'Unknown'"`
		StatusMessage   *string
		Labels          *string `gorm:"type:jsonb"`
		Annotations     *string `gorm:"type:jsonb"`
		Capacity        *string `gorm:"type:jsonb"`
		LastHeartbeatAt *time.Time
	}

	return &gormigrate.Migration{
		ID: "202607150001",
		Migrate: func(tx *gorm.DB) error {
			if err := tx.AutoMigrate(&Cluster{}); err != nil {
				return err
			}
			return tx.Exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_clusters_name ON clusters (name) WHERE deleted_at IS NULL").Error
		},
		Rollback: func(tx *gorm.DB) error {
			return tx.Migrator().DropTable(&Cluster{})
		},
	}
}
