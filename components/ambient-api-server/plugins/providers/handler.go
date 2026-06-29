package providers

import (
	"net/http"

	"github.com/gorilla/mux"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/api/openapi"
	"github.com/openshift-online/rh-trex-ai/pkg/errors"
	"github.com/openshift-online/rh-trex-ai/pkg/handlers"
	"github.com/openshift-online/rh-trex-ai/pkg/services"
)

type providerHandler struct {
	provider ProviderService
	generic  services.GenericService
}

func NewProviderHandler(provider ProviderService, generic services.GenericService) *providerHandler {
	return &providerHandler{
		provider: provider,
		generic:  generic,
	}
}

func (h providerHandler) Create(w http.ResponseWriter, r *http.Request) {
	var provider openapi.Provider
	cfg := &handlers.HandlerConfig{
		Body: &provider,
		Validators: []handlers.Validate{
			handlers.ValidateEmpty(&provider, "Id", "id"),
		},
		Action: func() (interface{}, *errors.ServiceError) {
			ctx := r.Context()
			projectID := mux.Vars(r)["id"]
			model := ConvertProvider(provider)
			model.ProjectId = projectID
			model, err := h.provider.Create(ctx, model)
			if err != nil {
				return nil, err
			}
			return PresentProvider(model), nil
		},
		ErrorHandler: handlers.HandleError,
	}
	handlers.Handle(w, r, cfg, http.StatusCreated)
}

func (h providerHandler) List(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			ctx := r.Context()
			projectID := mux.Vars(r)["id"]

			listArgs := services.NewListArguments(r.URL.Query())
			projectFilter := "project_id = '" + projectID + "'"
			if listArgs.Search != "" {
				listArgs.Search = projectFilter + " and (" + listArgs.Search + ")"
			} else {
				listArgs.Search = projectFilter
			}

			var providers []Provider
			paging, err := h.generic.List(ctx, "id", listArgs, &providers)
			if err != nil {
				return nil, err
			}

			providerList := openapi.ProviderList{
				Kind:  "ProviderList",
				Page:  int32(paging.Page),
				Size:  int32(paging.Size),
				Total: int32(paging.Total),
				Items: []openapi.Provider{},
			}

			for _, p := range providers {
				providerList.Items = append(providerList.Items, PresentProvider(&p))
			}
			return providerList, nil
		},
	}
	handlers.HandleList(w, r, cfg)
}

func (h providerHandler) Get(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			projectID := mux.Vars(r)["id"]
			id := mux.Vars(r)["provider_id"]
			ctx := r.Context()
			provider, err := h.provider.Get(ctx, id)
			if err != nil {
				return nil, err
			}
			if provider.ProjectId != projectID {
				return nil, errors.Forbidden("provider does not belong to this project")
			}
			return PresentProvider(provider), nil
		},
	}
	handlers.HandleGet(w, r, cfg)
}

func (h providerHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var patch openapi.ProviderPatchRequest
	cfg := &handlers.HandlerConfig{
		Body:       &patch,
		Validators: []handlers.Validate{},
		Action: func() (interface{}, *errors.ServiceError) {
			ctx := r.Context()
			projectID := mux.Vars(r)["id"]
			id := mux.Vars(r)["provider_id"]
			found, err := h.provider.Get(ctx, id)
			if err != nil {
				return nil, err
			}
			if found.ProjectId != projectID {
				return nil, errors.Forbidden("provider does not belong to this project")
			}

			if patch.Name != nil {
				found.Name = *patch.Name
			}
			if patch.Type != nil {
				found.Type = patch.Type
			}
			if patch.Secret != nil {
				found.Secret = patch.Secret
			}
			if patch.Namespace != nil {
				found.Namespace = patch.Namespace
			}
			if patch.Labels != nil {
				found.Labels = patch.Labels
			}
			if patch.Annotations != nil {
				found.Annotations = patch.Annotations
			}

			model, err := h.provider.Replace(ctx, found)
			if err != nil {
				return nil, err
			}
			return PresentProvider(model), nil
		},
		ErrorHandler: handlers.HandleError,
	}
	handlers.Handle(w, r, cfg, http.StatusOK)
}

func (h providerHandler) Delete(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			projectID := mux.Vars(r)["id"]
			id := mux.Vars(r)["provider_id"]
			ctx := r.Context()
			provider, getErr := h.provider.Get(ctx, id)
			if getErr != nil {
				return nil, getErr
			}
			if provider.ProjectId != projectID {
				return nil, errors.Forbidden("provider does not belong to this project")
			}
			err := h.provider.Delete(ctx, id)
			if err != nil {
				return nil, err
			}
			return nil, nil
		},
	}
	handlers.HandleDelete(w, r, cfg, http.StatusNoContent)
}
