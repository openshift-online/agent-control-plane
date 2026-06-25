package scheduledSessions

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/golang/glog"
	"github.com/gorilla/mux"
	"github.com/openshift-online/rh-trex-ai/pkg/auth"
	"github.com/openshift-online/rh-trex-ai/pkg/controllers"
	"github.com/openshift-online/rh-trex-ai/pkg/db"
	"github.com/openshift-online/rh-trex-ai/pkg/environments"
	"github.com/openshift-online/rh-trex-ai/pkg/registry"
	pkgserver "github.com/openshift-online/rh-trex-ai/pkg/server"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/clock"
	"github.com/ambient-code/platform/components/ambient-api-server/pkg/rbac"
	pkgrbac "github.com/ambient-code/platform/components/ambient-api-server/plugins/rbac"
	"github.com/ambient-code/platform/components/ambient-api-server/plugins/sessions"
)

func init() {
	pkgserver.RegisterRoutes("scheduledSessions", func(apiV1Router *mux.Router, services pkgserver.ServicesInterface, authMiddleware environments.JWTMiddleware, authzMiddleware auth.AuthorizationMiddleware) {
		envServices := services.(*environments.Services)

		var svc ScheduledSessionService
		if obj := envServices.GetService("ScheduledSessionsSQL"); obj != nil {
			svc = obj.(func() ScheduledSessionService)()
		} else {
			svc = NewInMemoryService()
		}

		if dbAuthz := pkgrbac.Middleware(envServices); dbAuthz != nil {
			authzMiddleware = dbAuthz
		}

		sessionSvc := sessions.Service(envServices)
		h := NewScheduledSessionHandler(svc, sessionSvc)

		projectRouter := apiV1Router.PathPrefix("/projects/{project_id}").Subrouter()
		schedRouter := projectRouter.PathPrefix("/scheduled-sessions").Subrouter()
		schedRouter.HandleFunc("", h.List).Methods(http.MethodGet)
		schedRouter.HandleFunc("", h.Create).Methods(http.MethodPost)
		schedRouter.HandleFunc("/{id}", h.Get).Methods(http.MethodGet)
		schedRouter.HandleFunc("/{id}", h.Patch).Methods(http.MethodPatch)
		schedRouter.HandleFunc("/{id}", h.Delete).Methods(http.MethodDelete)
		schedRouter.HandleFunc("/{id}/suspend", h.Suspend).Methods(http.MethodPost)
		schedRouter.HandleFunc("/{id}/resume", h.Resume).Methods(http.MethodPost)
		schedRouter.HandleFunc("/{id}/trigger", h.Trigger).Methods(http.MethodPost)
		schedRouter.HandleFunc("/{id}/runs", h.Runs).Methods(http.MethodGet)
		schedRouter.Use(authMiddleware.AuthenticateAccountJWT)
		schedRouter.Use(authzMiddleware.AuthorizeApi)
	})

	// SQL-backed service registered for production.
	// In unit_testing / dev the in-memory fallback in RegisterRoutes is used.
	registry.RegisterService("ScheduledSessionsSQL", func(env interface{}) interface{} {
		e := env.(*environments.Env)
		return func() ScheduledSessionService {
			return NewScheduledSessionService(
				NewScheduledSessionDao(&e.Database.SessionFactory),
				clock.RealClock{},
				sessions.Service(&e.Services),
				sessions.MessageSvc(&e.Services),
				rbac.NewEvaluator(&e.Database.SessionFactory),
			)
		}
	})

	pkgserver.RegisterController("ScheduledSessionScheduler", func(_ *controllers.KindControllerManager, services pkgserver.ServicesInterface) {
		envServices := services.(*environments.Services)

		var svc ScheduledSessionService
		if obj := envServices.GetService("ScheduledSessionsSQL"); obj != nil {
			svc = obj.(func() ScheduledSessionService)()
		}
		if svc == nil {
			return
		}
		sqlSvc, ok := svc.(*sqlScheduledSessionService)
		if !ok {
			return
		}

		env := environments.Environment()
		dao := NewScheduledSessionDao(&env.Database.SessionFactory)
		lockFactory := db.NewAdvisoryLockFactory(env.Database.SessionFactory)
		clk := clock.RealClock{}

		scheduler := NewScheduler(sqlSvc, dao, lockFactory, clk, SchedulerConfig{})
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		_ = stop
		scheduler.Start(ctx)
		glog.Info("Scheduled session scheduler started")
	})

	db.RegisterMigration(migration())
	db.RegisterMigration(indexMigration())
	db.RegisterMigration(executionFieldsMigration())
	db.RegisterMigration(schedulerFieldsMigration())
	db.RegisterMigration(backfillNextRunAtMigration())
}
