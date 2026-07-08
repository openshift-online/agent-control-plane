package gateways

import (
	"encoding/json"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/api/openapi"
	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/api/presenters"
	"github.com/openshift-online/rh-trex-ai/pkg/util"
)

func ConvertGateway(gw openapi.Gateway) *Gateway {
	c := &Gateway{
		Meta: api.Meta{
			ID: util.NilToEmptyString(gw.Id),
		},
	}
	c.Name = gw.Name
	c.ProjectId = gw.ProjectId
	c.Image = gw.Image
	c.Config = gw.Config

	if len(gw.ServerDnsNames) > 0 {
		if raw, err := json.Marshal(gw.ServerDnsNames); err == nil {
			s := string(raw)
			c.ServerDnsNames = &s
		}
	}

	if gw.CreatedAt != nil {
		c.CreatedAt = *gw.CreatedAt
		c.UpdatedAt = *gw.UpdatedAt
	}

	return c
}

func PresentGateway(gw *Gateway) openapi.Gateway {
	reference := presenters.PresentReference(gw.ID, gw)
	result := openapi.Gateway{
		Id:        reference.Id,
		Kind:      reference.Kind,
		Href:      reference.Href,
		CreatedAt: openapi.PtrTime(gw.CreatedAt),
		UpdatedAt: openapi.PtrTime(gw.UpdatedAt),
		Name:      gw.Name,
		ProjectId: gw.ProjectId,
		Image:     gw.Image,
		Config:    gw.Config,
	}

	if gw.ServerDnsNames != nil {
		var dnsNames []string
		if err := json.Unmarshal([]byte(*gw.ServerDnsNames), &dnsNames); err == nil {
			result.ServerDnsNames = dnsNames
		}
	}

	return result
}
