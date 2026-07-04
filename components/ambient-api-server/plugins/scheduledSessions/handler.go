package scheduledSessions

import (
	"context"
	"net/http"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/api/openapi"
	"github.com/ambient-code/platform/components/ambient-api-server/pkg/gateway"
	"github.com/ambient-code/platform/components/ambient-api-server/pkg/rbac"
	"github.com/ambient-code/platform/components/ambient-api-server/plugins/sessions"
	"github.com/gorilla/mux"
	"github.com/openshift-online/rh-trex-ai/pkg/auth"
	"github.com/openshift-online/rh-trex-ai/pkg/errors"
	"github.com/openshift-online/rh-trex-ai/pkg/handlers"
)

type scheduledSessionHandler struct {
	svc        ScheduledSessionService
	sessionSvc sessions.SessionService
}

func NewScheduledSessionHandler(svc ScheduledSessionService, sessionSvc sessions.SessionService) *scheduledSessionHandler {
	return &scheduledSessionHandler{svc: svc, sessionSvc: sessionSvc}
}

// checkTierForMutation returns ServiceError if caller's tier is insufficient
// for schedule mutations. Returns nil otherwise.
func checkTierForMutation(ctx context.Context, projectID string) *errors.ServiceError {
	username := auth.GetUsernameFromContext(ctx)
	if username == "" {
		return errors.Unauthenticated("Username required for tier resolution")
	}

	tier := gateway.GetTierResolver().ResolveTier(ctx, username, projectID)

	if tier == gateway.TierNone {
		authResult := rbac.GetAuthResult(ctx)
		if rbac.IsProjectAuthorized(authResult, projectID) {
			return nil
		}
	}

	if tier == gateway.TierViewer || tier == gateway.TierNone {
		return errors.Forbidden("Schedule management requires Editor or Admin tier access")
	}
	return nil
}

// List — GET /api/ambient/v1/projects/{project_id}/scheduled-sessions
func (h *scheduledSessionHandler) List(w http.ResponseWriter, r *http.Request) {
	projectId := mux.Vars(r)["project_id"]
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			ctx := r.Context()
			list, err := h.svc.ListByProject(ctx, projectId)
			if err != nil {
				return nil, err
			}
			result := openapi.ScheduledSessionList{
				Kind:  "ScheduledSessionList",
				Page:  1,
				Size:  int32(len(list)),
				Total: int32(len(list)),
				Items: make([]openapi.ScheduledSession, 0, len(list)),
			}
			for _, ss := range list {
				result.Items = append(result.Items, PresentScheduledSession(ss))
			}
			return result, nil
		},
	}
	handlers.HandleList(w, r, cfg)
}

// Get — GET /api/ambient/v1/projects/{project_id}/scheduled-sessions/{id}
func (h *scheduledSessionHandler) Get(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			id := mux.Vars(r)["id"]
			ss, err := h.svc.Get(r.Context(), id)
			if err != nil {
				return nil, err
			}
			return PresentScheduledSession(ss), nil
		},
	}
	handlers.HandleGet(w, r, cfg)
}

// scheduledSessionCreateRequest is a lenient request body for Create.
// The generated openapi.ScheduledSession requires project_id in the JSON body,
// but the handler sources it from the URL path. This struct avoids that
// strict UnmarshalJSON validation while accepting all valid create fields.
type scheduledSessionCreateRequest struct {
	Id                *string `json:"id,omitempty"`
	Name              string  `json:"name"`
	Description       *string `json:"description,omitempty"`
	AgentId           *string `json:"agent_id,omitempty"`
	Schedule          string  `json:"schedule"`
	Timezone          *string `json:"timezone,omitempty"`
	Enabled           *bool   `json:"enabled,omitempty"`
	OverlapPolicy     *string `json:"overlap_policy,omitempty"`
	SessionPrompt     *string `json:"session_prompt,omitempty"`
	Timeout           *int32  `json:"timeout,omitempty"`
	InactivityTimeout *int32  `json:"inactivity_timeout,omitempty"`
	StopOnRunFinished *bool   `json:"stop_on_run_finished,omitempty"`
	RunnerType        *string `json:"runner_type,omitempty"`
}

// Create — POST /api/ambient/v1/projects/{project_id}/scheduled-sessions
func (h *scheduledSessionHandler) Create(w http.ResponseWriter, r *http.Request) {
	projectId := mux.Vars(r)["project_id"]

	// Gateway mode tier check
	if err := checkTierForMutation(r.Context(), projectId); err != nil {
		handlers.HandleError(r.Context(), w, err)
		return
	}

	var body scheduledSessionCreateRequest
	cfg := &handlers.HandlerConfig{
		Body: &body,
		Validators: []handlers.Validate{
			func() *errors.ServiceError {
				if body.Id != nil {
					return errors.Validation("id must not be supplied by client")
				}
				return nil
			},
			func() *errors.ServiceError {
				if body.Name == "" {
					return errors.Validation("name is required")
				}
				if body.Schedule == "" {
					return errors.Validation("schedule is required")
				}
				return nil
			},
		},
		Action: func() (interface{}, *errors.ServiceError) {
			ctx := r.Context()
			oaBody := openapi.ScheduledSession{
				Name:              body.Name,
				Description:       body.Description,
				ProjectId:         projectId,
				AgentId:           body.AgentId,
				Schedule:          body.Schedule,
				Timezone:          body.Timezone,
				Enabled:           body.Enabled,
				OverlapPolicy:     body.OverlapPolicy,
				SessionPrompt:     body.SessionPrompt,
				Timeout:           body.Timeout,
				InactivityTimeout: body.InactivityTimeout,
				StopOnRunFinished: body.StopOnRunFinished,
				RunnerType:        body.RunnerType,
			}
			ss := ConvertScheduledSession(oaBody)
			if username := auth.GetUsernameFromContext(ctx); username != "" {
				ss.CreatedByUserId = &username
			}
			created, err := h.svc.Create(ctx, ss)
			if err != nil {
				return nil, err
			}
			return PresentScheduledSession(created), nil
		},
		ErrorHandler: handlers.HandleError,
	}
	handlers.Handle(w, r, cfg, http.StatusCreated)
}

// Patch — PATCH /api/ambient/v1/projects/{project_id}/scheduled-sessions/{id}
func (h *scheduledSessionHandler) Patch(w http.ResponseWriter, r *http.Request) {
	projectId := mux.Vars(r)["project_id"]

	// Gateway mode tier check
	if err := checkTierForMutation(r.Context(), projectId); err != nil {
		handlers.HandleError(r.Context(), w, err)
		return
	}

	var body openapi.ScheduledSessionPatchRequest
	cfg := &handlers.HandlerConfig{
		Body:       &body,
		Validators: []handlers.Validate{},
		Action: func() (interface{}, *errors.ServiceError) {
			id := mux.Vars(r)["id"]
			patch := &ScheduledSessionPatch{
				Name:              body.Name,
				Description:       body.Description,
				AgentId:           body.AgentId,
				Schedule:          body.Schedule,
				Timezone:          body.Timezone,
				Enabled:           body.Enabled,
				OverlapPolicy:     body.OverlapPolicy,
				SessionPrompt:     body.SessionPrompt,
				Timeout:           body.Timeout,
				InactivityTimeout: body.InactivityTimeout,
				StopOnRunFinished: body.StopOnRunFinished,
				RunnerType:        body.RunnerType,
			}
			updated, err := h.svc.Patch(r.Context(), id, patch)
			if err != nil {
				return nil, err
			}
			return PresentScheduledSession(updated), nil
		},
		ErrorHandler: handlers.HandleError,
	}
	handlers.Handle(w, r, cfg, http.StatusOK)
}

// Delete — DELETE /api/ambient/v1/projects/{project_id}/scheduled-sessions/{id}
func (h *scheduledSessionHandler) Delete(w http.ResponseWriter, r *http.Request) {
	projectId := mux.Vars(r)["project_id"]

	// Gateway mode tier check
	if err := checkTierForMutation(r.Context(), projectId); err != nil {
		handlers.HandleError(r.Context(), w, err)
		return
	}

	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			id := mux.Vars(r)["id"]
			if err := h.svc.Delete(r.Context(), id); err != nil {
				return nil, err
			}
			return nil, nil
		},
	}
	handlers.HandleDelete(w, r, cfg, http.StatusNoContent)
}

// Suspend — POST /api/ambient/v1/projects/{project_id}/scheduled-sessions/{id}/suspend
func (h *scheduledSessionHandler) Suspend(w http.ResponseWriter, r *http.Request) {
	projectId := mux.Vars(r)["project_id"]

	// Gateway mode tier check
	if err := checkTierForMutation(r.Context(), projectId); err != nil {
		handlers.HandleError(r.Context(), w, err)
		return
	}

	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			id := mux.Vars(r)["id"]
			ss, err := h.svc.Suspend(r.Context(), id)
			if err != nil {
				return nil, err
			}
			return PresentScheduledSession(ss), nil
		},
	}
	handlers.HandleGet(w, r, cfg)
}

// Resume — POST /api/ambient/v1/projects/{project_id}/scheduled-sessions/{id}/resume
func (h *scheduledSessionHandler) Resume(w http.ResponseWriter, r *http.Request) {
	projectId := mux.Vars(r)["project_id"]

	// Gateway mode tier check
	if err := checkTierForMutation(r.Context(), projectId); err != nil {
		handlers.HandleError(r.Context(), w, err)
		return
	}

	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			id := mux.Vars(r)["id"]
			ss, err := h.svc.Resume(r.Context(), id)
			if err != nil {
				return nil, err
			}
			return PresentScheduledSession(ss), nil
		},
	}
	handlers.HandleGet(w, r, cfg)
}

// Trigger — POST /api/ambient/v1/projects/{project_id}/scheduled-sessions/{id}/trigger
func (h *scheduledSessionHandler) Trigger(w http.ResponseWriter, r *http.Request) {
	projectId := mux.Vars(r)["project_id"]

	// Gateway mode tier check
	if err := checkTierForMutation(r.Context(), projectId); err != nil {
		handlers.HandleError(r.Context(), w, err)
		return
	}

	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			id := mux.Vars(r)["id"]
			created, err := h.svc.Trigger(r.Context(), id)
			if err != nil {
				return nil, err
			}
			if created == nil {
				return map[string]string{"status": "skipped"}, nil
			}
			w.WriteHeader(http.StatusCreated)
			return sessions.PresentSession(created), nil
		},
	}
	handlers.HandleGet(w, r, cfg)
}

// Runs — GET /api/ambient/v1/projects/{project_id}/scheduled-sessions/{id}/runs
func (h *scheduledSessionHandler) Runs(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			id := mux.Vars(r)["id"]
			if _, svcErr := h.svc.Get(r.Context(), id); svcErr != nil {
				return nil, svcErr
			}
			runs, svcErr := h.sessionSvc.ByScheduledSessionID(r.Context(), id)
			if svcErr != nil {
				return nil, svcErr
			}
			items := make([]openapi.Session, 0, len(runs))
			for _, s := range runs {
				items = append(items, sessions.PresentSession(s))
			}
			return openapi.SessionList{
				Kind:  "SessionList",
				Page:  1,
				Size:  int32(len(runs)),
				Total: int32(len(runs)),
				Items: items,
			}, nil
		},
	}
	handlers.HandleList(w, r, cfg)
}
