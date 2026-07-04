package applications

import (
	"github.com/ambient-code/platform/components/ambient-api-server/pkg/api/openapi"
	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/api/presenters"
	"github.com/openshift-online/rh-trex-ai/pkg/util"
)

func ConvertApplication(app openapi.Application) *Application {
	a := &Application{
		Meta: api.Meta{
			ID: util.NilToEmptyString(app.Id),
		},
	}
	a.Name = app.Name
	a.SourceRepoUrl = app.SourceRepoUrl
	a.SourceTargetRevision = app.SourceTargetRevision
	a.SourcePath = app.SourcePath
	a.DestinationAmbientUrl = app.DestinationAmbientUrl
	a.DestinationProject = app.DestinationProject
	a.CredentialId = app.CredentialId
	a.AutoSync = app.AutoSync
	a.AutoPrune = app.AutoPrune
	a.SelfHeal = app.SelfHeal
	a.SyncOptions = app.SyncOptions
	a.RetryLimit = app.RetryLimit
	a.Labels = app.Labels
	a.Annotations = app.Annotations

	if app.CreatedAt != nil {
		a.CreatedAt = *app.CreatedAt
	}
	if app.UpdatedAt != nil {
		a.UpdatedAt = *app.UpdatedAt
	}

	return a
}

func PresentApplication(app *Application) openapi.Application {
	reference := presenters.PresentReference(app.ID, app)
	return openapi.Application{
		Id:                    reference.Id,
		Kind:                  reference.Kind,
		Href:                  reference.Href,
		CreatedAt:             openapi.PtrTime(app.CreatedAt),
		UpdatedAt:             openapi.PtrTime(app.UpdatedAt),
		Name:                  app.Name,
		SourceRepoUrl:         app.SourceRepoUrl,
		SourceTargetRevision:  app.SourceTargetRevision,
		SourcePath:            app.SourcePath,
		DestinationAmbientUrl: app.DestinationAmbientUrl,
		DestinationProject:    app.DestinationProject,
		CredentialId:          app.CredentialId,
		AutoSync:              app.AutoSync,
		AutoPrune:             app.AutoPrune,
		SelfHeal:              app.SelfHeal,
		SyncOptions:           app.SyncOptions,
		RetryLimit:            app.RetryLimit,
		SyncStatus:            app.SyncStatus,
		HealthStatus:          app.HealthStatus,
		SyncRevision:          app.SyncRevision,
		OperationPhase:        app.OperationPhase,
		OperationMessage:      app.OperationMessage,
		ResourceStatus:        app.ResourceStatus,
		Conditions:            app.Conditions,
		Labels:                app.Labels,
		Annotations:           app.Annotations,
	}
}
