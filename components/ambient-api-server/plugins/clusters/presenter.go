package clusters

import (
	"github.com/ambient-code/platform/components/ambient-api-server/pkg/api/openapi"
	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/api/presenters"
	"github.com/openshift-online/rh-trex-ai/pkg/util"
)

func ConvertCluster(c openapi.Cluster) *Cluster {
	cluster := &Cluster{
		Meta: api.Meta{
			ID: util.NilToEmptyString(c.Id),
		},
	}
	cluster.Name = c.Name
	cluster.ApiServerUrl = c.ApiServerUrl
	cluster.Role = c.Role
	cluster.Description = c.Description
	cluster.CredentialId = c.CredentialId
	cluster.Labels = c.Labels
	cluster.Annotations = c.Annotations

	if c.CreatedAt != nil {
		cluster.CreatedAt = *c.CreatedAt
	}
	if c.UpdatedAt != nil {
		cluster.UpdatedAt = *c.UpdatedAt
	}

	return cluster
}

func PresentCluster(c *Cluster) openapi.Cluster {
	reference := presenters.PresentReference(c.ID, c)
	result := openapi.Cluster{
		Id:              reference.Id,
		Kind:            reference.Kind,
		Href:            reference.Href,
		CreatedAt:       openapi.PtrTime(c.CreatedAt),
		UpdatedAt:       openapi.PtrTime(c.UpdatedAt),
		Name:            c.Name,
		Description:     c.Description,
		ApiServerUrl:    c.ApiServerUrl,
		CredentialId:    c.CredentialId,
		Role:            c.Role,
		Status:          &c.Status,
		StatusMessage:   c.StatusMessage,
		Labels:          c.Labels,
		Annotations:     c.Annotations,
		Capacity:        c.Capacity,
		LastHeartbeatAt: c.LastHeartbeatAt,
	}
	return result
}

func PresentClusterStatus(c *Cluster) openapi.ClusterStatusResponse {
	return openapi.ClusterStatusResponse{
		Id:              &c.ID,
		Status:          &c.Status,
		StatusMessage:   c.StatusMessage,
		Capacity:        c.Capacity,
		LastHeartbeatAt: c.LastHeartbeatAt,
	}
}
