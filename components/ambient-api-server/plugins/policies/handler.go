package policies

import (
	"encoding/json"
	"net/http"

	"github.com/gorilla/mux"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/api/openapi"
	"github.com/openshift-online/rh-trex-ai/pkg/errors"
	"github.com/openshift-online/rh-trex-ai/pkg/handlers"
	"github.com/openshift-online/rh-trex-ai/pkg/services"
)

type policyHandler struct {
	policy  PolicyService
	generic services.GenericService
}

func NewPolicyHandler(policy PolicyService, generic services.GenericService) *policyHandler {
	return &policyHandler{
		policy:  policy,
		generic: generic,
	}
}

func (h policyHandler) Create(w http.ResponseWriter, r *http.Request) {

	var policy openapi.Policy
	cfg := &handlers.HandlerConfig{
		Body: &policy,
		Validators: []handlers.Validate{
			handlers.ValidateEmpty(&policy, "Id", "id"),
		},
		Action: func() (interface{}, *errors.ServiceError) {
			ctx := r.Context()
			projectID := mux.Vars(r)["id"]
			model := ConvertPolicy(policy)
			model.ProjectId = projectID
			model, err := h.policy.Create(ctx, model)
			if err != nil {
				return nil, err
			}
			return PresentPolicy(model), nil
		},
		ErrorHandler: handlers.HandleError,
	}
	handlers.Handle(w, r, cfg, http.StatusCreated)
}

func (h policyHandler) List(w http.ResponseWriter, r *http.Request) {
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

			var policies []Policy
			paging, err := h.generic.List(ctx, "id", listArgs, &policies)
			if err != nil {
				return nil, err
			}

			policyList := openapi.PolicyList{
				Kind:  "PolicyList",
				Page:  int32(paging.Page),
				Size:  int32(paging.Size),
				Total: int32(paging.Total),
				Items: []openapi.Policy{},
			}

			for _, p := range policies {
				policyList.Items = append(policyList.Items, PresentPolicy(&p))
			}
			return policyList, nil
		},
	}
	handlers.HandleList(w, r, cfg)
}

func (h policyHandler) Get(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			projectID := mux.Vars(r)["id"]
			id := mux.Vars(r)["policy_id"]
			ctx := r.Context()
			policy, err := h.policy.Get(ctx, id)
			if err != nil {
				return nil, err
			}
			if policy.ProjectId != projectID {
				return nil, errors.Forbidden("policy does not belong to this project")
			}
			return PresentPolicy(policy), nil
		},
	}
	handlers.HandleGet(w, r, cfg)
}

func (h policyHandler) Patch(w http.ResponseWriter, r *http.Request) {

	var patch openapi.PolicyPatchRequest
	cfg := &handlers.HandlerConfig{
		Body:       &patch,
		Validators: []handlers.Validate{},
		Action: func() (interface{}, *errors.ServiceError) {
			ctx := r.Context()
			projectID := mux.Vars(r)["id"]
			id := mux.Vars(r)["policy_id"]
			found, err := h.policy.Get(ctx, id)
			if err != nil {
				return nil, err
			}
			if found.ProjectId != projectID {
				return nil, errors.Forbidden("policy does not belong to this project")
			}

			if patch.Name != nil {
				found.Name = *patch.Name
			}
			if patch.Namespace != nil {
				found.Namespace = patch.Namespace
			}
			if patch.Spec != nil {
				raw, mErr := json.Marshal(patch.Spec)
				if mErr != nil {
					return nil, errors.Validation("invalid spec: %v", mErr)
				}
				s := string(raw)
				found.Spec = &s
			}
			if patch.Labels != nil {
				found.Labels = patch.Labels
			}
			if patch.Annotations != nil {
				found.Annotations = patch.Annotations
			}

			model, err := h.policy.Replace(ctx, found)
			if err != nil {
				return nil, err
			}
			return PresentPolicy(model), nil
		},
		ErrorHandler: handlers.HandleError,
	}
	handlers.Handle(w, r, cfg, http.StatusOK)
}

func (h policyHandler) Delete(w http.ResponseWriter, r *http.Request) {

	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			projectID := mux.Vars(r)["id"]
			id := mux.Vars(r)["policy_id"]
			ctx := r.Context()
			policy, getErr := h.policy.Get(ctx, id)
			if getErr != nil {
				return nil, getErr
			}
			if policy.ProjectId != projectID {
				return nil, errors.Forbidden("policy does not belong to this project")
			}
			err := h.policy.Delete(ctx, id)
			if err != nil {
				return nil, err
			}
			return nil, nil
		},
	}
	handlers.HandleDelete(w, r, cfg, http.StatusNoContent)
}
