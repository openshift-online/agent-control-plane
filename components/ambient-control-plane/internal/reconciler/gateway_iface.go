package reconciler

import (
	"context"

	"github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell"
	inferencepb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/inference/v1"
	pb "github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc/openshell/v1"
)

type gatewayClient interface {
	CreateSandbox(ctx context.Context, namespace string, req *pb.CreateSandboxRequest) (*pb.SandboxResponse, error)
	GetSandbox(ctx context.Context, namespace string, name string) (*pb.SandboxResponse, error)
	DeleteSandbox(ctx context.Context, namespace string, name string) error
	CreateProvider(ctx context.Context, namespace string, req *pb.CreateProviderRequest) (*pb.ProviderResponse, error)
	UpdateProvider(ctx context.Context, namespace string, req *pb.UpdateProviderRequest) (*pb.ProviderResponse, error)
	SetClusterInference(ctx context.Context, namespace string, req *inferencepb.SetClusterInferenceRequest) (*inferencepb.SetClusterInferenceResponse, error)
	ConfigureProviderRefresh(ctx context.Context, namespace string, req *pb.ConfigureProviderRefreshRequest) (*pb.ConfigureProviderRefreshResponse, error)
	RotateProviderCredential(ctx context.Context, namespace string, req *pb.RotateProviderCredentialRequest) (*pb.RotateProviderCredentialResponse, error)
	ExecSandbox(ctx context.Context, namespace string, req *pb.ExecSandboxRequest) (*openshell.ExecResult, error)
	ExecSandboxStreaming(ctx context.Context, namespace string, req *pb.ExecSandboxRequest) error
	UpdateConfig(ctx context.Context, namespace string, req *pb.UpdateConfigRequest) (*pb.UpdateConfigResponse, error)
	UploadPayloads(ctx context.Context, namespace string, sandboxID string, payloads []openshell.Payload) error
}
