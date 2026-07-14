package gateways

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

type ServiceLocator func() GatewayService

func NewServiceLocator(env *environments.Env) ServiceLocator {
	return func() GatewayService {
		return NewGatewayService(
			db.NewAdvisoryLockFactory(env.Database.SessionFactory),
			NewGatewayDao(&env.Database.SessionFactory),
			events.Service(&env.Services),
		)
	}
}

func Service(s *environments.Services) GatewayService {
	if s == nil {
		return nil
	}
	if obj := s.GetService("Gateways"); obj != nil {
		locator := obj.(ServiceLocator)
		return locator()
	}
	return nil
}

func init() {
	registry.RegisterService("Gateways", func(env interface{}) interface{} {
		return NewServiceLocator(env.(*environments.Env))
	})

	pkgserver.RegisterRoutes("Gateways", func(apiV1Router *mux.Router, services pkgserver.ServicesInterface, authMiddleware environments.JWTMiddleware, authzMiddleware auth.AuthorizationMiddleware) {
		envServices := services.(*environments.Services)
		gatewayHandler := NewGatewayHandler(Service(envServices), generic.Service(envServices))

		if dbAuthz := pkgrbac.Middleware(envServices); dbAuthz != nil {
			authzMiddleware = dbAuthz
		}

		projectsRouter := apiV1Router.PathPrefix("/projects").Subrouter()
		projectsRouter.HandleFunc("/{id}/gateways", gatewayHandler.List).Methods(http.MethodGet)
		projectsRouter.HandleFunc("/{id}/gateways", gatewayHandler.Create).Methods(http.MethodPost)
		projectsRouter.HandleFunc("/{id}/gateways/{gateway_id}", gatewayHandler.Get).Methods(http.MethodGet)
		projectsRouter.HandleFunc("/{id}/gateways/{gateway_id}", gatewayHandler.Patch).Methods(http.MethodPatch)
		projectsRouter.HandleFunc("/{id}/gateways/{gateway_id}", gatewayHandler.Delete).Methods(http.MethodDelete)
		projectsRouter.Use(authMiddleware.AuthenticateAccountJWT)
		projectsRouter.Use(authzMiddleware.AuthorizeApi)
	})

	pkgserver.RegisterController("Gateways", func(manager *controllers.KindControllerManager, services pkgserver.ServicesInterface) {
		gatewayServices := Service(services.(*environments.Services))

		manager.Add(&controllers.ControllerConfig{
			Source: "Gateways",
			Handlers: map[api.EventType][]controllers.ControllerHandlerFunc{
				api.CreateEventType: {gatewayServices.OnUpsert},
				api.UpdateEventType: {gatewayServices.OnUpsert},
				api.DeleteEventType: {gatewayServices.OnDelete},
			},
		})
	})

	presenters.RegisterPath(Gateway{}, "gateways")
	presenters.RegisterPath(&Gateway{}, "gateways")
	presenters.RegisterKind(Gateway{}, "Gateway")
	presenters.RegisterKind(&Gateway{}, "Gateway")

	db.RegisterMigration(migration())
	db.RegisterMigration(migrationAddOidc())
}
