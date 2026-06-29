package agents

import (
	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"gorm.io/gorm"
)

type Agent struct {
	api.Meta
	ProjectId            string  `json:"project_id"             gorm:"not null;index"`
	OwnerUserId          string  `json:"owner_user_id"          gorm:"not null"`
	Name                 string  `json:"name"                   gorm:"not null"`
	DisplayName          *string `json:"display_name"`
	Description          *string `json:"description"`
	Prompt               *string `json:"prompt"                 gorm:"type:text"`
	RepoUrl              *string `json:"repo_url"`
	WorkflowId           *string `json:"workflow_id"`
	LlmModel             string  `json:"llm_model"`
	LlmTemperature       float64 `json:"llm_temperature"`
	LlmMaxTokens         int32   `json:"llm_max_tokens"`
	BotAccountName       *string `json:"bot_account_name"`
	ResourceOverrides    *string `json:"resource_overrides"`
	EnvironmentVariables *string `json:"environment_variables"`
	Entrypoint           *string `json:"entrypoint"`
	Providers            *string `json:"providers"              gorm:"type:jsonb"`
	Payloads             *string `json:"payloads"               gorm:"type:jsonb"`
	Environment          *string `json:"environment"            gorm:"type:jsonb"`
	SandboxTemplate      *string `json:"sandbox_template"       gorm:"type:jsonb"`
	SandboxPolicy        *string `json:"sandbox_policy"`
	Labels               *string `json:"labels"`
	Annotations          *string `json:"annotations"`
	CurrentSessionId     *string `json:"current_session_id"`
}

type AgentList []*Agent
type AgentIndex map[string]*Agent

func (l AgentList) Index() AgentIndex {
	index := AgentIndex{}
	for _, o := range l {
		index[o.ID] = o
	}
	return index
}

// Sentinel values indicating the caller did not provide a value.
// Valid temperatures are 0.0–2.0 and valid max_tokens are > 0,
// so negative values are unambiguously "unset".
const (
	unsetTemperature float64 = -1.0
	unsetMaxTokens   int32   = -1
)

func (d *Agent) BeforeCreate(tx *gorm.DB) error {
	d.ID = api.NewID()
	if d.LlmModel == "" {
		d.LlmModel = "claude-sonnet-4-6"
	}
	if d.LlmTemperature == unsetTemperature {
		d.LlmTemperature = 0.7
	}
	if d.LlmMaxTokens == unsetMaxTokens {
		d.LlmMaxTokens = 4000
	}
	return nil
}
