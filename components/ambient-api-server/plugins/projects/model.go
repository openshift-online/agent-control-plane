package projects

import (
	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"gorm.io/gorm"
)

type Project struct {
	RuntimeBackend           *string `json:"runtime_backend,omitempty"`
	GatewayId                *string `json:"gateway_id,omitempty"`
	GatewayInstanceId        *string `json:"gateway_instance_id,omitempty"`
	GatewayEndpoint          *string `json:"gateway_endpoint,omitempty"`
	GatewayStatus            *string `json:"gateway_status,omitempty"`
	GatewayError             *string `json:"gateway_error,omitempty"`
	GatewayCredentialId      *string `json:"gateway_credential_id,omitempty"`
	GatewayAccountId         *string `json:"gateway_account_id,omitempty"`
	GatewayAccountExpiresAt  *string `json:"gateway_account_expires_at,omitempty"`
	GatewayExternalReference *string `json:"gateway_external_reference,omitempty"`
	RuntimeDeleted           bool    `json:"runtime_deleted" gorm:"-"`
	RuntimeVersion           int64   `json:"runtime_version" gorm:"not null;default:0"`
	api.Meta
	Name        string  `json:"name" gorm:"uniqueIndex;not null"`
	Description *string `json:"description"`
	Prompt      *string `json:"prompt" gorm:"type:text"`
	Labels      *string `json:"labels"`
	Annotations *string `json:"annotations"`
	Status      *string `json:"status"`
}

type ProjectList []*Project
type ProjectIndex map[string]*Project

func (l ProjectList) Index() ProjectIndex {
	index := ProjectIndex{}
	for _, o := range l {
		index[o.ID] = o
	}
	return index
}

func (d *Project) BeforeCreate(tx *gorm.DB) error {
	d.ID = d.Name
	return nil
}

type ProjectPatchRequest struct {
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
	Prompt      *string `json:"prompt,omitempty"`
	Labels      *string `json:"labels,omitempty"`
	Annotations *string `json:"annotations,omitempty"`
	Status      *string `json:"status,omitempty"`
}
