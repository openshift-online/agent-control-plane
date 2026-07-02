package applications

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

type ServiceLocator func() ApplicationService

func NewServiceLocator(env *environments.Env) ServiceLocator {
	return func() ApplicationService {
		return NewApplicationService(
			db.NewAdvisoryLockFactory(env.Database.SessionFactory),
			NewApplicationDao(&env.Database.SessionFactory),
			events.Service(&env.Services),
		)
	}
}

func Service(s *environments.Services) ApplicationService {
	if s == nil {
		return nil
	}
	if obj := s.GetService("Applications"); obj != nil {
		locator := obj.(ServiceLocator)
		return locator()
	}
	return nil
}

func init() {
	registry.RegisterService("Applications", func(env interface{}) interface{} {
		return NewServiceLocator(env.(*environments.Env))
	})

	pkgserver.RegisterRoutes("applications", func(apiV1Router *mux.Router, services pkgserver.ServicesInterface, authMiddleware environments.JWTMiddleware, authzMiddleware auth.AuthorizationMiddleware) {
		envServices := services.(*environments.Services)
		if dbAuthz := pkgrbac.Middleware(envServices); dbAuthz != nil {
			authzMiddleware = dbAuthz
		}
		applicationHandler := NewApplicationHandler(Service(envServices), generic.Service(envServices))

		appsRouter := apiV1Router.PathPrefix("/applications").Subrouter()
		appsRouter.HandleFunc("", applicationHandler.List).Methods(http.MethodGet)
		appsRouter.HandleFunc("", applicationHandler.Create).Methods(http.MethodPost)
		appsRouter.HandleFunc("/{app_id}", applicationHandler.Get).Methods(http.MethodGet)
		appsRouter.HandleFunc("/{app_id}", applicationHandler.Patch).Methods(http.MethodPatch)
		appsRouter.HandleFunc("/{app_id}", applicationHandler.Delete).Methods(http.MethodDelete)
		appsRouter.HandleFunc("/{app_id}/sync", applicationHandler.Sync).Methods(http.MethodPost)
		appsRouter.HandleFunc("/{app_id}/refresh", applicationHandler.Refresh).Methods(http.MethodPost)
		appsRouter.Use(authMiddleware.AuthenticateAccountJWT)
		appsRouter.Use(authzMiddleware.AuthorizeApi)
	})

	pkgserver.RegisterController("Applications", func(manager *controllers.KindControllerManager, services pkgserver.ServicesInterface) {
		applicationService := Service(services.(*environments.Services))

		manager.Add(&controllers.ControllerConfig{
			Source: "Applications",
			Handlers: map[api.EventType][]controllers.ControllerHandlerFunc{
				api.CreateEventType: {applicationService.OnUpsert},
				api.UpdateEventType: {applicationService.OnUpsert},
				api.DeleteEventType: {applicationService.OnDelete},
			},
		})
	})

	presenters.RegisterPath(Application{}, "applications")
	presenters.RegisterPath(&Application{}, "applications")
	presenters.RegisterKind(Application{}, "Application")
	presenters.RegisterKind(&Application{}, "Application")

	db.RegisterMigration(migration())
	db.RegisterMigration(gitopsRolesMigration())
}
