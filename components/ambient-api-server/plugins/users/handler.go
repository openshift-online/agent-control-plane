package users

import (
	"net/http"

	"github.com/gorilla/mux"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/api/openapi"
	pkgrbac "github.com/ambient-code/platform/components/ambient-api-server/pkg/rbac"
	"github.com/openshift-online/rh-trex-ai/pkg/api/presenters"
	"github.com/openshift-online/rh-trex-ai/pkg/auth"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
	"github.com/openshift-online/rh-trex-ai/pkg/errors"
	"github.com/openshift-online/rh-trex-ai/pkg/handlers"
	"github.com/openshift-online/rh-trex-ai/pkg/services"
)

var _ handlers.RestHandler = userHandler{}

type userHandler struct {
	user           UserService
	generic        services.GenericService
	sessionFactory *db.SessionFactory
}

func NewUserHandler(user UserService, generic services.GenericService, sessionFactory *db.SessionFactory) *userHandler {
	return &userHandler{
		user:           user,
		generic:        generic,
		sessionFactory: sessionFactory,
	}
}

func (h userHandler) Create(w http.ResponseWriter, r *http.Request) {
	var user openapi.User
	cfg := &handlers.HandlerConfig{
		Body: &user,
		Validators: []handlers.Validate{
			handlers.ValidateEmpty(&user, "Id", "id"),
		},
		Action: func() (interface{}, *errors.ServiceError) {
			ctx := r.Context()
			userModel := ConvertUser(user)
			userModel, err := h.user.Create(ctx, userModel)
			if err != nil {
				return nil, err
			}
			return PresentUser(userModel), nil
		},
		ErrorHandler: handlers.HandleError,
	}

	handlers.Handle(w, r, cfg, http.StatusCreated)
}

func (h userHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var patch openapi.UserPatchRequest

	cfg := &handlers.HandlerConfig{
		Body:       &patch,
		Validators: []handlers.Validate{},
		Action: func() (interface{}, *errors.ServiceError) {
			ctx := r.Context()
			id := mux.Vars(r)["id"]
			found, err := h.user.Get(ctx, id)
			if err != nil {
				return nil, err
			}

			if patch.Username != nil {
				found.Username = *patch.Username
			}
			if patch.Name != nil {
				found.Name = *patch.Name
			}
			if patch.Email != nil {
				found.Email = patch.Email
			}

			userModel, err := h.user.Replace(ctx, found)
			if err != nil {
				return nil, err
			}
			return PresentUser(userModel), nil
		},
		ErrorHandler: handlers.HandleError,
	}

	handlers.Handle(w, r, cfg, http.StatusOK)
}

func (h userHandler) List(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			ctx := r.Context()

			listArgs := services.NewListArguments(r.URL.Query())

			// RBAC: non-admin callers can only see their own user record,
			// unless they have a project-scoped binding at editor level or
			// above — in that case, allow TSL search but restrict response
			// fields to id,username,name.
			authResult := pkgrbac.GetAuthResult(ctx)
			restrictFields := false
			if authResult != nil && !authResult.IsGlobalAdmin {
				username := auth.GetUsernameFromContext(ctx)
				hasEditorBinding := false

				if h.sessionFactory != nil && username != "" {
					var callerProjectRoles []string
					g := (*h.sessionFactory).New(ctx)
					if dbErr := g.Table("role_bindings rb").
						Select("r.name").
						Joins("JOIN roles r ON r.id = rb.role_id").
						Where("rb.user_id = ? AND rb.scope = 'project' AND r.deleted_at IS NULL AND rb.deleted_at IS NULL", username).
						Scan(&callerProjectRoles).Error; dbErr == nil {
						callerLevel := pkgrbac.HighestLevel(callerProjectRoles)
						// Level 2 = project:editor, level 1 = project:owner, level 0 = platform:admin
						if callerLevel <= 2 && callerLevel != 999 {
							hasEditorBinding = true
						}
					}
				}

				if hasEditorBinding {
					// Allow search but enforce field restriction
					allowedFields := map[string]bool{"id": true, "username": true, "name": true}
					if listArgs.Fields != nil {
						for _, f := range listArgs.Fields {
							if !allowedFields[f] {
								return nil, errors.Forbidden("field not allowed for user search")
							}
						}
					} else {
						// Force field restriction when caller doesn't specify fields
						listArgs.Fields = []string{"id", "username", "name"}
					}
					restrictFields = true

					// Cap results at 10 for autocomplete search
					if listArgs.Size > 10 {
						listArgs.Size = 10
					}
				} else if username != "" {
					// Fall back to own record only
					scopeFilter, err := pkgrbac.TSLEqualUsername("username", username)
					if err != nil {
						return nil, errors.Forbidden("invalid username")
					}
					pkgrbac.AppendTSLFilter(listArgs, scopeFilter)
				}
			}
			_ = restrictFields

			var users []User
			paging, err := h.generic.List(ctx, "id", listArgs, &users)
			if err != nil {
				return nil, err
			}
			userList := openapi.UserList{
				Kind:  "UserList",
				Page:  int32(paging.Page),
				Size:  int32(paging.Size),
				Total: int32(paging.Total),
				Items: []openapi.User{},
			}

			for _, user := range users {
				converted := PresentUser(&user)
				userList.Items = append(userList.Items, converted)
			}
			if listArgs.Fields != nil {
				filteredItems, err := presenters.SliceFilter(listArgs.Fields, userList)
				if err != nil {
					return nil, err
				}
				return filteredItems, nil
			}
			return userList, nil
		},
	}

	handlers.HandleList(w, r, cfg)
}

func (h userHandler) Get(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			id := mux.Vars(r)["id"]
			ctx := r.Context()
			user, err := h.user.Get(ctx, id)
			if err != nil {
				return nil, err
			}

			return PresentUser(user), nil
		},
	}

	handlers.HandleGet(w, r, cfg)
}

func (h userHandler) Delete(w http.ResponseWriter, r *http.Request) {
	cfg := &handlers.HandlerConfig{
		Action: func() (interface{}, *errors.ServiceError) {
			id := mux.Vars(r)["id"]
			ctx := r.Context()
			err := h.user.Delete(ctx, id)
			if err != nil {
				return nil, err
			}
			return nil, nil
		},
	}
	handlers.HandleDelete(w, r, cfg, http.StatusNoContent)
}
