package reconciler

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/ambient-code/platform/components/ambient-control-plane/internal/kubeclient"
	sdkclient "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/client"
	"github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
	"github.com/rs/zerolog"
	"gopkg.in/yaml.v3"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/tools/cache"
)

const (
	configMapResyncInterval  = 5 * time.Minute
	configMapDebounceDelay   = 2 * time.Second
	agentDeclarationLabel    = "ambient.ai/kind=agent"
	providerDeclarationLabel = "ambient.ai/kind=provider"
	policyDeclarationLabel   = "ambient.ai/kind=policy"
	declarationLabelKey      = "ambient.ai/kind"
	annotationSource         = "ambient.ai/source"
	annotationSourceCM       = "configmap"
	annotationSourceNS       = "ambient.ai/source-namespace"
)

type ProviderDeclaration struct {
	Name   string `yaml:"name"`
	Type   string `yaml:"type,omitempty"`
	Secret string `yaml:"secret,omitempty"`
}

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
	SandboxPath string `yaml:"sandbox_path" json:"sandbox_path"`
	Content     string `yaml:"content,omitempty" json:"content,omitempty"`
	RepoURL     string `yaml:"repo_url,omitempty" json:"repo_url,omitempty"`
	Ref         string `yaml:"ref,omitempty" json:"ref,omitempty"`
}

type SandboxTemplDecl struct {
	Image            string        `yaml:"image,omitempty" json:"image,omitempty"`
	Resources        *ResourceDecl `yaml:"resources,omitempty" json:"resources,omitempty"`
	GPU              *GPUDecl      `yaml:"gpu,omitempty" json:"gpu,omitempty"`
	RuntimeClassName string        `yaml:"runtime_class_name,omitempty" json:"runtime_class_name,omitempty"`
	LogLevel         string        `yaml:"log_level,omitempty" json:"log_level,omitempty"`
}

type ResourceDecl struct {
	CPU    string `yaml:"cpu,omitempty" json:"cpu,omitempty"`
	Memory string `yaml:"memory,omitempty" json:"memory,omitempty"`
}

type GPUDecl struct {
	Count int32 `yaml:"count,omitempty" json:"count,omitempty"`
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
	s.logger.Info().Msg("configmap syncer starting with informer-based watch")

	dynFactory := dynamicinformer.NewFilteredDynamicSharedInformerFactory(
		s.kube.DynamicClient(),
		configMapResyncInterval,
		metav1.NamespaceAll,
		func(opts *metav1.ListOptions) {
			opts.LabelSelector = declarationLabelKey
		},
	)

	cmInformer := dynFactory.ForResource(kubeclient.ConfigMapGVR).Informer()

	var pendingMu sync.Mutex
	pendingNamespaces := map[string]bool{}
	debounceCh := make(chan struct{}, 1)

	enqueueNamespace := func(obj interface{}) {
		u, ok := obj.(*unstructured.Unstructured)
		if !ok {
			tombstone, isTombstone := obj.(cache.DeletedFinalStateUnknown)
			if !isTombstone {
				return
			}
			u, ok = tombstone.Obj.(*unstructured.Unstructured)
			if !ok {
				return
			}
		}
		ns := u.GetNamespace()
		if ns == "" {
			return
		}
		pendingMu.Lock()
		pendingNamespaces[ns] = true
		pendingMu.Unlock()
		select {
		case debounceCh <- struct{}{}:
		default:
		}
	}

	if _, err := cmInformer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc:    enqueueNamespace,
		UpdateFunc: func(_, newObj interface{}) { enqueueNamespace(newObj) },
		DeleteFunc: enqueueNamespace,
	}); err != nil {
		return fmt.Errorf("adding configmap event handler: %w", err)
	}

	dynFactory.Start(ctx.Done())
	synced := dynFactory.WaitForCacheSync(ctx.Done())
	for gvr, ok := range synced {
		if !ok {
			return fmt.Errorf("informer cache sync failed for %s", gvr.String())
		}
	}
	s.logger.Info().Msg("configmap informer cache synced, running initial full sync")

	s.syncOnce(ctx)

	for {
		select {
		case <-ctx.Done():
			s.logger.Info().Msg("configmap syncer stopped")
			return ctx.Err()
		case <-debounceCh:
			select {
			case <-time.After(configMapDebounceDelay):
			case <-ctx.Done():
				return ctx.Err()
			}

			pendingMu.Lock()
			toSync := pendingNamespaces
			pendingNamespaces = map[string]bool{}
			pendingMu.Unlock()

			for ns := range toSync {
				s.syncNamespace(ctx, ns)
			}
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
		s.syncNamespaceProviders(ctx, ns.name, ns.projectID)
		s.syncNamespacePolicies(ctx, ns.name, ns.projectID)
	}
}

func (s *ConfigMapSyncer) syncNamespace(ctx context.Context, namespace string) {
	ns, err := s.kube.GetNamespace(ctx, namespace)
	if err != nil {
		s.logger.Warn().Err(err).Str("namespace", namespace).Msg("failed to get namespace for configmap event")
		return
	}
	labels := ns.GetLabels()
	if labels[LabelManaged] != "true" {
		return
	}
	projectID := labels[LabelProjectID]
	if projectID == "" {
		return
	}
	s.logger.Debug().Str("namespace", namespace).Str("project_id", projectID).Msg("syncing namespace from configmap event")
	s.syncNamespaceAgents(ctx, namespace, projectID)
	s.syncNamespaceProviders(ctx, namespace, projectID)
	s.syncNamespacePolicies(ctx, namespace, projectID)
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
			if err := s.upsertAgent(ctx, sdk, projectID, namespace, decl); err != nil {
				s.logger.Warn().Err(err).
					Str("namespace", namespace).
					Str("agent", decl.Name).
					Msg("failed to upsert agent from configmap")
			}
		}
	}

	s.pruneRemovedAgents(ctx, sdk, projectID, namespace, declaredAgents)
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

func (s *ConfigMapSyncer) buildOriginAnnotations(namespace string, userAnnotations map[string]string) (string, error) {
	merged := make(map[string]string, len(userAnnotations)+2)
	for k, v := range userAnnotations {
		merged[k] = v
	}
	merged[annotationSource] = annotationSourceCM
	merged[annotationSourceNS] = namespace
	raw, err := json.Marshal(merged)
	if err != nil {
		return "", fmt.Errorf("marshalling annotations: %w", err)
	}
	return string(raw), nil
}

func (s *ConfigMapSyncer) upsertAgent(ctx context.Context, sdk *sdkclient.Client, projectID, namespace string, decl *AgentDeclaration) error {
	existing := s.findAgentByName(ctx, sdk, projectID, decl.Name)

	annJSON, err := s.buildOriginAnnotations(namespace, decl.Annotations)
	if err != nil {
		return err
	}

	patch := map[string]interface{}{
		"annotations": annJSON,
	}
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
		labelsJSON, err := json.Marshal(decl.Labels)
		if err != nil {
			return fmt.Errorf("marshalling agent labels: %w", err)
		}
		patch["labels"] = string(labelsJSON)
	}

	if existing != nil {
		if _, err := sdk.Agents().Update(ctx, existing.ID, patch); err != nil {
			return fmt.Errorf("updating agent %s: %w", decl.Name, err)
		}
		s.logger.Debug().Str("agent", decl.Name).Str("id", existing.ID).Msg("agent updated from configmap")
		return nil
	}

	// Create with minimal fields only. Complex fields (providers, payloads,
	// environment, sandbox_template) are object/array types in the OpenAPI spec
	// but the SDK Agent struct stores them as strings, causing double-encoding
	// when json.Marshal serializes the struct. The patch map built above uses
	// map[string]any with native Go types, which serializes correctly.
	agent, err := types.NewAgentBuilder().
		Name(decl.Name).
		ProjectID(projectID).
		Build()
	if err != nil {
		return fmt.Errorf("building agent %s: %w", decl.Name, err)
	}

	created, err := sdk.Agents().Create(ctx, agent)
	if err != nil {
		return fmt.Errorf("creating agent %s: %w", decl.Name, err)
	}
	if _, err := sdk.Agents().Update(ctx, created.ID, patch); err != nil {
		return fmt.Errorf("updating newly created agent %s: %w", decl.Name, err)
	}
	s.logger.Info().Str("agent", decl.Name).Str("id", created.ID).Msg("agent created from configmap")
	return nil
}

func (s *ConfigMapSyncer) findAgentByName(ctx context.Context, sdk *sdkclient.Client, projectID, name string) *types.Agent {
	escapedName := strings.ReplaceAll(name, "'", "''")
	escapedProjectID := strings.ReplaceAll(projectID, "'", "''")
	// Request only scalar fields to avoid deserialization failures: the API
	// returns environment/providers/payloads/sandbox_template as JSON
	// objects/arrays, but the SDK Agent struct types them as strings.
	agents, err := sdk.Agents().List(ctx, &types.ListOptions{
		Size:   1,
		Search: fmt.Sprintf("name = '%s' AND project_id = '%s'", escapedName, escapedProjectID),
		Fields: "id,name,project_id,annotations",
	})
	if err != nil {
		s.logger.Warn().Err(err).Str("name", name).Str("project_id", projectID).Msg("failed to search for existing agent")
		return nil
	}
	for _, a := range agents.Items {
		if a.Name == name && a.ProjectID == projectID {
			return &a
		}
	}
	return nil
}

func (s *ConfigMapSyncer) isConfigMapManaged(annotations string, namespace string) bool {
	if annotations == "" {
		return false
	}
	var ann map[string]string
	if err := json.Unmarshal([]byte(annotations), &ann); err != nil {
		return false
	}
	return ann[annotationSource] == annotationSourceCM && ann[annotationSourceNS] == namespace
}

func (s *ConfigMapSyncer) pruneRemovedAgents(ctx context.Context, sdk *sdkclient.Client, projectID, namespace string, declaredAgents map[string]bool) {
	escapedProjectID := strings.ReplaceAll(projectID, "'", "''")
	agents, err := sdk.Agents().List(ctx, &types.ListOptions{
		Size:   500,
		Search: fmt.Sprintf("project_id = '%s'", escapedProjectID),
		Fields: "id,name,project_id,annotations",
	})
	if err != nil {
		s.logger.Warn().Err(err).Str("project_id", projectID).Msg("failed to list agents for pruning")
		return
	}

	for _, a := range agents.Items {
		if s.isConfigMapManaged(a.Annotations, namespace) && !declaredAgents[a.Name] {
			if err := sdk.Agents().Delete(ctx, a.ID); err != nil {
				s.logger.Warn().Err(err).Str("agent", a.Name).Msg("failed to delete stale agent")
			} else {
				s.logger.Info().Str("agent", a.Name).Str("id", a.ID).Msg("pruned agent no longer declared in configmaps")
			}
		}
	}
}

// --- Provider ConfigMap sync ---

func (s *ConfigMapSyncer) syncNamespaceProviders(ctx context.Context, namespace, projectID string) {
	cmList, err := s.kube.ListConfigMapsByLabel(ctx, namespace, providerDeclarationLabel)
	if err != nil {
		s.logger.Warn().Err(err).Str("namespace", namespace).Msg("failed to list provider configmaps")
		return
	}

	sdk, err := s.factory.ForProject(ctx, projectID)
	if err != nil {
		s.logger.Warn().Err(err).Str("project_id", projectID).Msg("failed to get SDK client for provider sync")
		return
	}

	declared := map[string]bool{}

	for _, cm := range cmList.Items {
		data, found, nestedErr := unstructured.NestedStringMap(cm.Object, "data")
		if nestedErr != nil {
			s.logger.Warn().Err(nestedErr).Str("configmap", cm.GetName()).Msg("failed to read provider configmap data")
			continue
		}
		if !found {
			continue
		}
		for key, yamlStr := range data {
			var decl ProviderDeclaration
			if unmarshalErr := yaml.Unmarshal([]byte(yamlStr), &decl); unmarshalErr != nil {
				s.logger.Warn().Err(unmarshalErr).
					Str("namespace", namespace).
					Str("configmap", cm.GetName()).
					Str("key", key).
					Msg("invalid provider declaration YAML")
				continue
			}
			if decl.Name == "" {
				s.logger.Warn().
					Str("namespace", namespace).
					Str("configmap", cm.GetName()).
					Str("key", key).
					Msg("provider declaration missing required 'name' field")
				continue
			}

			declared[decl.Name] = true
			if upsertErr := s.upsertProvider(ctx, sdk, projectID, namespace, &decl); upsertErr != nil {
				s.logger.Warn().Err(upsertErr).
					Str("namespace", namespace).
					Str("provider", decl.Name).
					Msg("failed to upsert provider from configmap")
			}
		}
	}

	s.pruneRemovedProviders(ctx, sdk, projectID, namespace, declared)
}

func (s *ConfigMapSyncer) upsertProvider(ctx context.Context, sdk *sdkclient.Client, projectID, namespace string, decl *ProviderDeclaration) error {
	existing := s.findProviderByName(ctx, sdk, projectID, decl.Name)

	annJSON, err := s.buildOriginAnnotations(namespace, nil)
	if err != nil {
		return err
	}

	patch := map[string]interface{}{
		"annotations": annJSON,
	}
	if decl.Type != "" {
		patch["type"] = decl.Type
	}
	if decl.Secret != "" {
		patch["secret"] = decl.Secret
	}

	if existing != nil {
		if _, updateErr := sdk.Providers().Update(ctx, existing.ID, patch); updateErr != nil {
			return fmt.Errorf("updating provider %s: %w", decl.Name, updateErr)
		}
		s.logger.Debug().Str("provider", decl.Name).Str("id", existing.ID).Msg("provider updated from configmap")
		return nil
	}

	provider, err := types.NewProviderBuilder().
		Name(decl.Name).
		ProjectID(projectID).
		Namespace(namespace).
		Build()
	if err != nil {
		return fmt.Errorf("building provider %s: %w", decl.Name, err)
	}

	created, createErr := sdk.Providers().Create(ctx, provider)
	if createErr != nil {
		return fmt.Errorf("creating provider %s: %w", decl.Name, createErr)
	}
	if _, updateErr := sdk.Providers().Update(ctx, created.ID, patch); updateErr != nil {
		return fmt.Errorf("updating newly created provider %s: %w", decl.Name, updateErr)
	}
	s.logger.Info().Str("provider", decl.Name).Str("id", created.ID).Msg("provider created from configmap")
	return nil
}

func (s *ConfigMapSyncer) findProviderByName(ctx context.Context, sdk *sdkclient.Client, projectID, name string) *types.Provider {
	escapedName := strings.ReplaceAll(name, "'", "''")
	escapedProjectID := strings.ReplaceAll(projectID, "'", "''")
	providers, err := sdk.Providers().List(ctx, &types.ListOptions{
		Size:   1,
		Search: fmt.Sprintf("name = '%s' AND project_id = '%s'", escapedName, escapedProjectID),
	})
	if err != nil {
		s.logger.Warn().Err(err).Str("name", name).Str("project_id", projectID).Msg("failed to search for existing provider")
		return nil
	}
	for _, p := range providers.Items {
		if p.Name == name && p.ProjectID == projectID {
			return &p
		}
	}
	return nil
}

func (s *ConfigMapSyncer) pruneRemovedProviders(ctx context.Context, sdk *sdkclient.Client, projectID, namespace string, declared map[string]bool) {
	escapedProjectID := strings.ReplaceAll(projectID, "'", "''")
	providers, err := sdk.Providers().List(ctx, &types.ListOptions{
		Size:   500,
		Search: fmt.Sprintf("project_id = '%s'", escapedProjectID),
	})
	if err != nil {
		s.logger.Warn().Err(err).Str("project_id", projectID).Msg("failed to list providers for pruning")
		return
	}

	for _, p := range providers.Items {
		if s.isConfigMapManaged(p.Annotations, namespace) && !declared[p.Name] {
			if deleteErr := sdk.Providers().Delete(ctx, p.ID); deleteErr != nil {
				s.logger.Warn().Err(deleteErr).Str("provider", p.Name).Msg("failed to delete stale provider")
			} else {
				s.logger.Info().Str("provider", p.Name).Str("id", p.ID).Msg("pruned provider no longer declared in configmaps")
			}
		}
	}
}

// --- Policy ConfigMap sync ---

func (s *ConfigMapSyncer) syncNamespacePolicies(ctx context.Context, namespace, projectID string) {
	cmList, err := s.kube.ListConfigMapsByLabel(ctx, namespace, policyDeclarationLabel)
	if err != nil {
		s.logger.Warn().Err(err).Str("namespace", namespace).Msg("failed to list policy configmaps")
		return
	}

	sdk, err := s.factory.ForProject(ctx, projectID)
	if err != nil {
		s.logger.Warn().Err(err).Str("project_id", projectID).Msg("failed to get SDK client for policy sync")
		return
	}

	declared := map[string]bool{}

	for _, cm := range cmList.Items {
		data, found, nestedErr := unstructured.NestedStringMap(cm.Object, "data")
		if nestedErr != nil {
			s.logger.Warn().Err(nestedErr).Str("configmap", cm.GetName()).Msg("failed to read policy configmap data")
			continue
		}
		if !found {
			continue
		}
		for key, yamlStr := range data {
			name, spec, parseErr := parsePolicyDeclaration(yamlStr)
			if parseErr != nil {
				s.logger.Warn().Err(parseErr).
					Str("namespace", namespace).
					Str("configmap", cm.GetName()).
					Str("key", key).
					Msg("invalid policy declaration YAML")
				continue
			}
			if name == "" {
				s.logger.Warn().
					Str("namespace", namespace).
					Str("configmap", cm.GetName()).
					Str("key", key).
					Msg("policy declaration missing required 'name' field")
				continue
			}

			declared[name] = true
			if upsertErr := s.upsertPolicy(ctx, sdk, projectID, namespace, name, spec); upsertErr != nil {
				s.logger.Warn().Err(upsertErr).
					Str("namespace", namespace).
					Str("policy", name).
					Msg("failed to upsert policy from configmap")
			}
		}
	}

	s.pruneRemovedPolicies(ctx, sdk, projectID, namespace, declared)
}

func parsePolicyDeclaration(yamlStr string) (name string, spec map[string]interface{}, err error) {
	var raw map[string]interface{}
	if err := yaml.Unmarshal([]byte(yamlStr), &raw); err != nil {
		return "", nil, fmt.Errorf("parsing policy YAML: %w", err)
	}

	if nameVal, ok := raw["name"]; ok {
		if nameStr, isStr := nameVal.(string); isStr {
			name = nameStr
		}
		delete(raw, "name")
	}

	return name, raw, nil
}

func (s *ConfigMapSyncer) upsertPolicy(ctx context.Context, sdk *sdkclient.Client, projectID, namespace, name string, spec map[string]interface{}) error {
	existing := s.findPolicyByName(ctx, sdk, projectID, name)

	annJSON, err := s.buildOriginAnnotations(namespace, nil)
	if err != nil {
		return err
	}

	patch := map[string]interface{}{
		"annotations": annJSON,
		"spec":        spec,
	}

	if existing != nil {
		if _, updateErr := sdk.Policys().Update(ctx, existing.ID, patch); updateErr != nil {
			return fmt.Errorf("updating policy %s: %w", name, updateErr)
		}
		s.logger.Debug().Str("policy", name).Str("id", existing.ID).Msg("policy updated from configmap")
		return nil
	}

	policy, err := types.NewPolicyBuilder().
		Name(name).
		ProjectID(projectID).
		Namespace(namespace).
		Build()
	if err != nil {
		return fmt.Errorf("building policy %s: %w", name, err)
	}

	created, createErr := sdk.Policys().Create(ctx, policy)
	if createErr != nil {
		return fmt.Errorf("creating policy %s: %w", name, createErr)
	}
	if _, updateErr := sdk.Policys().Update(ctx, created.ID, patch); updateErr != nil {
		return fmt.Errorf("updating newly created policy %s: %w", name, updateErr)
	}
	s.logger.Info().Str("policy", name).Str("id", created.ID).Msg("policy created from configmap")
	return nil
}

func (s *ConfigMapSyncer) findPolicyByName(ctx context.Context, sdk *sdkclient.Client, projectID, name string) *types.Policy {
	escapedName := strings.ReplaceAll(name, "'", "''")
	escapedProjectID := strings.ReplaceAll(projectID, "'", "''")
	policies, err := sdk.Policys().List(ctx, &types.ListOptions{
		Size:   1,
		Search: fmt.Sprintf("name = '%s' AND project_id = '%s'", escapedName, escapedProjectID),
	})
	if err != nil {
		s.logger.Warn().Err(err).Str("name", name).Str("project_id", projectID).Msg("failed to search for existing policy")
		return nil
	}
	for _, p := range policies.Items {
		if p.Name == name && p.ProjectID == projectID {
			return &p
		}
	}
	return nil
}

func (s *ConfigMapSyncer) pruneRemovedPolicies(ctx context.Context, sdk *sdkclient.Client, projectID, namespace string, declared map[string]bool) {
	escapedProjectID := strings.ReplaceAll(projectID, "'", "''")
	policies, err := sdk.Policys().List(ctx, &types.ListOptions{
		Size:   500,
		Search: fmt.Sprintf("project_id = '%s'", escapedProjectID),
	})
	if err != nil {
		s.logger.Warn().Err(err).Str("project_id", projectID).Msg("failed to list policies for pruning")
		return
	}

	for _, p := range policies.Items {
		if s.isConfigMapManaged(p.Annotations, namespace) && !declared[p.Name] {
			if deleteErr := sdk.Policys().Delete(ctx, p.ID); deleteErr != nil {
				s.logger.Warn().Err(deleteErr).Str("policy", p.Name).Msg("failed to delete stale policy")
			} else {
				s.logger.Info().Str("policy", p.Name).Str("id", p.ID).Msg("pruned policy no longer declared in configmaps")
			}
		}
	}
}
