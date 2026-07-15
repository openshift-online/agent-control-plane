package clusters

import (
	"net/http"
	"regexp"
	"time"

	"github.com/gorilla/mux"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/api/openapi"
	"github.com/openshift-online/rh-trex-ai/pkg/api/presenters"
	"github.com/openshift-online/rh-trex-ai/pkg/errors"
	"github.com/openshift-online/rh-trex-ai/pkg/handlers"
	"github.com/openshift-online/rh-trex-ai/pkg/services"
)

var validIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_\-]+$`)

type clusterHandler struct {
	cluster ClusterService
	generic services.GenericService
}

func NewClusterHandler(svc ClusterService, generic services.GenericService) *clusterHandler {
	return &clusterHandler{
		cluster: svc,
		generic: generic,
	}
}

func (h *clusterHandler) Create(w http.ResponseWriter, r *http.Request) {
	var c openapi.Cluster
	cfg := &handlers.HandlerConfig{
		Body: &c,
		Validators: []handlers.Validate{
			handlers.ValidateEmpty(&c, "Id", "id"),
		},
		Action: func() (interface{}, *errors.ServiceError) {
			ctx := r.Context()
			clusterModel := ConvertCluster(c)
			clusterModel, svcErr := h.cluster.Create(ctx, clusterModel)
			if svcErr != nil {
				return nil, svcErr
			}
			return PresentCluster(clusterModel), nil
		},
		ErrorHandler: handlers.HandleError,
	}
	handlers.Handle(w, r, cfg, http.StatusCreated)
}

func (h *clusterHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var patch openapi.ClusterPatchRequest
	cfg := &handlers.HandlerConfig{
		Body:       &patch,
		Validators: []handlers.Validate{},
		Action: func() (interface{}, *errors.ServiceError) {
			ctx := r.Context()
			clusterID := mux.Vars(r)["cluster_id"]
			if !validIDPattern.MatchString(clusterID) {
				return nil, errors.Validation("invalid cluster id")
			}
			found, svcErr := h.cluster.Get(ctx, clusterID)
			if svcErr != nil {
				return nil, svcErr
			}

			if patch.Name != nil {
				found.Name = *patch.Name
			}
			if patch.Description != nil {
				found.Description = patch.Description
			}
			if patch.ApiServerUrl != nil {
				found.ApiServerUrl = *patch.ApiServerUrl
			}
			if patch.CredentialId != nil {
				found.CredentialId = patch.CredentialId
			}
			if patch.Role != nil {
				if !validRoles[*patch.Role] {
					return nil, errors.Validation("invalid cluster role: must be gateway, workload, or hybrid")
				}
				found.Role = *patch.Role
			}
			if patch.Labels != nil {
				found.Labels = patch.Labels
			}
			if patch.Annotations != nil {
				found.Annotations = patch.Annotations
			}

			clusterModel, svcErr := h.cluster.Replace(ctx, found)
			if svcErr != nil {
				return nil, svcErr
			}
			return PresentCluster(clusterModel), nil
		},
		ErrorHandler: handlers.HandleError,
	}
	handlers.Handle(w, r, cfg, http.StatusOK)
}

func (h *clusterHandler) List(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			ctx := r.Context()
			listArgs := services.NewListArguments(r.URL.Query())

			var clustersList []Cluster
			paging, svcErr := h.generic.List(ctx, "id", listArgs, &clustersList)
			if svcErr != nil {
				return nil, svcErr
			}
			clusterList := openapi.ClusterList{
				Kind:  "ClusterList",
				Page:  int32(paging.Page),
				Size:  int32(paging.Size),
				Total: int32(paging.Total),
				Items: []openapi.Cluster{},
			}
			for _, c := range clustersList {
				clusterList.Items = append(clusterList.Items, PresentCluster(&c))
			}
			if listArgs.Fields != nil {
				filteredItems, fieldErr := presenters.SliceFilter(listArgs.Fields, clusterList.Items)
				if fieldErr != nil {
					return nil, fieldErr
				}
				return filteredItems, nil
			}
			return clusterList, nil
		},
	}
	handlers.HandleList(w, r, cfg)
}

func (h *clusterHandler) Get(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			clusterID := mux.Vars(r)["cluster_id"]
			if !validIDPattern.MatchString(clusterID) {
				return nil, errors.Validation("invalid cluster id")
			}
			ctx := r.Context()
			c, svcErr := h.cluster.Get(ctx, clusterID)
			if svcErr != nil {
				return nil, svcErr
			}
			return PresentCluster(c), nil
		},
	}
	handlers.HandleGet(w, r, cfg)
}

func (h *clusterHandler) Delete(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			clusterID := mux.Vars(r)["cluster_id"]
			if !validIDPattern.MatchString(clusterID) {
				return nil, errors.Validation("invalid cluster id")
			}
			ctx := r.Context()
			svcErr := h.cluster.Delete(ctx, clusterID)
			if svcErr != nil {
				return nil, svcErr
			}
			return nil, nil
		},
	}
	handlers.HandleDelete(w, r, cfg, http.StatusNoContent)
}

func (h *clusterHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			clusterID := mux.Vars(r)["cluster_id"]
			if !validIDPattern.MatchString(clusterID) {
				return nil, errors.Validation("invalid cluster id")
			}
			ctx := r.Context()
			c, svcErr := h.cluster.Get(ctx, clusterID)
			if svcErr != nil {
				return nil, svcErr
			}
			return PresentClusterStatus(c), nil
		},
	}
	handlers.HandleGet(w, r, cfg)
}

func (h *clusterHandler) Heartbeat(w http.ResponseWriter, r *http.Request) {
	var body map[string]interface{}
	cfg := &handlers.HandlerConfig{
		Body: &body,
		Action: func() (interface{}, *errors.ServiceError) {
			clusterID := mux.Vars(r)["cluster_id"]
			if !validIDPattern.MatchString(clusterID) {
				return nil, errors.Validation("invalid cluster id")
			}
			ctx := r.Context()
			c, svcErr := h.cluster.Get(ctx, clusterID)
			if svcErr != nil {
				return nil, svcErr
			}

			now := time.Now()
			c.LastHeartbeatAt = &now
			c, svcErr = h.cluster.Replace(ctx, c)
			if svcErr != nil {
				return nil, svcErr
			}
			return PresentClusterStatus(c), nil
		},
		ErrorHandler: handlers.HandleError,
	}
	handlers.Handle(w, r, cfg, http.StatusOK)
}
