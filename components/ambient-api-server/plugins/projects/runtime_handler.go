package projects

import (
	"context"
	"net/http"

	"github.com/gorilla/mux"
	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/pkg/api/openapi"
	"github.com/openshift-online/agent-control-plane/components/ambient-api-server/pkg/runtimeapi"
	"github.com/openshift-online/rh-trex-ai/pkg/api"
	"github.com/openshift-online/rh-trex-ai/pkg/auth"
	"github.com/openshift-online/rh-trex-ai/pkg/environments"
	pkgserver "github.com/openshift-online/rh-trex-ai/pkg/server"
	"github.com/openshift-online/rh-trex-ai/plugins/events"
	"gorm.io/gorm"
)

var runtimeFields = map[string]runtimeapi.FieldKind{
	"runtime_backend":            runtimeapi.String,
	"gateway_id":                 runtimeapi.String,
	"gateway_instance_id":        runtimeapi.String,
	"gateway_endpoint":           runtimeapi.String,
	"gateway_status":             runtimeapi.String,
	"gateway_error":              runtimeapi.String,
	"gateway_credential_id":      runtimeapi.String,
	"gateway_account_id":         runtimeapi.String,
	"gateway_account_expires_at": runtimeapi.String,
	"gateway_external_reference": runtimeapi.String,
}

func init() {
	pkgserver.RegisterRoutes("projects-runtime", func(router *mux.Router, services pkgserver.ServicesInterface, authMiddleware environments.JWTMiddleware, _ auth.AuthorizationMiddleware) {
		envServices := services.(*environments.Services)
		handler := runtimeapi.Handler[Project, openapi.Project]{
			Store: runtimeapi.SQLStore[Project]{
				NewDB: func(ctx context.Context) *gorm.DB { return (*registeredSessionFactory).New(ctx) },
				AfterUpdate: func(ctx context.Context, row *Project) error {
					if row.DeletedAt.Valid {
						return nil
					}
					_, err := events.Service(envServices).Create(ctx, &api.Event{Source: "Projects", SourceID: row.ID, EventType: api.UpdateEventType})
					if err != nil {
						return err
					}
					return nil
				},
			},
			Present: PresentProject, Fields: runtimeFields,
		}
		runtimeRouter := router.PathPrefix("/runtime/projects").Subrouter()
		runtimeRouter.HandleFunc("", handler.List).Methods(http.MethodGet)
		runtimeRouter.HandleFunc("/{id}", handler.Patch).Methods(http.MethodPatch)
		runtimeRouter.Use(authMiddleware.AuthenticateAccountJWT)
		runtimeRouter.Use(runtimeapi.RequireService)
	})
}
