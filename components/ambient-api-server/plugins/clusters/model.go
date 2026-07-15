package clusters

import (
	"time"

	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"gorm.io/gorm"
)

type Cluster struct {
	api.Meta
	Name            string     `json:"name"             gorm:"not null"`
	Description     *string    `json:"description"`
	ApiServerUrl    string     `json:"api_server_url"    gorm:"not null"`
	CredentialId    *string    `json:"credential_id"     gorm:"index"`
	Role            string     `json:"role"              gorm:"not null;default:'hybrid'"`
	Status          string     `json:"status"            gorm:"not null;default:'Unknown'"`
	StatusMessage   *string    `json:"status_message"`
	Labels          *string    `json:"labels"            gorm:"type:jsonb"`
	Annotations     *string    `json:"annotations"       gorm:"type:jsonb"`
	Capacity        *string    `json:"capacity"          gorm:"type:jsonb"`
	LastHeartbeatAt *time.Time `json:"last_heartbeat_at"`
}

type ClusterList []*Cluster
type ClusterIndex map[string]*Cluster

func (l ClusterList) Index() ClusterIndex {
	index := ClusterIndex{}
	for _, o := range l {
		index[o.ID] = o
	}
	return index
}

func (d *Cluster) BeforeCreate(tx *gorm.DB) error {
	d.ID = api.NewID()
	return nil
}

type ClusterPatchRequest struct {
	Name         *string `json:"name,omitempty"`
	Description  *string `json:"description,omitempty"`
	ApiServerUrl *string `json:"api_server_url,omitempty"`
	CredentialId *string `json:"credential_id,omitempty"`
	Role         *string `json:"role,omitempty"`
	Labels       *string `json:"labels,omitempty"`
	Annotations  *string `json:"annotations,omitempty"`
}
