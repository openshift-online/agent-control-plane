package policies

import (
	"net/http"

	pkgrbac "github.com/ambient-code/platform/components/ambient-api-server/plugins/rbac"
	"github.com/gorilla/mux"
	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/api/presenters"
	"github.com/openshift-online/rh-trex-ai/pkg/auth"
	"github.com/openshift-online/rh-trex-ai/pkg/controllers"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
	"github.com/openshift-online/rh-trex-ai/pkg/environments"
	"github.com/openshift-online/rh-trex-ai/pkg/registry"
	pkgserver "github.com/openshift-online/rh-trex-ai/pkg/server"
	"github.com/openshift-online/rh-trex-ai/plugins/events"
	"github.com/openshift-online/rh-trex-ai/plugins/generic"
)

type ServiceLocator func() PolicyService

func NewServiceLocator(env *environments.Env) ServiceLocator {
	return func() PolicyService {
		return NewPolicyService(
			db.NewAdvisoryLockFactory(env.Database.SessionFactory),
			NewPolicyDao(&env.Database.SessionFactory),
			events.Service(&env.Services),
		)
	}
}

func Service(s *environments.Services) PolicyService {
	if s == nil {
		return nil
	}
	if obj := s.GetService("Policies"); obj != nil {
		locator := obj.(ServiceLocator)
		return locator()
	}
	return nil
}

func init() {
	registry.RegisterService("Policies", func(env interface{}) interface{} {
		return NewServiceLocator(env.(*environments.Env))
	})

	pkgserver.RegisterRoutes("policies", func(apiV1Router *mux.Router, services pkgserver.ServicesInterface, authMiddleware environments.JWTMiddleware, authzMiddleware auth.AuthorizationMiddleware) {
		envServices := services.(*environments.Services)

		if dbAuthz := pkgrbac.Middleware(envServices); dbAuthz != nil {
			authzMiddleware = dbAuthz
		}

		policySvc := Service(envServices)
		policyHandler := NewPolicyHandler(policySvc, generic.Service(envServices))

		projectsRouter := apiV1Router.PathPrefix("/projects").Subrouter()
		projectsRouter.HandleFunc("/{id}/policies", policyHandler.List).Methods(http.MethodGet)
		projectsRouter.HandleFunc("/{id}/policies", policyHandler.Create).Methods(http.MethodPost)
		projectsRouter.HandleFunc("/{id}/policies/{policy_id}", policyHandler.Get).Methods(http.MethodGet)
		projectsRouter.HandleFunc("/{id}/policies/{policy_id}", policyHandler.Patch).Methods(http.MethodPatch)
		projectsRouter.HandleFunc("/{id}/policies/{policy_id}", policyHandler.Delete).Methods(http.MethodDelete)

		projectsRouter.Use(authMiddleware.AuthenticateAccountJWT)
		projectsRouter.Use(authzMiddleware.AuthorizeApi)
	})

	pkgserver.RegisterController("Policies", func(manager *controllers.KindControllerManager, services pkgserver.ServicesInterface) {
		policySvc := Service(services.(*environments.Services))

		manager.Add(&controllers.ControllerConfig{
			Source: "Policies",
			Handlers: map[api.EventType][]controllers.ControllerHandlerFunc{
				api.CreateEventType: {policySvc.OnUpsert},
				api.UpdateEventType: {policySvc.OnUpsert},
				api.DeleteEventType: {policySvc.OnDelete},
			},
		})
	})

	presenters.RegisterPath(Policy{}, "policies")
	presenters.RegisterPath(&Policy{}, "policies")
	presenters.RegisterKind(Policy{}, "Policy")
	presenters.RegisterKind(&Policy{}, "Policy")

	db.RegisterMigration(migration())
}
