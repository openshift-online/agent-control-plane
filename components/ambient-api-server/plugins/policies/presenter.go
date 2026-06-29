package policies

import (
	"encoding/json"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/api/openapi"
	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/api/presenters"
	"github.com/openshift-online/rh-trex-ai/pkg/util"
)

func ConvertPolicy(p openapi.Policy) *Policy {
	c := &Policy{
		Meta: api.Meta{
			ID: util.NilToEmptyString(p.Id),
		},
	}
	c.ProjectId = p.ProjectId
	c.Name = p.Name
	c.Namespace = p.Namespace
	c.Labels = p.Labels
	c.Annotations = p.Annotations

	if p.Spec != nil {
		if raw, err := json.Marshal(p.Spec); err == nil {
			s := string(raw)
			c.Spec = &s
		}
	}

	if p.CreatedAt != nil {
		c.CreatedAt = *p.CreatedAt
	}
	if p.UpdatedAt != nil {
		c.UpdatedAt = *p.UpdatedAt
	}

	return c
}

func PresentPolicy(p *Policy) openapi.Policy {
	reference := presenters.PresentReference(p.ID, p)
	result := openapi.Policy{
		Id:          reference.Id,
		Kind:        reference.Kind,
		Href:        reference.Href,
		CreatedAt:   openapi.PtrTime(p.CreatedAt),
		UpdatedAt:   openapi.PtrTime(p.UpdatedAt),
		ProjectId:   p.ProjectId,
		Name:        p.Name,
		Namespace:   p.Namespace,
		Labels:      p.Labels,
		Annotations: p.Annotations,
	}

	if p.Spec != nil {
		var spec map[string]interface{}
		if err := json.Unmarshal([]byte(*p.Spec), &spec); err == nil {
			result.Spec = spec
		}
	}

	return result
}
