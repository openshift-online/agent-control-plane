package providers

import (
	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"gorm.io/gorm"
)

type Provider struct {
	api.Meta
	ProjectId   string  `json:"project_id" gorm:"not null;index"`
	Name        string  `json:"name" gorm:"not null"`
	Type        *string `json:"type"`
	Secret      *string `json:"secret"`
	Namespace   *string `json:"namespace"`
	Labels      *string `json:"labels"`
	Annotations *string `json:"annotations"`
}

type ProviderList []*Provider
type ProviderIndex map[string]*Provider

func (d *Provider) BeforeCreate(tx *gorm.DB) error {
	d.ID = api.NewID()
	return nil
}
