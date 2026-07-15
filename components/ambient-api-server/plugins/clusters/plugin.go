package clusters

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

type ServiceLocator func() ClusterService

func NewServiceLocator(env *environments.Env) ServiceLocator {
	return func() ClusterService {
		return NewClusterService(
			db.NewAdvisoryLockFactory(env.Database.SessionFactory),
			NewClusterDao(&env.Database.SessionFactory),
			events.Service(&env.Services),
			NewSessionCounter(&env.Database.SessionFactory),
		)
	}
}

func Service(s *environments.Services) ClusterService {
	if s == nil {
		return nil
	}
	if obj := s.GetService("Clusters"); obj != nil {
		locator := obj.(ServiceLocator)
		return locator()
	}
	return nil
}

func init() {
	registry.RegisterService("Clusters", func(env interface{}) interface{} {
		return NewServiceLocator(env.(*environments.Env))
	})

	pkgserver.RegisterRoutes("Clusters", func(apiV1Router *mux.Router, services pkgserver.ServicesInterface, authMiddleware environments.JWTMiddleware, authzMiddleware auth.AuthorizationMiddleware) {
		envServices := services.(*environments.Services)
		clusterHandler := NewClusterHandler(Service(envServices), generic.Service(envServices))

		if dbAuthz := pkgrbac.Middleware(envServices); dbAuthz != nil {
			authzMiddleware = dbAuthz
		}

		clustersRouter := apiV1Router.PathPrefix("/clusters").Subrouter()
		clustersRouter.HandleFunc("", clusterHandler.List).Methods(http.MethodGet)
		clustersRouter.HandleFunc("", clusterHandler.Create).Methods(http.MethodPost)
		clustersRouter.HandleFunc("/{cluster_id}", clusterHandler.Get).Methods(http.MethodGet)
		clustersRouter.HandleFunc("/{cluster_id}", clusterHandler.Patch).Methods(http.MethodPatch)
		clustersRouter.HandleFunc("/{cluster_id}", clusterHandler.Delete).Methods(http.MethodDelete)
		clustersRouter.HandleFunc("/{cluster_id}/status", clusterHandler.GetStatus).Methods(http.MethodGet)
		clustersRouter.HandleFunc("/{cluster_id}/heartbeat", clusterHandler.Heartbeat).Methods(http.MethodPost)
		clustersRouter.Use(authMiddleware.AuthenticateAccountJWT)
		clustersRouter.Use(authzMiddleware.AuthorizeApi)
	})

	pkgserver.RegisterController("Clusters", func(manager *controllers.KindControllerManager, services pkgserver.ServicesInterface) {
		clusterServices := Service(services.(*environments.Services))

		manager.Add(&controllers.ControllerConfig{
			Source: "Clusters",
			Handlers: map[api.EventType][]controllers.ControllerHandlerFunc{
				api.CreateEventType: {clusterServices.OnUpsert},
				api.UpdateEventType: {clusterServices.OnUpsert},
				api.DeleteEventType: {clusterServices.OnDelete},
			},
		})
	})

	presenters.RegisterPath(Cluster{}, "clusters")
	presenters.RegisterPath(&Cluster{}, "clusters")
	presenters.RegisterKind(Cluster{}, "Cluster")
	presenters.RegisterKind(&Cluster{}, "Cluster")

	db.RegisterMigration(migration())
}
