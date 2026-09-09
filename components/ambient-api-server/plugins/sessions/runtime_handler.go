package sessions

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
	"gateway_id":              runtimeapi.String,
	"gateway_workspace":       runtimeapi.String,
	"sandbox_id":              runtimeapi.String,
	"sandbox_name":            runtimeapi.String,
	"runtime_backend":         runtimeapi.String,
	"runner_generation":       runtimeapi.String,
	"gateway_endpoint":        runtimeapi.String,
	"gateway_credential_id":   runtimeapi.String,
	"runtime_status":          runtimeapi.String,
	"runtime_error":           runtimeapi.String,
	"phase":                   runtimeapi.String,
	"kube_cr_name":            runtimeapi.String,
	"kube_cr_uid":             runtimeapi.String,
	"kube_namespace":          runtimeapi.String,
	"sandbox_logs_snapshot":   runtimeapi.Snapshot,
	"sandbox_policy_snapshot": runtimeapi.Snapshot,
	"sdk_session_id":          runtimeapi.String,
	"reconciled_repos":        runtimeapi.String,
	"reconciled_workflow":     runtimeapi.String,
	"start_time":              runtimeapi.Timestamp,
	"completion_time":         runtimeapi.Timestamp,
}

func init() {
	pkgserver.RegisterRoutes("sessions-runtime", func(router *mux.Router, services pkgserver.ServicesInterface, authMiddleware environments.JWTMiddleware, _ auth.AuthorizationMiddleware) {
		envServices := services.(*environments.Services)
		handler := runtimeapi.Handler[Session, openapi.Session]{
			Store: runtimeapi.SQLStore[Session]{
				NewDB: func(ctx context.Context) *gorm.DB { return (*registeredSessionFactory).New(ctx) },
				AfterUpdate: func(ctx context.Context, row *Session) error {
					if row.DeletedAt.Valid {
						return nil
					}
					_, err := events.Service(envServices).Create(ctx, &api.Event{Source: "Sessions", SourceID: row.ID, EventType: api.UpdateEventType})
					if err != nil {
						return err
					}
					return nil
				},
			},
			Present: PresentSession, Fields: runtimeFields,
		}
		runtimeRouter := router.PathPrefix("/runtime/sessions").Subrouter()
		runtimeRouter.HandleFunc("", handler.List).Methods(http.MethodGet)
		runtimeRouter.HandleFunc("/{id}", handler.Patch).Methods(http.MethodPatch)
		runtimeRouter.Use(authMiddleware.AuthenticateAccountJWT)
		runtimeRouter.Use(runtimeapi.RequireService)
	})
}
