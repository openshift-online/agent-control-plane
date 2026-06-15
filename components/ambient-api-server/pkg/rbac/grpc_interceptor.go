package rbac

import (
	"context"

	"github.com/golang/glog"
	"google.golang.org/grpc"

	"github.com/openshift-online/rh-trex-ai/pkg/auth"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/middleware"
)

// GRPCUnaryInterceptor returns a unary interceptor that populates
// AuthResult in the context after JWT authentication has run.
func (m *DBAuthorizationMiddleware) GRPCUnaryInterceptor() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
		ctx = m.populateGRPCContext(ctx)
		return handler(ctx, req)
	}
}

// GRPCStreamInterceptor returns a stream interceptor that populates
// AuthResult in the context after JWT authentication has run.
func (m *DBAuthorizationMiddleware) GRPCStreamInterceptor() grpc.StreamServerInterceptor {
	return func(srv interface{}, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		ctx := m.populateGRPCContext(ss.Context())
		return handler(srv, &wrappedStream{ServerStream: ss, ctx: ctx})
	}
}

func (m *DBAuthorizationMiddleware) populateGRPCContext(ctx context.Context) context.Context {
	if middleware.IsServiceCaller(ctx) {
		username := auth.GetUsernameFromContext(ctx)
		if username == "" {
			return SetAuthResult(ctx, &AuthResult{
				Username:      "service-token",
				IsGlobalAdmin: true,
			})
		}
		m.autoProvisionServiceAccount(ctx, username)
		enriched, err := m.PopulateAuthResult(ctx, username)
		if err != nil {
			glog.Warningf("gRPC RBAC: failed to populate auth for service account %s: %v", username, err)
			return ctx
		}
		return enriched
	}

	m.autoProvisionUser(ctx)

	username := auth.GetUsernameFromContext(ctx)
	if username == "" {
		return ctx
	}

	if !m.enableAuthz {
		return SetAuthResult(ctx, &AuthResult{
			Username:      username,
			IsGlobalAdmin: true,
		})
	}

	enriched, err := m.PopulateAuthResult(ctx, username)
	if err != nil {
		glog.Warningf("gRPC RBAC: failed to populate auth for %s: %v", username, err)
		return ctx
	}
	return enriched
}

type wrappedStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (w *wrappedStream) Context() context.Context {
	return w.ctx
}
