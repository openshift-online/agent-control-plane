package agents

import (
	"encoding/json"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/api/openapi"
	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/api/presenters"
	"github.com/openshift-online/rh-trex-ai/pkg/util"
)

func ConvertAgent(agent openapi.Agent) *Agent {
	c := &Agent{
		Meta: api.Meta{
			ID: util.NilToEmptyString(agent.Id),
		},
	}
	c.ProjectId = agent.ProjectId
	c.OwnerUserId = util.NilToEmptyString(agent.OwnerUserId)
	c.Name = agent.Name
	c.DisplayName = agent.DisplayName
	c.Description = agent.Description
	c.Prompt = agent.Prompt
	c.RepoUrl = agent.RepoUrl
	c.WorkflowId = agent.WorkflowId
	if agent.LlmModel != nil {
		c.LlmModel = *agent.LlmModel
	}
	if agent.LlmTemperature != nil {
		c.LlmTemperature = *agent.LlmTemperature
	} else {
		c.LlmTemperature = unsetTemperature
	}
	if agent.LlmMaxTokens != nil {
		c.LlmMaxTokens = *agent.LlmMaxTokens
	} else {
		c.LlmMaxTokens = unsetMaxTokens
	}
	c.BotAccountName = agent.BotAccountName
	c.ResourceOverrides = agent.ResourceOverrides
	c.EnvironmentVariables = agent.EnvironmentVariables
	c.Entrypoint = agent.Entrypoint
	c.SandboxPolicy = agent.SandboxPolicy

	if len(agent.Providers) > 0 {
		if raw, err := json.Marshal(agent.Providers); err == nil {
			s := string(raw)
			c.Providers = &s
		}
	}
	if len(agent.Payloads) > 0 {
		if raw, err := json.Marshal(agent.Payloads); err == nil {
			s := string(raw)
			c.Payloads = &s
		}
	}
	if agent.Environment != nil {
		if raw, err := json.Marshal(agent.Environment); err == nil {
			s := string(raw)
			c.Environment = &s
		}
	}
	if agent.SandboxTemplate != nil {
		if raw, err := json.Marshal(agent.SandboxTemplate); err == nil {
			s := string(raw)
			c.SandboxTemplate = &s
		}
	}

	c.Labels = agent.Labels
	c.Annotations = agent.Annotations

	if agent.CreatedAt != nil {
		c.CreatedAt = *agent.CreatedAt
	}
	if agent.UpdatedAt != nil {
		c.UpdatedAt = *agent.UpdatedAt
	}

	return c
}

func PresentAgent(agent *Agent) openapi.Agent {
	reference := presenters.PresentReference(agent.ID, agent)
	result := openapi.Agent{
		Id:                   reference.Id,
		Kind:                 reference.Kind,
		Href:                 reference.Href,
		CreatedAt:            openapi.PtrTime(agent.CreatedAt),
		UpdatedAt:            openapi.PtrTime(agent.UpdatedAt),
		ProjectId:            agent.ProjectId,
		OwnerUserId:          openapi.PtrString(agent.OwnerUserId),
		Name:                 agent.Name,
		DisplayName:          agent.DisplayName,
		Description:          agent.Description,
		Prompt:               agent.Prompt,
		RepoUrl:              agent.RepoUrl,
		WorkflowId:           agent.WorkflowId,
		LlmModel:             openapi.PtrString(agent.LlmModel),
		LlmTemperature:       openapi.PtrFloat64(agent.LlmTemperature),
		LlmMaxTokens:         openapi.PtrInt32(agent.LlmMaxTokens),
		BotAccountName:       agent.BotAccountName,
		ResourceOverrides:    agent.ResourceOverrides,
		EnvironmentVariables: agent.EnvironmentVariables,
		Entrypoint:           agent.Entrypoint,
		SandboxPolicy:        agent.SandboxPolicy,
		CurrentSessionId:     agent.CurrentSessionId,
		Labels:               agent.Labels,
		Annotations:          agent.Annotations,
	}

	if agent.Providers != nil {
		var providers []string
		if err := json.Unmarshal([]byte(*agent.Providers), &providers); err == nil {
			result.Providers = providers
		}
	}
	if agent.Payloads != nil {
		var payloads []openapi.Payload
		if err := json.Unmarshal([]byte(*agent.Payloads), &payloads); err == nil {
			result.Payloads = payloads
		}
	}
	if agent.Environment != nil {
		var env map[string]string
		if err := json.Unmarshal([]byte(*agent.Environment), &env); err == nil {
			result.Environment = &env
		}
	}
	if agent.SandboxTemplate != nil {
		var tpl openapi.SandboxTemplate
		if err := json.Unmarshal([]byte(*agent.SandboxTemplate), &tpl); err == nil {
			result.SandboxTemplate = &tpl
		}
	}

	return result
}
