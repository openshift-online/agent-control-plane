package policies

import (
	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"gorm.io/gorm"
)

type Policy struct {
	api.Meta
	ProjectId   string  `json:"project_id" gorm:"not null;index"`
	Name        string  `json:"name" gorm:"not null"`
	Namespace   *string `json:"namespace"`
	Spec        *string `json:"spec" gorm:"type:jsonb"`
	Labels      *string `json:"labels"`
	Annotations *string `json:"annotations"`
}

type PolicyList []*Policy
type PolicyIndex map[string]*Policy

func (d *Policy) BeforeCreate(tx *gorm.DB) error {
	d.ID = api.NewID()
	return nil
}
