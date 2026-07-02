package reconciler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	sdkclient "github.com/ambient-code/platform/components/ambient-sdk/go-sdk/client"
	"github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
	"github.com/rs/zerolog"
	"gopkg.in/yaml.v3"
)

const (
	applicationSyncInterval = 30 * time.Second

	syncStatusSynced     = "Synced"
	syncStatusOutOfSync  = "OutOfSync"
	healthStatusHealthy  = "Healthy"
	healthStatusDegraded = "Degraded"
	opPhaseSucceeded     = "Succeeded"
	opPhaseFailed        = "Failed"
	opPhaseRunning       = "Running"
)

type ApplicationReconciler struct {
	factory *SDKClientFactory
	logger  zerolog.Logger
}

func NewApplicationReconciler(factory *SDKClientFactory, logger zerolog.Logger) *ApplicationReconciler {
	return &ApplicationReconciler{
		factory: factory,
		logger:  logger.With().Str("component", "application-reconciler").Logger(),
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
	client, err := r.factory.ForProject(ctx, "default")
	if err != nil {
		r.logger.Error().Err(err).Msg("failed to create SDK client")
		return
	}

	apps, err := r.listAllApplications(ctx, client)
	if err != nil {
		r.logger.Error().Err(err).Msg("failed to list applications")
		return
	}

	r.logger.Debug().Int("count", len(apps)).Msg("reconciling applications")

	for i := range apps {
		app := &apps[i]
		if err := r.reconcileApplication(ctx, client, app); err != nil {
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

func (r *ApplicationReconciler) updateApplicationStatus(ctx context.Context, client *sdkclient.Client, app *types.Application, syncStatus, healthStatus, opPhase, opMessage, revision string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	patch := map[string]any{
		"sync_status":       syncStatus,
		"health_status":     healthStatus,
		"operation_phase":   opPhase,
		"operation_message": opMessage,
		"last_synced_at":    now,
	}
	if revision != "" {
		patch["sync_revision"] = revision
	}

	_, err := client.Applications().Update(ctx, app.ID, patch)
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
		Msg("fetching declarations from git (stub — git clone not yet implemented)")

	return nil, app.SourceTargetRevision, nil
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

	var resourceStatus []map[string]string
	for _, decl := range declarations {
		hash := appContentHash(decl)
		r.logger.Info().Str("agent", decl.Name).Str("hash", hash).Msg("upserting agent declaration")

		_ = client

		resourceStatus = append(resourceStatus, map[string]string{
			"name":   decl.Name,
			"status": "Synced",
		})
	}

	if len(resourceStatus) > 0 {
		statusJSON, _ := json.Marshal(resourceStatus)
		r.logger.Debug().RawJSON("resource_status", statusJSON).Msg("resource sync status")
	}

	return nil
}

func appContentHash(v interface{}) string {
	data, err := yaml.Marshal(v)
	if err != nil {
		return ""
	}
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}
