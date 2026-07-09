package providers

import (
	"net/http"
	"regexp"

	"github.com/gorilla/mux"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/api/openapi"
	"github.com/ambient-code/platform/components/ambient-api-server/pkg/gateway"
	pkgrbac "github.com/ambient-code/platform/components/ambient-api-server/pkg/rbac"
	"github.com/openshift-online/rh-trex-ai/pkg/errors"
	"github.com/openshift-online/rh-trex-ai/pkg/handlers"
	"github.com/openshift-online/rh-trex-ai/pkg/services"
)

var validIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_\-]+$`)

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
			if !validIDPattern.MatchString(projectID) {
				return nil, errors.Validation("invalid project id")
			}
			if err := gateway.CheckEditorTier(ctx, projectID); err != nil {
				return nil, err
			}
			model := ConvertProvider(provider)
			model.ProjectId = projectID
			model, svcErr := h.provider.Create(ctx, model)
			if svcErr != nil {
				return nil, svcErr
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

			if !validIDPattern.MatchString(projectID) {
				return nil, errors.Validation("invalid project id")
			}

			listArgs := services.NewListArguments(r.URL.Query())
			projectFilter, filterErr := pkgrbac.TSLEqual("project_id", projectID)
			if filterErr != nil {
				return nil, errors.Validation("invalid project_id format")
			}
			pkgrbac.PrependTSLFilter(listArgs, projectFilter)
			if !pkgrbac.ApplyListFilter(ctx, listArgs, "project_id", false) {
				return openapi.ProviderList{Kind: "ProviderList", Page: 1, Size: 0, Total: 0, Items: []openapi.Provider{}}, nil
			}

			var providers []Provider
			paging, svcErr := h.generic.List(ctx, "id", listArgs, &providers)
			if svcErr != nil {
				return nil, svcErr
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
			if !validIDPattern.MatchString(projectID) || !validIDPattern.MatchString(id) {
				return nil, errors.Validation("invalid project or provider id")
			}
			ctx := r.Context()
			provider, svcErr := h.provider.Get(ctx, id)
			if svcErr != nil {
				return nil, svcErr
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
			if !validIDPattern.MatchString(projectID) || !validIDPattern.MatchString(id) {
				return nil, errors.Validation("invalid project or provider id")
			}
			if err := gateway.CheckEditorTier(ctx, projectID); err != nil {
				return nil, err
			}
			found, svcErr := h.provider.Get(ctx, id)
			if svcErr != nil {
				return nil, svcErr
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

			model, svcErr := h.provider.Replace(ctx, found)
			if svcErr != nil {
				return nil, svcErr
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
			if !validIDPattern.MatchString(projectID) || !validIDPattern.MatchString(id) {
				return nil, errors.Validation("invalid project or provider id")
			}
			ctx := r.Context()
			if err := gateway.CheckEditorTier(ctx, projectID); err != nil {
				return nil, err
			}
			provider, svcErr := h.provider.Get(ctx, id)
			if svcErr != nil {
				return nil, svcErr
			}
			if provider.ProjectId != projectID {
				return nil, errors.Forbidden("provider does not belong to this project")
			}
			svcErr = h.provider.Delete(ctx, id)
			if svcErr != nil {
				return nil, svcErr
			}
			return nil, nil
		},
	}
	handlers.HandleDelete(w, r, cfg, http.StatusNoContent)
}
