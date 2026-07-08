package gateways

import (
	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"gorm.io/gorm"
)

type Gateway struct {
	api.Meta
	Name           string  `json:"name"             gorm:"not null"`
	ProjectId      string  `json:"project_id"       gorm:"not null;index"`
	Image          *string `json:"image"`
	ServerDnsNames *string `json:"server_dns_names"  gorm:"type:jsonb"`
	Config         *string `json:"config"`
	Labels         *string `json:"labels"            gorm:"type:jsonb"`
	Annotations    *string `json:"annotations"       gorm:"type:jsonb"`
}

type GatewayList []*Gateway
type GatewayIndex map[string]*Gateway

func (l GatewayList) Index() GatewayIndex {
	index := GatewayIndex{}
	for _, o := range l {
		index[o.ID] = o
	}
	return index
}

func (d *Gateway) BeforeCreate(tx *gorm.DB) error {
	d.ID = api.NewID()
	return nil
}

type GatewayPatchRequest struct {
	Name           *string  `json:"name,omitempty"`
	Image          *string  `json:"image,omitempty"`
	ServerDnsNames []string `json:"server_dns_names,omitempty"`
	Config         *string  `json:"config,omitempty"`
	Labels         *string  `json:"labels,omitempty"`
	Annotations    *string  `json:"annotations,omitempty"`
}
