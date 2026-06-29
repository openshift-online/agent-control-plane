package reconciler

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/ambient-code/platform/components/ambient-control-plane/internal/kubeclient"
	sdkclient "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/client"
	"github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
	"github.com/rs/zerolog"
	"gopkg.in/yaml.v3"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

const (
	configMapSyncInterval = 30 * time.Second
	agentDeclarationLabel = "ambient.ai/kind=agent"
)

type AgentDeclaration struct {
	Name            string            `yaml:"name"`
	DisplayName     string            `yaml:"display_name,omitempty"`
	Description     string            `yaml:"description,omitempty"`
	Prompt          string            `yaml:"prompt,omitempty"`
	Entrypoint      string            `yaml:"entrypoint,omitempty"`
	Providers       []string          `yaml:"providers,omitempty"`
	Environment     map[string]string `yaml:"environment,omitempty"`
	Payloads        []PayloadDecl     `yaml:"payloads,omitempty"`
	SandboxTemplate *SandboxTemplDecl `yaml:"sandbox_template,omitempty"`
	SandboxPolicy   string            `yaml:"sandbox_policy,omitempty"`
	RepoURL         string            `yaml:"repo_url,omitempty"`
	LlmModel        string            `yaml:"llm_model,omitempty"`
	Labels          map[string]string `yaml:"labels,omitempty"`
	Annotations     map[string]string `yaml:"annotations,omitempty"`
}

type PayloadDecl struct {
	SandboxPath string `yaml:"sandbox_path"`
	Content     string `yaml:"content,omitempty"`
	RepoURL     string `yaml:"repo_url,omitempty"`
	Ref         string `yaml:"ref,omitempty"`
}

type SandboxTemplDecl struct {
	Image            string        `yaml:"image,omitempty"`
	Resources        *ResourceDecl `yaml:"resources,omitempty"`
	GPU              *GPUDecl      `yaml:"gpu,omitempty"`
	RuntimeClassName string        `yaml:"runtime_class_name,omitempty"`
	LogLevel         string        `yaml:"log_level,omitempty"`
}

type ResourceDecl struct {
	CPU    string `yaml:"cpu,omitempty"`
	Memory string `yaml:"memory,omitempty"`
}

type GPUDecl struct {
	Count int32 `yaml:"count,omitempty"`
}

type ConfigMapSyncer struct {
	factory      *SDKClientFactory
	kube         *kubeclient.KubeClient
	provisioner  kubeclient.NamespaceProvisioner
	platformMode string
	mppConfigNS  string
	logger       zerolog.Logger
}

func NewConfigMapSyncer(factory *SDKClientFactory, kube *kubeclient.KubeClient, provisioner kubeclient.NamespaceProvisioner, platformMode, mppConfigNS string, logger zerolog.Logger) *ConfigMapSyncer {
	return &ConfigMapSyncer{
		factory:      factory,
		kube:         kube,
		provisioner:  provisioner,
		platformMode: platformMode,
		mppConfigNS:  mppConfigNS,
		logger:       logger.With().Str("component", "configmap-syncer").Logger(),
	}
}

func (s *ConfigMapSyncer) Run(ctx context.Context) error {
	s.logger.Info().Dur("interval", configMapSyncInterval).Msg("configmap syncer started")
	ticker := time.NewTicker(configMapSyncInterval)
	defer ticker.Stop()

	s.syncOnce(ctx)

	for {
		select {
		case <-ctx.Done():
			s.logger.Info().Msg("configmap syncer stopped")
			return ctx.Err()
		case <-ticker.C:
			s.syncOnce(ctx)
		}
	}
}

func (s *ConfigMapSyncer) syncOnce(ctx context.Context) {
	namespaces, err := s.listManagedNamespaces(ctx)
	if err != nil {
		s.logger.Warn().Err(err).Msg("failed to list managed namespaces for configmap sync")
		return
	}

	for _, ns := range namespaces {
		s.syncNamespaceAgents(ctx, ns.name, ns.projectID)
	}
}

type nsInfo struct {
	name      string
	projectID string
}

func (s *ConfigMapSyncer) listManagedNamespaces(ctx context.Context) ([]nsInfo, error) {
	nsList, err := s.kube.ListNamespacesByLabel(ctx, managedLabelFilter)
	if err != nil {
		return nil, fmt.Errorf("listing managed namespaces: %w", err)
	}

	var result []nsInfo
	for _, ns := range nsList.Items {
		projectID := ns.GetLabels()[LabelProjectID]
		if projectID == "" {
			continue
		}
		result = append(result, nsInfo{name: ns.GetName(), projectID: projectID})
	}
	return result, nil
}

func (s *ConfigMapSyncer) syncNamespaceAgents(ctx context.Context, namespace, projectID string) {
	cmList, err := s.kube.ListConfigMapsByLabel(ctx, namespace, agentDeclarationLabel)
	if err != nil {
		s.logger.Warn().Err(err).Str("namespace", namespace).Msg("failed to list agent configmaps")
		return
	}

	sdk, err := s.factory.ForProject(ctx, projectID)
	if err != nil {
		s.logger.Warn().Err(err).Str("project_id", projectID).Msg("failed to get SDK client for configmap sync")
		return
	}

	declaredAgents := map[string]bool{}

	for _, cm := range cmList.Items {
		data, _, _ := unstructured.NestedStringMap(cm.Object, "data")
		for key, yamlStr := range data {
			decl, err := parseAgentDeclaration(yamlStr)
			if err != nil {
				s.logger.Warn().Err(err).
					Str("namespace", namespace).
					Str("configmap", cm.GetName()).
					Str("key", key).
					Msg("invalid agent declaration YAML")
				continue
			}
			if decl.Name == "" {
				s.logger.Warn().
					Str("namespace", namespace).
					Str("configmap", cm.GetName()).
					Str("key", key).
					Msg("agent declaration missing required 'name' field")
				continue
			}

			declaredAgents[decl.Name] = true
			if err := s.upsertAgent(ctx, sdk, projectID, decl); err != nil {
				s.logger.Warn().Err(err).
					Str("namespace", namespace).
					Str("agent", decl.Name).
					Msg("failed to upsert agent from configmap")
			}
		}
	}

	s.pruneRemovedAgents(ctx, sdk, projectID, declaredAgents)
}

func parseAgentDeclaration(yamlStr string) (*AgentDeclaration, error) {
	var decl AgentDeclaration
	if err := yaml.Unmarshal([]byte(yamlStr), &decl); err != nil {
		return nil, fmt.Errorf("parsing agent YAML: %w", err)
	}

	for i, p := range decl.Payloads {
		if p.SandboxPath == "" {
			return nil, fmt.Errorf("payload[%d]: sandbox_path is required", i)
		}
		if p.Content != "" && p.RepoURL != "" {
			return nil, fmt.Errorf("payload[%d]: cannot specify both content and repo_url", i)
		}
	}

	return &decl, nil
}

func (s *ConfigMapSyncer) upsertAgent(ctx context.Context, sdk *sdkclient.Client, projectID string, decl *AgentDeclaration) error {
	existing := s.findAgentByName(ctx, sdk, projectID, decl.Name)

	patch := map[string]interface{}{}
	if decl.DisplayName != "" {
		patch["display_name"] = decl.DisplayName
	}
	if decl.Description != "" {
		patch["description"] = decl.Description
	}
	if decl.Prompt != "" {
		patch["prompt"] = decl.Prompt
	}
	if decl.RepoURL != "" {
		patch["repo_url"] = decl.RepoURL
	}
	if decl.LlmModel != "" {
		patch["llm_model"] = decl.LlmModel
	}
	if decl.Entrypoint != "" {
		patch["entrypoint"] = decl.Entrypoint
	}
	if decl.SandboxPolicy != "" {
		patch["sandbox_policy"] = decl.SandboxPolicy
	}
	if len(decl.Providers) > 0 {
		patch["providers"] = decl.Providers
	}
	if len(decl.Payloads) > 0 {
		patch["payloads"] = decl.Payloads
	}
	if len(decl.Environment) > 0 {
		patch["environment"] = decl.Environment
	}
	if decl.SandboxTemplate != nil {
		patch["sandbox_template"] = decl.SandboxTemplate
	}
	if len(decl.Labels) > 0 {
		labelsJSON, _ := json.Marshal(decl.Labels)
		patch["labels"] = string(labelsJSON)
	}
	if len(decl.Annotations) > 0 {
		annJSON, _ := json.Marshal(decl.Annotations)
		patch["annotations"] = string(annJSON)
	}

	if existing != nil {
		if _, err := sdk.Agents().Update(ctx, existing.ID, patch); err != nil {
			return fmt.Errorf("updating agent %s: %w", decl.Name, err)
		}
		s.logger.Debug().Str("agent", decl.Name).Str("id", existing.ID).Msg("agent updated from configmap")
		return nil
	}

	agent, err := types.NewAgentBuilder().
		Name(decl.Name).
		ProjectID(projectID).
		Build()
	if err != nil {
		return fmt.Errorf("building agent %s: %w", decl.Name, err)
	}

	if decl.DisplayName != "" {
		agent.DisplayName = decl.DisplayName
	}
	if decl.Description != "" {
		agent.Description = decl.Description
	}
	if decl.Prompt != "" {
		agent.Prompt = decl.Prompt
	}
	if decl.RepoURL != "" {
		agent.RepoURL = decl.RepoURL
	}
	if decl.LlmModel != "" {
		agent.LlmModel = decl.LlmModel
	}
	if decl.Entrypoint != "" {
		agent.Entrypoint = decl.Entrypoint
	}
	if decl.SandboxPolicy != "" {
		agent.SandboxPolicy = decl.SandboxPolicy
	}
	if len(decl.Providers) > 0 {
		if raw, err := json.Marshal(decl.Providers); err == nil {
			agent.Providers = string(raw)
		}
	}
	if len(decl.Payloads) > 0 {
		if raw, err := json.Marshal(decl.Payloads); err == nil {
			agent.Payloads = string(raw)
		}
	}
	if len(decl.Environment) > 0 {
		if raw, err := json.Marshal(decl.Environment); err == nil {
			agent.Environment = string(raw)
		}
	}
	if decl.SandboxTemplate != nil {
		if raw, err := json.Marshal(decl.SandboxTemplate); err == nil {
			agent.SandboxTemplate = string(raw)
		}
	}

	created, err := sdk.Agents().Create(ctx, agent)
	if err != nil {
		return fmt.Errorf("creating agent %s: %w", decl.Name, err)
	}
	s.logger.Info().Str("agent", decl.Name).Str("id", created.ID).Msg("agent created from configmap")
	return nil
}

func (s *ConfigMapSyncer) findAgentByName(ctx context.Context, sdk *sdkclient.Client, projectID, name string) *types.Agent {
	agents, err := sdk.Agents().List(ctx, &types.ListOptions{Size: 100, Search: fmt.Sprintf("name = '%s'", name)})
	if err != nil {
		return nil
	}
	for _, a := range agents.Items {
		if a.Name == name {
			return &a
		}
	}
	return nil
}

func (s *ConfigMapSyncer) pruneRemovedAgents(ctx context.Context, sdk *sdkclient.Client, projectID string, declaredAgents map[string]bool) {
	agents, err := sdk.Agents().List(ctx, &types.ListOptions{Size: 500})
	if err != nil {
		s.logger.Warn().Err(err).Str("project_id", projectID).Msg("failed to list agents for pruning")
		return
	}

	for _, a := range agents.Items {
		if a.Entrypoint != "" && !declaredAgents[a.Name] {
			if err := sdk.Agents().Delete(ctx, a.ID); err != nil {
				s.logger.Warn().Err(err).Str("agent", a.Name).Msg("failed to delete stale agent")
			} else {
				s.logger.Info().Str("agent", a.Name).Str("id", a.ID).Msg("pruned agent no longer declared in configmaps")
			}
		}
	}
}
