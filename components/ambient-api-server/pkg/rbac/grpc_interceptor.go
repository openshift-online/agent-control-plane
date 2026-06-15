package rbac

import (
	"context"
	"fmt"

	"github.com/golang/glog"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/openshift-online/rh-trex-ai/pkg/auth"

	"github.com/ambient-code/platform/components/ambient-api-server/pkg/middleware"
)

// GRPCUnaryInterceptor returns a unary interceptor that populates
// AuthResult in the context after JWT authentication has run.
func (m *DBAuthorizationMiddleware) GRPCUnaryInterceptor() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
		ctx, err := m.populateGRPCContext(ctx)
		if err != nil {
			return nil, status.Errorf(codes.Unavailable, "authorization service unavailable")
		}
		return handler(ctx, req)
	}
}

// GRPCStreamInterceptor returns a stream interceptor that populates
// AuthResult in the context after JWT authentication has run.
func (m *DBAuthorizationMiddleware) GRPCStreamInterceptor() grpc.StreamServerInterceptor {
	return func(srv interface{}, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		ctx, err := m.populateGRPCContext(ss.Context())
		if err != nil {
			return status.Errorf(codes.Unavailable, "authorization service unavailable")
		}
		return handler(srv, &wrappedStream{ServerStream: ss, ctx: ctx})
	}
}

func (m *DBAuthorizationMiddleware) populateGRPCContext(ctx context.Context) (context.Context, error) {
	if middleware.IsServiceCaller(ctx) {
		username := auth.GetUsernameFromContext(ctx)
		if username == "" {
			glog.Warningf("legacy service token used — consider migrating to OIDC service account authentication")
			return SetAuthResult(ctx, &AuthResult{
				Username:      "service-token",
				IsGlobalAdmin: true,
			}), nil
		}
		m.autoProvisionServiceAccount(ctx, username)
		enriched, err := m.PopulateAuthResult(ctx, username)
		if err != nil {
			glog.Warningf("gRPC RBAC: failed to populate auth for service account %s: %v", username, err)
			return ctx, fmt.Errorf("populate auth for service account: %w", err)
		}
		return enriched, nil
	}

	m.autoProvisionUser(ctx)

	username := auth.GetUsernameFromContext(ctx)
	if username == "" {
		return ctx, nil
	}

	if !m.enableAuthz {
		return SetAuthResult(ctx, &AuthResult{
			Username:      username,
			IsGlobalAdmin: true,
		}), nil
	}

	enriched, err := m.PopulateAuthResult(ctx, username)
	if err != nil {
		glog.Warningf("gRPC RBAC: failed to populate auth for %s: %v", username, err)
		return ctx, fmt.Errorf("populate auth: %w", err)
	}
	return enriched, nil
}

type wrappedStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (w *wrappedStream) Context() context.Context {
	return w.ctx
}
