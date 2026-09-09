package projects

import (
	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/pkg/api/openapi"
	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/api/presenters"
	"github.com/openshift-online/rh-trex-ai/pkg/util"
)

func ConvertProject(project openapi.Project) *Project {
	c := &Project{
		Meta: api.Meta{
			ID: util.NilToEmptyString(project.Id),
		},
	}
	c.Name = project.Name
	c.Description = project.Description
	c.Prompt = project.Prompt
	c.Labels = project.Labels
	c.Annotations = project.Annotations
	c.Status = project.Status

	if project.CreatedAt != nil {
		c.CreatedAt = *project.CreatedAt
		c.UpdatedAt = *project.UpdatedAt
	}

	return c
}

func PresentProject(project *Project) openapi.Project {
	reference := presenters.PresentReference(project.ID, project)
	return openapi.Project{
		RuntimeBackend:           project.RuntimeBackend,
		GatewayId:                project.GatewayId,
		GatewayInstanceId:        project.GatewayInstanceId,
		GatewayEndpoint:          project.GatewayEndpoint,
		GatewayStatus:            project.GatewayStatus,
		GatewayError:             project.GatewayError,
		GatewayCredentialId:      project.GatewayCredentialId,
		GatewayAccountId:         project.GatewayAccountId,
		GatewayAccountExpiresAt:  project.GatewayAccountExpiresAt,
		GatewayExternalReference: project.GatewayExternalReference,
		RuntimeDeleted:           openapi.PtrBool(project.DeletedAt.Valid),
		RuntimeVersion:           openapi.PtrInt64(project.RuntimeVersion),
		Id:                       reference.Id,
		Kind:                     reference.Kind,
		Href:                     reference.Href,
		CreatedAt:                openapi.PtrTime(project.CreatedAt),
		UpdatedAt:                openapi.PtrTime(project.UpdatedAt),
		Name:                     project.Name,
		Description:              project.Description,
		Prompt:                   project.Prompt,
		Labels:                   project.Labels,
		Annotations:              project.Annotations,
		Status:                   project.Status,
	}
}
