package providers

import (
	"github.com/ambient-code/platform/components/ambient-api-server/pkg/api/openapi"
	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/api/presenters"
	"github.com/openshift-online/rh-trex-ai/pkg/util"
)

func ConvertProvider(p openapi.Provider) *Provider {
	c := &Provider{
		Meta: api.Meta{
			ID: util.NilToEmptyString(p.Id),
		},
	}
	c.ProjectId = p.ProjectId
	c.Name = p.Name
	c.Type = p.Type
	c.Secret = p.Secret
	c.Namespace = p.Namespace
	c.Labels = p.Labels
	c.Annotations = p.Annotations

	if p.CreatedAt != nil {
		c.CreatedAt = *p.CreatedAt
	}
	if p.UpdatedAt != nil {
		c.UpdatedAt = *p.UpdatedAt
	}

	return c
}

func PresentProvider(p *Provider) openapi.Provider {
	reference := presenters.PresentReference(p.ID, p)
	return openapi.Provider{
		Id:          reference.Id,
		Kind:        reference.Kind,
		Href:        reference.Href,
		CreatedAt:   openapi.PtrTime(p.CreatedAt),
		UpdatedAt:   openapi.PtrTime(p.UpdatedAt),
		ProjectId:   p.ProjectId,
		Name:        p.Name,
		Type:        p.Type,
		Secret:      p.Secret,
		Namespace:   p.Namespace,
		Labels:      p.Labels,
		Annotations: p.Annotations,
	}
}
