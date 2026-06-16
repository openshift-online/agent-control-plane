package rbac

import (
	"context"

	"github.com/openshift-online/rh-trex-ai/pkg/auth"
	"github.com/openshift-online/rh-trex-ai/pkg/environments"
	"github.com/openshift-online/rh-trex-ai/pkg/registry"
	pkgserver "github.com/openshift-online/rh-trex-ai/pkg/server"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pkgrbac "github.com/ambient-code/platform/components/ambient-api-server/pkg/rbac"
)

type MiddlewareLocator func() auth.AuthorizationMiddleware

func Middleware(s *environments.Services) auth.AuthorizationMiddleware {
	if s == nil {
		return nil
	}
	if obj := s.GetService("RBACMiddleware"); obj != nil {
		locator := obj.(MiddlewareLocator)
		return locator()
	}
	return nil
}

// mwHolder is populated by the service factory and read by the gRPC
// interceptors. The factory runs during environment init (before any
// gRPC request), so the interceptors always see the initialized value.
var mwHolder *pkgrbac.DBAuthorizationMiddleware

func init() {
	registry.RegisterService("RBACMiddleware", func(env interface{}) interface{} {
		e := env.(*environments.Env)
		mw := pkgrbac.NewDBAuthorizationMiddleware(&e.Database.SessionFactory, e.Config.Auth.EnableAuthz)
		mwHolder = mw
		return MiddlewareLocator(func() auth.AuthorizationMiddleware {
			return mw
		})
	})

	pkgserver.RegisterPostAuthGRPCUnaryInterceptor(
		func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
			if mwHolder != nil {
				return mwHolder.GRPCUnaryInterceptor()(ctx, req, info, handler)
			}
			return nil, status.Error(codes.Unavailable, "authorization not initialized")
		},
	)
	pkgserver.RegisterPostAuthGRPCStreamInterceptor(
		func(srv interface{}, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
			if mwHolder != nil {
				return mwHolder.GRPCStreamInterceptor()(srv, ss, info, handler)
			}
			return status.Error(codes.Unavailable, "authorization not initialized")
		},
	)
}
