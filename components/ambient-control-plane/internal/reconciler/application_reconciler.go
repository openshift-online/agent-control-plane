package reconciler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	sdkclient "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/client"
	"github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
	"github.com/rs/zerolog"
	"gopkg.in/yaml.v3"
)

const (
	applicationSyncInterval = 30 * time.Second

	platformProject = "_platform"

	syncStatusSynced     = "Synced"
	syncStatusOutOfSync  = "OutOfSync"
	healthStatusHealthy  = "Healthy"
	healthStatusDegraded = "Degraded"
	opPhaseSucceeded     = "Succeeded"
	opPhaseFailed        = "Failed"
	opPhaseRunning       = "Running"

	hashErrorSentinel = "<hash-error>"

	annotationSourceApplication = "application"
)

type GitFetcher interface {
	FetchDeclarations(repoURL, path, targetRevision string) ([]gitAgentDeclaration, string, error)
}

type ApplicationReconciler struct {
	factory    *SDKClientFactory
	logger     zerolog.Logger
	gitFetcher GitFetcher
}

func NewApplicationReconciler(factory *SDKClientFactory, logger zerolog.Logger) *ApplicationReconciler {
	return &ApplicationReconciler{
		factory:    factory,
		logger:     logger.With().Str("component", "application-reconciler").Logger(),
		gitFetcher: &execGitFetcher{},
	}
}

func (r *ApplicationReconciler) Run(ctx context.Context) error {
	r.logger.Info().Dur("interval", applicationSyncInterval).Msg("application reconciler started")
	ticker := time.NewTicker(applicationSyncInterval)
	defer ticker.Stop()

	r.reconcileOnce(ctx)

	for {
		select {
		case <-ctx.Done():
			r.logger.Info().Msg("application reconciler stopped")
			return ctx.Err()
		case <-ticker.C:
			r.reconcileOnce(ctx)
		}
	}
}

func (r *ApplicationReconciler) reconcileOnce(ctx context.Context) {
	platformClient, err := r.factory.ForProject(ctx, platformProject)
	if err != nil {
		r.logger.Error().Err(err).Msg("failed to create platform-scoped SDK client")
		return
	}

	apps, err := r.listAllApplications(ctx, platformClient)
	if err != nil {
		r.logger.Error().Err(err).Msg("failed to list applications")
		return
	}

	r.logger.Debug().Int("count", len(apps)).Msg("reconciling applications")

	for i := range apps {
		app := &apps[i]
		if err := r.reconcileApplication(ctx, platformClient, app); err != nil {
			r.logger.Error().Err(err).Str("application_id", app.ID).Str("name", app.Name).Msg("failed to reconcile application")
		}
	}
}

func (r *ApplicationReconciler) listAllApplications(ctx context.Context, client *sdkclient.Client) ([]types.Application, error) {
	var all []types.Application
	page := 1
	for {
		opts := types.NewListOptions().Page(page).Size(100).Build()
		list, err := client.Applications().List(ctx, opts)
		if err != nil {
			return nil, fmt.Errorf("list applications page %d: %w", page, err)
		}
		all = append(all, list.Items...)
		if len(all) >= list.Total || len(list.Items) == 0 {
			break
		}
		page++
	}
	return all, nil
}

func (r *ApplicationReconciler) reconcileApplication(ctx context.Context, client *sdkclient.Client, app *types.Application) error {
	if app.OperationPhase != opPhaseRunning {
		return nil
	}

	r.logger.Info().Str("application_id", app.ID).Str("name", app.Name).Str("repo", app.SourceRepoURL).Msg("syncing application")

	declarations, revision, err := r.fetchDeclarations(app)
	if err != nil {
		return r.updateApplicationStatus(ctx, client, app, syncStatusOutOfSync, healthStatusDegraded, opPhaseFailed, fmt.Sprintf("fetch failed: %v", err), "")
	}

	if err := r.applyDeclarations(ctx, app, declarations); err != nil {
		return r.updateApplicationStatus(ctx, client, app, syncStatusOutOfSync, healthStatusDegraded, opPhaseFailed, fmt.Sprintf("apply failed: %v", err), revision)
	}

	return r.updateApplicationStatus(ctx, client, app, syncStatusSynced, healthStatusHealthy, opPhaseSucceeded, "sync completed", revision)
}

type applicationStatusPatch struct {
	SyncStatus       string `json:"sync_status"`
	HealthStatus     string `json:"health_status"`
	OperationPhase   string `json:"operation_phase"`
	OperationMessage string `json:"operation_message"`
	LastSyncedAt     string `json:"last_synced_at"`
	SyncRevision     string `json:"sync_revision,omitempty"`
}

func (r *ApplicationReconciler) updateApplicationStatus(ctx context.Context, client *sdkclient.Client, app *types.Application, syncStatus, healthStatus, opPhase, opMessage, revision string) error {
	statusUpdate := applicationStatusPatch{
		SyncStatus:       syncStatus,
		HealthStatus:     healthStatus,
		OperationPhase:   opPhase,
		OperationMessage: opMessage,
		LastSyncedAt:     time.Now().UTC().Format(time.RFC3339),
		SyncRevision:     revision,
	}

	raw, err := json.Marshal(statusUpdate)
	if err != nil {
		return fmt.Errorf("marshal status patch: %w", err)
	}
	var patch map[string]interface{}
	if err := json.Unmarshal(raw, &patch); err != nil {
		return fmt.Errorf("unmarshal status patch: %w", err)
	}

	_, err = client.Applications().Update(ctx, app.ID, patch)
	if err != nil {
		r.logger.Error().Err(err).Str("application_id", app.ID).Msg("failed to update application status")
	}
	return err
}

type gitAgentDeclaration struct {
	Name        string            `yaml:"name" json:"name"`
	DisplayName string            `yaml:"display_name,omitempty" json:"display_name,omitempty"`
	Description string            `yaml:"description,omitempty" json:"description,omitempty"`
	Prompt      string            `yaml:"prompt,omitempty" json:"prompt,omitempty"`
	Entrypoint  string            `yaml:"entrypoint,omitempty" json:"entrypoint,omitempty"`
	Providers   []string          `yaml:"providers,omitempty" json:"providers,omitempty"`
	Environment map[string]string `yaml:"environment,omitempty" json:"environment,omitempty"`
	RepoURL     string            `yaml:"repo_url,omitempty" json:"repo_url,omitempty"`
	LlmModel    string            `yaml:"llm_model,omitempty" json:"llm_model,omitempty"`
	Labels      map[string]string `yaml:"labels,omitempty" json:"labels,omitempty"`
	Annotations map[string]string `yaml:"annotations,omitempty" json:"annotations,omitempty"`
}

func (r *ApplicationReconciler) fetchDeclarations(app *types.Application) ([]gitAgentDeclaration, string, error) {
	r.logger.Debug().
		Str("repo", app.SourceRepoURL).
		Str("path", app.SourcePath).
		Str("revision", app.SourceTargetRevision).
		Msg("fetching declarations from git")

	return r.gitFetcher.FetchDeclarations(app.SourceRepoURL, app.SourcePath, app.SourceTargetRevision)
}

func (r *ApplicationReconciler) applyDeclarations(ctx context.Context, app *types.Application, declarations []gitAgentDeclaration) error {
	if len(declarations) == 0 {
		r.logger.Debug().Str("application_id", app.ID).Msg("no declarations to apply")
		return nil
	}

	client, err := r.factory.ForProject(ctx, app.DestinationProject)
	if err != nil {
		return fmt.Errorf("create SDK client for project %s: %w", app.DestinationProject, err)
	}

	existingAgents, err := r.listAllAgents(ctx, client)
	if err != nil {
		return fmt.Errorf("list existing agents in project %s: %w", app.DestinationProject, err)
	}

	agentsByName := make(map[string]types.Agent, len(existingAgents))
	for _, a := range existingAgents {
		agentsByName[a.Name] = a
	}

	declaredNames := make(map[string]bool, len(declarations))

	var resourceStatus []map[string]string
	for _, decl := range declarations {
		declaredNames[decl.Name] = true
		hash := appContentHash(decl)

		existing, found := agentsByName[decl.Name]
		if found && r.isApplicationManaged(existing.Annotations) {
			existingHash := extractContentHash(existing.Annotations)
			if existingHash == hash {
				r.logger.Debug().Str("agent", decl.Name).Msg("agent unchanged, skipping update")
				resourceStatus = append(resourceStatus, map[string]string{
					"name":   decl.Name,
					"status": "Synced",
				})
				continue
			}

			patch := r.buildAgentPatch(decl, hash)
			if _, updateErr := client.Agents().Update(ctx, existing.ID, patch); updateErr != nil {
				return fmt.Errorf("update agent %s: %w", decl.Name, updateErr)
			}
			r.logger.Info().Str("agent", decl.Name).Str("id", existing.ID).Msg("agent updated from application")
			resourceStatus = append(resourceStatus, map[string]string{
				"name":   decl.Name,
				"status": "Synced",
			})
			continue
		}

		if !found {
			agent := r.buildAgentResource(decl, app.DestinationProject, hash)
			if _, createErr := client.Agents().Create(ctx, agent); createErr != nil {
				return fmt.Errorf("create agent %s: %w", decl.Name, createErr)
			}
			r.logger.Info().Str("agent", decl.Name).Msg("agent created from application")
			resourceStatus = append(resourceStatus, map[string]string{
				"name":   decl.Name,
				"status": "Synced",
			})
			continue
		}

		r.logger.Debug().Str("agent", decl.Name).Msg("agent exists but not application-managed, skipping")
		resourceStatus = append(resourceStatus, map[string]string{
			"name":   decl.Name,
			"status": "Skipped",
		})
	}

	if app.AutoPrune {
		for _, existing := range existingAgents {
			if !declaredNames[existing.Name] && r.isApplicationManaged(existing.Annotations) {
				if deleteErr := client.Agents().Delete(ctx, existing.ID); deleteErr != nil {
					r.logger.Warn().Err(deleteErr).Str("agent", existing.Name).Msg("failed to delete pruned agent")
				} else {
					r.logger.Info().Str("agent", existing.Name).Str("id", existing.ID).Msg("pruned agent no longer declared in application")
				}
			}
		}
	}

	if len(resourceStatus) > 0 {
		statusJSON, _ := json.Marshal(resourceStatus)
		r.logger.Debug().RawJSON("resource_status", statusJSON).Msg("resource sync status")
	}

	return nil
}

func (r *ApplicationReconciler) listAllAgents(ctx context.Context, client *sdkclient.Client) ([]types.Agent, error) {
	var all []types.Agent
	page := 1
	for {
		opts := types.NewListOptions().Page(page).Size(100).Build()
		list, err := client.Agents().List(ctx, opts)
		if err != nil {
			return nil, fmt.Errorf("list agents page %d: %w", page, err)
		}
		all = append(all, list.Items...)
		if len(all) >= list.Total || len(list.Items) == 0 {
			break
		}
		page++
	}
	return all, nil
}

func (r *ApplicationReconciler) isApplicationManaged(annotationsJSON string) bool {
	if annotationsJSON == "" {
		return false
	}
	var ann map[string]string
	if err := json.Unmarshal([]byte(annotationsJSON), &ann); err != nil {
		return false
	}
	return ann[annotationSource] == annotationSourceApplication
}

func (r *ApplicationReconciler) buildAgentPatch(decl gitAgentDeclaration, contentHash string) map[string]interface{} {
	annotations := make(map[string]string)
	for k, v := range decl.Annotations {
		annotations[k] = v
	}
	annotations[annotationSource] = annotationSourceApplication
	annotations[annotationContentHash] = contentHash
	annJSON, _ := json.Marshal(annotations)

	patch := map[string]interface{}{
		"annotations": string(annJSON),
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
	if decl.Entrypoint != "" {
		patch["entrypoint"] = decl.Entrypoint
	}
	if decl.RepoURL != "" {
		patch["repo_url"] = decl.RepoURL
	}
	if decl.LlmModel != "" {
		patch["llm_model"] = decl.LlmModel
	}
	if len(decl.Providers) > 0 {
		patch["providers"] = decl.Providers
	}
	if len(decl.Environment) > 0 {
		patch["environment"] = decl.Environment
	}
	if len(decl.Labels) > 0 {
		labelsJSON, _ := json.Marshal(decl.Labels)
		patch["labels"] = string(labelsJSON)
	}
	return patch
}

func (r *ApplicationReconciler) buildAgentResource(decl gitAgentDeclaration, projectID, contentHash string) *types.Agent {
	annotations := make(map[string]string)
	for k, v := range decl.Annotations {
		annotations[k] = v
	}
	annotations[annotationSource] = annotationSourceApplication
	annotations[annotationContentHash] = contentHash
	annJSON, _ := json.Marshal(annotations)

	return &types.Agent{
		Name:        decl.Name,
		ProjectID:   projectID,
		DisplayName: decl.DisplayName,
		Description: decl.Description,
		Prompt:      decl.Prompt,
		Entrypoint:  decl.Entrypoint,
		Providers:   decl.Providers,
		Environment: decl.Environment,
		RepoURL:     decl.RepoURL,
		LlmModel:    decl.LlmModel,
		Annotations: string(annJSON),
		Labels:      marshalStringMap(decl.Labels),
	}
}

func marshalStringMap(m map[string]string) string {
	if len(m) == 0 {
		return ""
	}
	data, _ := json.Marshal(m)
	return string(data)
}

func appContentHash(v interface{}) string {
	data, err := yaml.Marshal(v)
	if err != nil {
		return hashErrorSentinel
	}
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

type execGitFetcher struct{}

func (f *execGitFetcher) FetchDeclarations(repoURL, path, targetRevision string) ([]gitAgentDeclaration, string, error) {
	tmpDir, err := os.MkdirTemp("", "app-reconciler-*")
	if err != nil {
		return nil, "", fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	cloneArgs := []string{"clone", "--depth=1"}
	if targetRevision != "" {
		cloneArgs = append(cloneArgs, "--branch", targetRevision)
	}
	cloneArgs = append(cloneArgs, repoURL, tmpDir)

	cmd := exec.Command("git", cloneArgs...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		return nil, "", fmt.Errorf("git clone %s: %s: %w", repoURL, strings.TrimSpace(string(out)), err)
	}

	revision, err := resolveGitRevision(tmpDir)
	if err != nil {
		return nil, "", fmt.Errorf("resolve revision: %w", err)
	}

	declPath := filepath.Join(tmpDir, path)
	declarations, err := parseDeclarationsFromDir(declPath)
	if err != nil {
		return nil, "", fmt.Errorf("parse declarations from %s: %w", path, err)
	}

	return declarations, revision, nil
}

func resolveGitRevision(repoDir string) (string, error) {
	cmd := exec.Command("git", "-C", repoDir, "rev-parse", "HEAD")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git rev-parse HEAD: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}

func parseDeclarationsFromDir(dir string) ([]gitAgentDeclaration, error) {
	var declarations []gitAgentDeclaration

	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}

		ext := strings.ToLower(filepath.Ext(path))
		if ext != ".yaml" && ext != ".yml" {
			return nil
		}

		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return fmt.Errorf("read %s: %w", path, readErr)
		}

		var decl gitAgentDeclaration
		if yamlErr := yaml.Unmarshal(data, &decl); yamlErr != nil {
			return fmt.Errorf("parse %s: %w", filepath.Base(path), yamlErr)
		}

		if decl.Name == "" {
			return nil
		}

		declarations = append(declarations, decl)
		return nil
	})
	if err != nil {
		return nil, err
	}

	return declarations, nil
}
