package applications

import (
	"net/http"

	"github.com/gorilla/mux"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/api/openapi"
	pkgrbac "github.com/ambient-code/platform/components/ambient-api-server/pkg/rbac"
	"github.com/openshift-online/rh-trex-ai/pkg/api/presenters"
	"github.com/openshift-online/rh-trex-ai/pkg/errors"
	"github.com/openshift-online/rh-trex-ai/pkg/handlers"
	"github.com/openshift-online/rh-trex-ai/pkg/services"
)

var _ handlers.RestHandler = applicationHandler{}

type applicationHandler struct {
	application ApplicationService
	generic     services.GenericService
}

func NewApplicationHandler(application ApplicationService, generic services.GenericService) *applicationHandler {
	return &applicationHandler{
		application: application,
		generic:     generic,
	}
}

func (h applicationHandler) Create(w http.ResponseWriter, r *http.Request) {
	var app openapi.Application
	cfg := &handlers.HandlerConfig{
		Body: &app,
		Validators: []handlers.Validate{
			handlers.ValidateEmpty(&app, "Id", "id"),
		},
		Action: func() (interface{}, *errors.ServiceError) {
			ctx := r.Context()
			model := ConvertApplication(app)
			model, err := h.application.Create(ctx, model)
			if err != nil {
				return nil, err
			}
			return PresentApplication(model), nil
		},
		ErrorHandler: handlers.HandleError,
	}

	handlers.Handle(w, r, cfg, http.StatusCreated)
}

func (h applicationHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var patch openapi.ApplicationPatchRequest

	cfg := &handlers.HandlerConfig{
		Body:       &patch,
		Validators: []handlers.Validate{},
		Action: func() (interface{}, *errors.ServiceError) {
			ctx := r.Context()
			id := mux.Vars(r)["app_id"]
			found, err := h.application.Get(ctx, id)
			if err != nil {
				return nil, err
			}

			if patch.Name != nil {
				found.Name = *patch.Name
			}
			if patch.SourceRepoUrl != nil {
				found.SourceRepoUrl = *patch.SourceRepoUrl
			}
			if patch.SourceTargetRevision != nil {
				found.SourceTargetRevision = patch.SourceTargetRevision
			}
			if patch.SourcePath != nil {
				found.SourcePath = *patch.SourcePath
			}
			if patch.DestinationAmbientUrl != nil {
				found.DestinationAmbientUrl = patch.DestinationAmbientUrl
			}
			if patch.DestinationProject != nil {
				found.DestinationProject = *patch.DestinationProject
			}
			if patch.CredentialId != nil {
				found.CredentialId = patch.CredentialId
			}
			if patch.AutoSync != nil {
				found.AutoSync = patch.AutoSync
			}
			if patch.AutoPrune != nil {
				found.AutoPrune = patch.AutoPrune
			}
			if patch.SelfHeal != nil {
				found.SelfHeal = patch.SelfHeal
			}
			if patch.SyncOptions != nil {
				found.SyncOptions = patch.SyncOptions
			}
			if patch.RetryLimit != nil {
				found.RetryLimit = patch.RetryLimit
			}
			if patch.Labels != nil {
				found.Labels = patch.Labels
			}
			if patch.Annotations != nil {
				found.Annotations = patch.Annotations
			}

			model, err := h.application.Replace(ctx, found)
			if err != nil {
				return nil, err
			}
			return PresentApplication(model), nil
		},
		ErrorHandler: handlers.HandleError,
	}

	handlers.Handle(w, r, cfg, http.StatusOK)
}

func (h applicationHandler) List(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			ctx := r.Context()
			listArgs := services.NewListArguments(r.URL.Query())
			if !pkgrbac.ApplyListFilter(ctx, listArgs, "id", true) {
				return openapi.ApplicationList{Kind: "ApplicationList", Page: 1, Size: 0, Total: 0, Items: []openapi.Application{}}, nil
			}
			var apps []Application
			paging, err := h.generic.List(ctx, "id", listArgs, &apps)
			if err != nil {
				return nil, err
			}
			appList := openapi.ApplicationList{
				Kind:  "ApplicationList",
				Page:  int32(paging.Page),
				Size:  int32(paging.Size),
				Total: int32(paging.Total),
				Items: []openapi.Application{},
			}

			for _, a := range apps {
				converted := PresentApplication(&a)
				appList.Items = append(appList.Items, converted)
			}
			if listArgs.Fields != nil {
				filteredItems, err := presenters.SliceFilter(listArgs.Fields, appList.Items)
				if err != nil {
					return nil, err
				}
				return filteredItems, nil
			}
			return appList, nil
		},
	}

	handlers.HandleList(w, r, cfg)
}

func (h applicationHandler) Get(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			id := mux.Vars(r)["app_id"]
			ctx := r.Context()
			app, err := h.application.Get(ctx, id)
			if err != nil {
				return nil, err
			}
			return PresentApplication(app), nil
		},
	}

	handlers.HandleGet(w, r, cfg)
}

func (h applicationHandler) Delete(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			id := mux.Vars(r)["app_id"]
			ctx := r.Context()
			err := h.application.Delete(ctx, id)
			if err != nil {
				return nil, err
			}
			return nil, nil
		},
	}
	handlers.HandleDelete(w, r, cfg, http.StatusNoContent)
}

func (h applicationHandler) Sync(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			id := mux.Vars(r)["app_id"]
			ctx := r.Context()
			app, err := h.application.Get(ctx, id)
			if err != nil {
				return nil, err
			}
			running := "Running"
			app.OperationPhase = &running
			app, err = h.application.Replace(ctx, app)
			if err != nil {
				return nil, err
			}
			return PresentApplication(app), nil
		},
	}
	handlers.HandleGet(w, r, cfg)
}

func (h applicationHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			id := mux.Vars(r)["app_id"]
			ctx := r.Context()
			app, err := h.application.Get(ctx, id)
			if err != nil {
				return nil, err
			}
			return PresentApplicationStatus(app), nil
		},
	}
	handlers.HandleGet(w, r, cfg)
}

func (h applicationHandler) Refresh(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			id := mux.Vars(r)["app_id"]
			ctx := r.Context()
			app, err := h.application.Get(ctx, id)
			if err != nil {
				return nil, err
			}
			return PresentApplication(app), nil
		},
	}

	handlers.HandleGet(w, r, cfg)
}
