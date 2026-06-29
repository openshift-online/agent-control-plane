package providers

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

type ServiceLocator func() ProviderService

func NewServiceLocator(env *environments.Env) ServiceLocator {
	return func() ProviderService {
		return NewProviderService(
			db.NewAdvisoryLockFactory(env.Database.SessionFactory),
			NewProviderDao(&env.Database.SessionFactory),
			events.Service(&env.Services),
		)
	}
}

func Service(s *environments.Services) ProviderService {
	if s == nil {
		return nil
	}
	if obj := s.GetService("Providers"); obj != nil {
		locator := obj.(ServiceLocator)
		return locator()
	}
	return nil
}

func init() {
	registry.RegisterService("Providers", func(env interface{}) interface{} {
		return NewServiceLocator(env.(*environments.Env))
	})

	pkgserver.RegisterRoutes("providers", func(apiV1Router *mux.Router, services pkgserver.ServicesInterface, authMiddleware environments.JWTMiddleware, authzMiddleware auth.AuthorizationMiddleware) {
		envServices := services.(*environments.Services)

		if dbAuthz := pkgrbac.Middleware(envServices); dbAuthz != nil {
			authzMiddleware = dbAuthz
		}

		providerSvc := Service(envServices)
		providerHandler := NewProviderHandler(providerSvc, generic.Service(envServices))

		projectsRouter := apiV1Router.PathPrefix("/projects").Subrouter()
		projectsRouter.HandleFunc("/{id}/providers", providerHandler.List).Methods(http.MethodGet)
		projectsRouter.HandleFunc("/{id}/providers", providerHandler.Create).Methods(http.MethodPost)
		projectsRouter.HandleFunc("/{id}/providers/{provider_id}", providerHandler.Get).Methods(http.MethodGet)
		projectsRouter.HandleFunc("/{id}/providers/{provider_id}", providerHandler.Patch).Methods(http.MethodPatch)
		projectsRouter.HandleFunc("/{id}/providers/{provider_id}", providerHandler.Delete).Methods(http.MethodDelete)

		projectsRouter.Use(authMiddleware.AuthenticateAccountJWT)
		projectsRouter.Use(authzMiddleware.AuthorizeApi)
	})

	pkgserver.RegisterController("Providers", func(manager *controllers.KindControllerManager, services pkgserver.ServicesInterface) {
		providerSvc := Service(services.(*environments.Services))

		manager.Add(&controllers.ControllerConfig{
			Source: "Providers",
			Handlers: map[api.EventType][]controllers.ControllerHandlerFunc{
				api.CreateEventType: {providerSvc.OnUpsert},
				api.UpdateEventType: {providerSvc.OnUpsert},
				api.DeleteEventType: {providerSvc.OnDelete},
			},
		})
	})

	presenters.RegisterPath(Provider{}, "providers")
	presenters.RegisterPath(&Provider{}, "providers")
	presenters.RegisterKind(Provider{}, "Provider")
	presenters.RegisterKind(&Provider{}, "Provider")

	db.RegisterMigration(migration())
}
